'use strict';

/**
 * Kick, timeout (mute/unmute) and warn family.
 *
 * Split into one file per family so each stays readable; the loader accepts an
 * array export from each.
 */

const { PermissionFlagsBits } = require('discord.js');
const { defineCommand } = require('../../core/command');
const { PERMS } = require('../../lib/permissions');
const helpers = require('../../lib/helpers');
const embeds = require('../../lib/embeds');
const service = require('./moderation-service');
const { resolveTarget, guardSelf } = require('./ban');

// ---------------------------------------------------------------------------
// /kick
// ---------------------------------------------------------------------------

const kick = defineCommand({
  name: 'kick',
  description: 'Kick a member from the server',
  module: 'moderation',
  node: 'moderation.kick',
  userPerms: PERMS.kick,
  botPerms: [PermissionFlagsBits.KickMembers],
  aliases: ['k'],
  usage: '<user> [reason]',
  cooldown: 3,
  args: [
    { name: 'user', type: 'user', required: true, description: 'The member to kick' },
    { name: 'reason', type: 'string', required: false, description: 'Why they are being kicked', maxLength: 500 },
  ],

  async run(ctx) {
    const { user, member, error } = await resolveTarget(ctx);
    if (error) return ctx.error('No target', error);
    if (!member) return ctx.error('Not in server', 'That user is not a member of this server, so they cannot be kicked.');

    const selfGuard = guardSelf(ctx, user);
    if (selfGuard) return ctx.error('Not allowed', selfGuard);

    const hierarchy = require('../../lib/permissions').checkHierarchy(ctx.member, member, ctx.guild);
    if (!hierarchy.ok) return ctx.error('Cannot kick', hierarchy.reason);

    const reason = ctx.get('reason') || 'No reason provided';

    const confirmed = await ctx.confirm({
      title: `Kick ${user.tag ?? user.username}?`,
      body: `**Target:** <@${user.id}>\n**Reason:** ${reason}\n\nThey can rejoin with a new invite.`,
      confirmLabel: 'Kick',
    });
    if (!confirmed) return;

    const result = await service.kick(ctx.guild, member, ctx.user, { reason, source: ctx.kind });
    if (!result.ok) return ctx.error('Kick failed', result.error);

    const embed = embeds.success('Member kicked', `<@${user.id}> has been kicked.`);
    embed.addFields({ name: 'Case', value: `#${result.case?.case_number ?? '?'}`, inline: true });
    await ctx.reply({ embeds: [embed] });
  },
});

// ---------------------------------------------------------------------------
// /mute
// ---------------------------------------------------------------------------

const mute = defineCommand({
  name: 'mute',
  description: 'Time out a member so they cannot speak',
  module: 'moderation',
  node: 'moderation.mute',
  userPerms: PERMS.mute,
  botPerms: [PermissionFlagsBits.ModerateMembers],
  aliases: ['timeout'],
  usage: '<user> [duration] [reason]',
  cooldown: 3,
  examples: ['/mute @noisy 10m calm down', '.mute @noisy 1h'],
  args: [
    { name: 'user', type: 'user', required: true, description: 'The member to mute' },
    { name: 'duration', type: 'string', required: false, description: 'How long, e.g. 10m, 1h, 1d (max 28d)' },
    { name: 'reason', type: 'string', required: false, description: 'Why they are being muted', maxLength: 500 },
  ],

  async run(ctx) {
    const { user, member, error } = await resolveTarget(ctx);
    if (error) return ctx.error('No target', error);
    if (!member) return ctx.error('Not in server', 'That user is not a member of this server.');

    const selfGuard = guardSelf(ctx, user);
    if (selfGuard) return ctx.error('Not allowed', selfGuard);

    const hierarchy = require('../../lib/permissions').checkHierarchy(ctx.member, member, ctx.guild);
    if (!hierarchy.ok) return ctx.error('Cannot mute', hierarchy.reason);

    const rawDuration = ctx.get('duration');
    const duration = rawDuration ? helpers.parseDuration(rawDuration) : 600;

    if (rawDuration && !duration) {
      return ctx.error('Invalid duration', 'Use a format like `10m`, `1h` or `1d`.');
    }
    if (duration > 28 * 86400) {
      return ctx.error('Duration too long', 'Discord timeouts are limited to **28 days**.');
    }

    const reason = ctx.get('reason') || 'No reason provided';

    const result = await service.mute(ctx.guild, member, ctx.user, {
      reason,
      duration,
      source: ctx.kind,
    });
    if (!result.ok) return ctx.error('Mute failed', result.error);

    const embed = embeds.success(
      'Member muted',
      `<@${user.id}> is timed out for **${helpers.formatDuration(result.duration)}**.`,
    );
    embed.addFields(
      { name: 'Case', value: `#${result.case?.case_number ?? '?'}`, inline: true },
      { name: 'Ends', value: helpers.timestamp(new Date(Date.now() + result.duration * 1000), 'R'), inline: true },
    );
    await ctx.reply({ embeds: [embed] });
  },
});

// ---------------------------------------------------------------------------
// /unmute
// ---------------------------------------------------------------------------

