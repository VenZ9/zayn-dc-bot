'use strict';

/**
 * Ban / tempban / unban.
 *
 * Grouped in one file because they share the target-resolution and
 * confirmation helpers.
 */

const { PermissionFlagsBits } = require('discord.js');
const { defineCommand } = require('../../core/command');
const { PERMS } = require('../../lib/permissions');
const helpers = require('../../lib/helpers');
const embeds = require('../../lib/embeds');
const service = require('./moderation-service');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the target of a moderation command into a User.
 *
 * On slash commands this is a User (or GuildMember when present); on prefix
 * commands the runner has already resolved a member or left a raw string.
 * Handles all three so both paths behave identically.
 *
 * @param {import('../../core/context').Context} ctx
 * @param {string} [name]
 * @returns {Promise<{ user: any|null, member: any|null, error: string|null }>}
 */
async function resolveTarget(ctx, name = 'user') {
  const raw = ctx.get(name);

  if (!raw) {
    return { user: null, member: null, error: 'You did not specify a user.' };
  }

  // Already resolved by the prefix runner, or a slash option unwrapped to a
  // member / user object.
  if (raw && typeof raw === 'object' && raw.id) {
    const member = raw.user ? raw : (ctx.guild?.members.cache.get(raw.id) ?? null);
    const user = raw.user ?? raw;
    return { user, member, error: null };
  }

  // A raw string from the prefix path that failed to resolve to a member.
  const id = helpers.extractId(String(raw));
  if (id) {
    const user = await ctx.client.users.fetch(id).catch(() => null);
    if (user) {
      const member = ctx.guild?.members.cache.get(id) ?? null;
      return { user, member, error: null };
    }
  }

  return { user: null, member: null, error: `I could not find a user matching \`${helpers.truncate(String(raw), 50)}\`.` };
}

/** Reject self-targeting, which is almost always a mistake. */
function guardSelf(ctx, user) {
  if (user.id === ctx.user.id) return 'You cannot use this on yourself.';
  if (user.id === ctx.client.user.id) return 'I cannot use this on myself.';
  return null;
}

// ---------------------------------------------------------------------------
// /ban
// ---------------------------------------------------------------------------