const unmute = defineCommand({
  name: 'unmute',
  description: 'Remove a member\'s timeout early',
  module: 'moderation',
  node: 'moderation.unmute',
  userPerms: PERMS.mute,
  botPerms: [PermissionFlagsBits.ModerateMembers],
  aliases: ['untimeout'],
  usage: '<user> [reason]',
  cooldown: 3,
  args: [
    { name: 'user', type: 'user', required: true, description: 'The member to unmute' },
    { name: 'reason', type: 'string', required: false, description: 'Why the timeout is being lifted', maxLength: 500 },
  ],

  async run(ctx) {
    const { member, user, error } = await resolveTarget(ctx);
    if (error) return ctx.error('No target', error);
    if (!member) return ctx.error('Not in server', 'That user is not a member of this server.');

    const reason = ctx.get('reason') || 'No reason provided';
    const result = await service.unmute(ctx.guild, member, ctx.user, { reason, source: ctx.kind });
    if (!result.ok) return ctx.error('Unmute failed', result.error);

    await ctx.reply({
      embeds: [embeds.success('Timeout removed', `<@${user.id}> can speak again.`)],
    });
  },
});

// ---------------------------------------------------------------------------
// /warn
// ---------------------------------------------------------------------------

const warn = defineCommand({
  name: 'warn',
  description: 'Issue a formal warning to a member',
  module: 'moderation',
  node: 'moderation.warn',
  userPerms: PERMS.kick,
  aliases: ['w'],
  usage: '<user> [reason]',
  cooldown: 3,
  args: [
    { name: 'user', type: 'user', required: true, description: 'The member to warn' },
    { name: 'reason', type: 'string', required: true, description: 'Why they are being warned', maxLength: 500 },
  ],

  async run(ctx) {
    const { user, error } = await resolveTarget(ctx);
    if (error) return ctx.error('No target', error);

    const selfGuard = guardSelf(ctx, user);
    if (selfGuard) return ctx.error('Not allowed', selfGuard);

    const reason = ctx.get('reason') || 'No reason provided';

    const result = await service.warn(ctx.guild, user, ctx.user, { reason, source: ctx.kind });
    if (!result.ok) return ctx.error('Warning failed', result.error);

    // Report how many active warnings they now have, which is what moderators
    // actually want to know.
    const active = await service.getActiveWarnings(ctx.guildId, user.id);

    const embed = embeds.warning('Member warned', `<@${user.id}> has been warned.`);
    embed.addFields(
      { name: 'Case', value: `#${result.case?.case_number ?? '?'}`, inline: true },
      { name: 'Active warnings', value: String(active.length), inline: true },
      { name: 'Reason', value: helpers.truncate(reason, 1000) },
    );
    await ctx.reply({ embeds: [embed] });

    await user.send({
      embeds: [embeds.embed({
        color: 0xfee75c,
        title: `You were warned in ${ctx.guild.name}`,
        description: `**Reason:** ${reason}`,
        keepFooter: false,
      })],
    }).catch(() => {});
  },
});

// ---------------------------------------------------------------------------
// /warnings
// ---------------------------------------------------------------------------

const warnings = defineCommand({
  name: 'warnings',
  description: 'List a member\'s active warnings',
  module: 'moderation',
  node: 'moderation.warnings',
  userPerms: PERMS.kick,
  aliases: ['warns'],
  usage: '[user]',
  cooldown: 3,
  args: [
    { name: 'user', type: 'user', required: false, description: 'Whose warnings to show (defaults to you)' },
  ],

  async run(ctx) {
    const targetId = ctx.get('user')?.id ?? ctx.userId;
    const active = await service.getActiveWarnings(ctx.guildId, targetId);

    if (active.length === 0) {
      return ctx.reply({
        embeds: [embeds.success('No active warnings', `<@${targetId}> has a clean record.`)],
      });
    }

    const pages = [];
    const perPage = 10;

    for (let index = 0; index < active.length; index += perPage) {
      const slice = active.slice(index, index + perPage);
      const embed = embeds.embed({
        color: 0xfee75c,
        title: `⚠️ Warnings for ${targetId === ctx.userId ? ctx.displayName : targetId}`,
        description: slice.map((row) => service.caseLine(row)).join('\n'),
      });
      embed.setFooter({
        text: `Page ${Math.floor(index / perPage) + 1} of ${Math.ceil(active.length / perPage)} • `
          + `${active.length} active • ${require('../../config').brandFooterText}`,
      });
      pages.push(embed);
    }

    await ctx.paginate(pages);
  },
});

// ---------------------------------------------------------------------------
// /clearwarns
// ---------------------------------------------------------------------------

const clearwarns = defineCommand({
  name: 'clearwarns',
  description: 'Clear all warnings for a member',
  module: 'moderation',
  node: 'moderation.clearwarns',
  userPerms: PERMS.kick,
  usage: '<user>',
  cooldown: 3,
  args: [
    { name: 'user', type: 'user', required: true, description: 'Whose warnings to clear' },
  ],

  async run(ctx) {
    const { user, error } = await resolveTarget(ctx);
    if (error) return ctx.error('No target', error);

    const active = await service.getActiveWarnings(ctx.guildId, user.id);
    if (active.length === 0) {
      return ctx.reply({
        embeds: [embeds.info('Nothing to clear', `<@${user.id}> has no active warnings.`)],
      });
    }

    const confirmed = await ctx.confirm({
      title: `Clear ${active.length} warning(s)?`,
      body: `This will mark all ${active.length} of <@${user.id}>'s warnings as resolved.\n\n`
        + 'The warning records are kept for the audit trail.',
      confirmLabel: 'Clear all',
    });
    if (!confirmed) return;

    const result = await service.clearWarnings(ctx.guildId, user.id, ctx.user);

    const embed = embeds.success('Warnings cleared', `Resolved **${result.cleared}** warning(s) for <@${user.id}>.`);
    await ctx.reply({ embeds: [embed] });
  },
});

module.exports = { commands: [kick, mute, unmute, warn, warnings, clearwarns] };