const ban = defineCommand({
  name: 'ban',
  description: 'Ban a member from the server',
  module: 'moderation',
  node: 'moderation.ban',
  userPerms: PERMS.ban,
  botPerms: [PermissionFlagsBits.BanMembers],
  aliases: ['b'],
  usage: '<user> [reason] [delete_days]',
  cooldown: 3,
  examples: ['/ban @spammer raiding', '.ban 123456789012345678 spam'],
  args: [
    { name: 'user', type: 'user', required: true, description: 'The member to ban' },
    { name: 'reason', type: 'string', required: false, description: 'Why they are being banned', maxLength: 500 },
    { name: 'delete_days', type: 'integer', required: false, description: 'Delete their messages from the last N days (0-7)', min: 0, max: 7 },
  ],

  async run(ctx) {
    const { user, member, error } = await resolveTarget(ctx);
    if (error) return ctx.error('No target', error);

    const selfGuard = guardSelf(ctx, user);
    if (selfGuard) return ctx.error('Not allowed', selfGuard);

    // Hierarchy check when the target is still a member.
    if (member) {
      const hierarchy = require('../../lib/permissions').checkHierarchy(ctx.member, member, ctx.guild);
      if (!hierarchy.ok) return ctx.error('Cannot ban', hierarchy.reason);
    }

    const reason = ctx.get('reason') || 'No reason provided';
    const deleteDays = helpers.clamp(Number(ctx.get('delete_days')) || 0, 0, 7);
    const deleteSeconds = deleteDays * 86400;

    // Destructive: confirm before acting.
    const confirmed = await ctx.confirm({
      title: `Ban ${user.tag ?? user.username}?`,
      body: [
        `**Target:** ${user.tag ?? user.username} (<@${user.id}>)`,
        `**Reason:** ${reason}`,
        deleteDays > 0 ? `**Messages deleted:** last ${deleteDays} day(s)` : null,
        '',
        'This will remove them from the server. They can only return with an unban.',
      ].filter(Boolean).join('\n'),
      confirmLabel: 'Ban',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;

    const result = await service.ban(ctx.guild, user, ctx.user, {
      reason,
      deleteMessageSeconds: deleteSeconds,
      source: ctx.kind,
    });

    if (!result.ok) return ctx.error('Ban failed', result.error);

    const embed = embeds.success(
      'Member banned',
      `${user.tag ?? user.username} (<@${user.id}>) has been banned.`,
    );
    embed.addFields(
      { name: 'Case', value: `#${result.case?.case_number ?? '?'}`, inline: true },
      { name: 'Reason', value: helpers.truncate(reason, 500), inline: true },
    );

    await ctx.reply({ embeds: [embed] });

    // Best-effort DM so the member knows why, if they share a server.
    await user.send({
      embeds: [embeds.embed({
        color: 0xed4245,
        title: `You were banned from ${ctx.guild.name}`,
        description: `**Reason:** ${reason}`,
        keepFooter: false,
      })],
    }).catch(() => {});
  },
});

// ---------------------------------------------------------------------------
// /tempban
// ---------------------------------------------------------------------------

const tempban = defineCommand({
  name: 'tempban',
  description: 'Temporarily ban a member; the ban lifts automatically',
  module: 'moderation',
  node: 'moderation.tempban',
  userPerms: PERMS.ban,
  botPerms: [PermissionFlagsBits.BanMembers],
  usage: '<user> <duration> [reason]',
  cooldown: 3,
  examples: ['/tempban @spammer 7d cooling off'],
  args: [
    { name: 'user', type: 'user', required: true, description: 'The member to ban' },
    { name: 'duration', type: 'string', required: true, description: 'How long, e.g. 1h, 7d, 2w' },
    { name: 'reason', type: 'string', required: false, description: 'Why they are being banned', maxLength: 500 },
  ],

  async run(ctx) {
    const { user, member, error } = await resolveTarget(ctx);
    if (error) return ctx.error('No target', error);

    const selfGuard = guardSelf(ctx, user);
    if (selfGuard) return ctx.error('Not allowed', selfGuard);

    if (member) {
      const hierarchy = require('../../lib/permissions').checkHierarchy(ctx.member, member, ctx.guild);
      if (!hierarchy.ok) return ctx.error('Cannot ban', hierarchy.reason);
    }

    const duration = helpers.parseDuration(ctx.get('duration'));
    if (!duration) {
      return ctx.error(
        'Invalid duration',
        'Use a format like `30m`, `12h`, `7d` or `2w`.',
      );
    }

    if (duration > 365 * 86400) {
      return ctx.error('Duration too long', 'Temporary bans are limited to one year.');
    }

    const reason = ctx.get('reason') || 'No reason provided';

    const confirmed = await ctx.confirm({
      title: `Temporarily ban ${user.tag ?? user.username}?`,
      body: [
        `**Target:** <@${user.id}>`,
        `**Duration:** ${helpers.formatDuration(duration)}`,
        `**Lifts:** ${helpers.timestamp(new Date(Date.now() + duration * 1000), 'R')}`,
        `**Reason:** ${reason}`,
      ].join('\n'),
      confirmLabel: 'Tempban',
    });
    if (!confirmed) return;

    const result = await service.ban(ctx.guild, user, ctx.user, {
      reason,
      duration,
      source: ctx.kind,
    });

    if (!result.ok) return ctx.error('Tempban failed', result.error);

    const embed = embeds.success(
      'Member temporarily banned',
      `<@${user.id}> has been banned and will be unbanned ${helpers.timestamp(new Date(Date.now() + duration * 1000), 'R')}.`,
    );
    embed.addFields(
      { name: 'Case', value: `#${result.case?.case_number ?? '?'}`, inline: true },
      { name: 'Duration', value: helpers.formatDuration(duration), inline: true },
    );
    await ctx.reply({ embeds: [embed] });
  },
});

// ---------------------------------------------------------------------------
// /unban
// ---------------------------------------------------------------------------

const unban = defineCommand({
  name: 'unban',
  description: 'Remove a ban so a user can rejoin',
  module: 'moderation',
  node: 'moderation.unban',
  userPerms: PERMS.ban,
  botPerms: [PermissionFlagsBits.BanMembers],
  usage: '<user_id_or_tag> [reason]',
  cooldown: 3,
  examples: ['/unban 123456789012345678 appeal accepted'],
  args: [
    { name: 'user', type: 'string', required: true, description: 'The user ID or username to unban' },
    { name: 'reason', type: 'string', required: false, description: 'Why the ban is being lifted', maxLength: 500 },
  ],

  async run(ctx) {
    const raw = String(ctx.get('user') ?? '').trim();
    const id = helpers.extractId(raw);

    // Bans are not members, so they must be looked up against the ban list.
    const bans = await ctx.guild.bans.fetch().catch(() => null);
    if (!bans) {
      return ctx.error('Cannot read bans', 'I need the **Ban Members** permission to list bans.');
    }

    let entry = null;
    if (id) {
      entry = bans.get(id) ?? null;
    } else {
      const lowered = raw.toLowerCase().replace(/^@/, '');
      entry = bans.find((ban) =>
        ban.user.username.toLowerCase() === lowered
        || ban.user.tag?.toLowerCase() === lowered) ?? null;

      // Fall back to a starts-with match.
      if (!entry) {
        entry = bans.find((ban) => ban.user.username.toLowerCase().startsWith(lowered)) ?? null;
      }
    }

    if (!entry) {
      return ctx.error(
        'Not banned',
        `I could not find a ban matching \`${helpers.truncate(raw, 60)}\`.\n`
        + `Use the user's ID (\`/unban 123456789012345678\`) for an exact match.`,
      );
    }

    const reason = ctx.get('reason') || 'No reason provided';

    const removed = await ctx.guild.bans.remove(entry.user.id, service.auditReason(ctx.user, reason))
      .then(() => true)
      .catch((error) => error);

    if (removed !== true) {
      return ctx.error('Unban failed', `Discord refused the unban: ${removed.message ?? removed}`);
    }

    const record = await service.createCase({
      guild: ctx.guild,
      action: 'unban',
      target: entry.user,
      moderator: ctx.user,
      reason,
      active: false,
      source: ctx.kind,
    });

    // Close any still-active tempban case so /history is accurate.
    const db = require('../../db');
    const open = await db.select('mod_cases', {
      where: { guild_id: ctx.guildId, target_id: entry.user.id, action: 'tempban', active: true },
      limit: 5,
      optional: true,
      fallback: [],
    });
    for (const row of open) {
      await db.update('mod_cases', { id: row.id }, {
        active: false,
        resolved: true,
        resolved_by: ctx.user.id,
        resolved_at: new Date().toISOString(),
      }).catch(() => {});
    }

    const embed = embeds.success(
      'Ban removed',
      `${entry.user.tag ?? entry.user.username} (<@${entry.user.id}>) can now rejoin.`,
    );
    embed.addFields(
      { name: 'Case', value: `#${record?.case_number ?? '?'}`, inline: true },
      { name: 'Reason', value: helpers.truncate(reason, 500), inline: true },
    );
    await ctx.reply({ embeds: [embed] });
  },
});

module.exports = { commands: [ban, tempban, unban], resolveTarget, guardSelf };
