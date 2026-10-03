'use strict';

/**
 * /nick, /note, /case, /history, /reason.
 *
 * The record-keeping side of moderation. These never kick or ban; they annotate
 * and report.
 */

const { PermissionFlagsBits } = require('discord.js');
const { defineCommand } = require('../../core/command');
const { PERMS } = require('../../lib/permissions');
const helpers = require('../../lib/helpers');
const embeds = require('../../lib/embeds');
const ui = require('../../lib/ui');
const service = require('./moderation-service');
const { resolveTarget } = require('./ban');

// ---------------------------------------------------------------------------
// /nick
// ---------------------------------------------------------------------------

const nick = defineCommand({
  name: 'nick',
  description: 'Change or clear a member\'s nickname',
  module: 'moderation',
  node: 'moderation.nick',
  userPerms: PERMS.manageNicknames,
  botPerms: [PermissionFlagsBits.ManageNicknames],
  usage: '<user> [nickname]',
  cooldown: 3,
  examples: ['/nick @user New Name', '/nick @user'],
  args: [
    { name: 'user', type: 'user', required: true, description: 'The member to rename' },
    { name: 'nickname', type: 'string', required: false, description: 'The new nickname, or leave empty to reset', maxLength: 32 },
  ],

  async run(ctx) {
    const { user, member, error } = await resolveTarget(ctx);
    if (error) return ctx.error('No target', error);
    if (!member) return ctx.error('Not in server', 'That user is not a member of this server.');

    // Guild owner cannot be renamed by anyone.
    if (user.id === ctx.guild.ownerId) {
      return ctx.error('Not possible', 'The server owner cannot be renamed.');
    }

    const hierarchy = require('../../lib/permissions').checkHierarchy(ctx.member, member, ctx.guild);
    if (!hierarchy.ok) return ctx.error('Cannot rename', hierarchy.reason);

    const raw = ctx.get('nickname');
    const nickname = raw ? String(raw).slice(0, 32) : null;

    // Sanitise: a nickname cannot be "@everyone" or empty whitespace.
    if (nickname && nickname.trim() === '') {
      return ctx.error('Invalid nickname', 'The nickname cannot be blank. Leave it out to reset instead.');
    }
    if (nickname && nickname.includes('@everyone')) {
      return ctx.error('Invalid nickname', 'Nicknames cannot contain `@everyone`.');
    }

    const previous = member.nickname;
    const done = await member.setNickname(nickname, service.auditReason(ctx.user, `Was: ${previous ?? 'none'}`))
      .then(() => true)
      .catch((error2) => error2);

    if (done !== true) return ctx.error('Could not change nickname', done.message ?? String(done));

    await service.createCase({
      guild: ctx.guild,
      action: 'nick',
      target: user,
      moderator: ctx.user,
      reason: nickname
        ? `Nickname: ${previous ?? '(none)'} → ${nickname}`
        : `Nickname reset (was ${previous ?? '(none)'})`,
      active: false,
      metadata: { previous, next: nickname },
      source: ctx.kind,
    });

    await ctx.reply({
      embeds: [
        embeds.success(
          nickname ? 'Nickname changed' : 'Nickname reset',
          nickname
            ? `<@${user.id}> is now **${nickname}**.`
            : `<@${user.id}>'s nickname has been removed.`,
        ),
      ],
    });
  },
});

// ---------------------------------------------------------------------------
// /note
// ---------------------------------------------------------------------------

const note = defineCommand({
  name: 'note',
  description: 'Add a private staff note about a user',
  module: 'moderation',
  node: 'moderation.note',
  userPerms: PERMS.kick,
  usage: '<user> <note>',
  cooldown: 3,
  args: [
    { name: 'user', type: 'user', required: true, description: 'Who the note is about' },
    { name: 'note', type: 'string', required: true, description: 'The note text', maxLength: 1000 },
  ],

  async run(ctx) {
    const { user, error } = await resolveTarget(ctx);
    if (error) return ctx.error('No target', error);

    const content = String(ctx.get('note') ?? '').trim();
    if (!content) return ctx.error('Empty note', 'Write something in the note.');

    const db = require('../../db');
    const created = await db.insert('notes', {
      guild_id: ctx.guildId,
      user_id: user.id,
      author_id: ctx.userId,
      content: helpers.truncate(content, 1000),
    });

    await db.writeAudit({
      guildId: ctx.guildId,
      actorId: ctx.userId,
      actorTag: ctx.user.tag ?? ctx.user.username,
      action: 'note.add',
      targetType: 'user',
      targetId: user.id,
      details: { noteId: created?.id },
      source: ctx.kind,
    });

    await ctx.reply({
      embeds: [embeds.success('Note added', `A private note about <@${user.id}> was saved.`)],
      ephemeral: true,
    });
  },
});

// ---------------------------------------------------------------------------
// /case
// ---------------------------------------------------------------------------

const caseCommand = defineCommand({
  name: 'case',
  description: 'Look up a moderation case by its number',
  module: 'moderation',
  node: 'moderation.case',
  userPerms: PERMS.kick,
  usage: '<number>',
  cooldown: 3,
  examples: ['/case 12', '.case 12'],
  args: [
    { name: 'number', type: 'integer', required: true, description: 'The case number', min: 1 },
  ],

  async run(ctx) {
    const number = Number(ctx.get('number'));
    if (!Number.isFinite(number) || number < 1) {
      return ctx.error('Invalid case number', 'Give me a positive number, e.g. `/case 12`.');
    }

    const row = await service.getCase(ctx.guildId, number);
    if (!row) {
      return ctx.error(
        'Case not found',
        `There is no case **#${number}** in this server.\n`
        + 'Case numbers start at 1 and only count actions recorded by this bot.',
      );
    }

    const embed = service.caseEmbed(row, { guild: ctx.guild });

    // Offer the notes on that user as a follow-up, which is what staff usually
    // want next.
    const db = require('../../db');
    const notes = await db.select('notes', {
      where: { guild_id: ctx.guildId, user_id: row.target_id },
      order: { column: 'created_at', ascending: false },
      limit: 5,
      optional: true,
      fallback: [],
    });

    if (notes.length > 0) {
      embed.addFields({
        name: `Notes (${notes.length})`,
        value: notes
          .map((entry) => `• ${helpers.truncate(entry.content, 100)} - <@${entry.author_id}>`)
          .join('\n'),
      });
    }

    await ctx.reply({ embeds: [embed] });
  },
});

// ---------------------------------------------------------------------------
// /history
// ---------------------------------------------------------------------------

const history = defineCommand({
  name: 'history',
  description: 'Show a member\'s full moderation history',
  module: 'moderation',
  node: 'moderation.history',
  userPerms: PERMS.kick,
  aliases: ['modhistory', 'cases'],
  usage: '[user]',
  cooldown: 3,
  args: [
    { name: 'user', type: 'user', required: false, description: 'Whose history to show (defaults to you)' },
  ],

  async run(ctx) {
    const targetId = ctx.get('user')?.id ?? ctx.userId;
    const rows = await service.getHistory(ctx.guildId, targetId, { limit: 100 });

    if (rows.length === 0) {
      return ctx.reply({
        embeds: [embeds.success('Clean record', `<@${targetId}> has no moderation history in this server.`)],
      });
    }

    const counts = service.getSummary(rows);

    // ---- summary embed ----------------------------------------------------
    const summary = embeds.embed({
      color: rows.some((row) => row.active) ? 0xed4245 : 0x99aab5,
      title: `Moderation history - ${targetId === ctx.userId ? ctx.displayName : targetId}`,
      description: `**${rows.length}** record(s) in this server.`,
    });
    summary.addFields({
      name: 'Breakdown',
      value: Object.entries(counts)
        .map(([action, count]) => `${service.ACTION_EMOJI[action] ?? '•'} **${action}**: ${count}`)
        .join('\n'),
    });

    const first = rows[rows.length - 1];
    summary.addFields(
      { name: 'First record', value: helpers.timestamp(first.created_at, 'R'), inline: true },
      { name: 'Latest record', value: helpers.timestamp(rows[0].created_at, 'R'), inline: true },
    );

    // ---- pages ------------------------------------------------------------
    const perPage = 12;
    const pages = [summary];

    for (let index = 0; index < rows.length; index += perPage) {
      const slice = rows.slice(index, index + perPage);
      const embed = embeds.embed({
        color: 0x5865f2,
        title: 'Moderation records',
        description: slice.map((row) => service.caseLine(row)).join('\n'),
      });
      embed.setFooter({
        text: `Page ${Math.floor(index / perPage) + 1} of ${Math.ceil(rows.length / perPage)} • `
          + require('../../config').brandFooterText,
      });
      pages.push(embed);
    }

    await ctx.paginate(pages);
  },
});

// ---------------------------------------------------------------------------
// /reason
// ---------------------------------------------------------------------------

const reason = defineCommand({
  name: 'reason',
  description: 'Edit the reason on an existing moderation case',
  module: 'moderation',
  node: 'moderation.reason',
  userPerms: PERMS.kick,
  usage: '<number> [reason]',
  cooldown: 3,
  examples: ['/reason 42 clarified: harassment'],
  args: [
    { name: 'number', type: 'integer', required: true, description: 'The case number to edit', min: 1 },
    { name: 'reason', type: 'string', required: false, description: 'The new reason (opens a prompt if omitted)', maxLength: 500 },
  ],

  async run(ctx) {
    const number = Number(ctx.get('number'));
    const existing = await service.getCase(ctx.guildId, number);

    if (!existing) {
      return ctx.error('Case not found', `There is no case **#${number}** in this server.`);
    }

    let newReason = ctx.get('reason');

    // Slash path with no argument: collect it in a modal.
    if (!newReason && ctx.isSlash) {
      const values = await ui.promptValues(
        ctx,
        `reason:edit:${number}`,
        `New reason for case #${number}`,
        [{
          id: 'reason',
          label: 'Reason',
          value: existing.reason ?? '',
          required: true,
          maxLength: 500,
          paragraph: true,
        }],
      );

      if (!values) return;
      newReason = values.reason;
    }

    if (!newReason) {
      return ctx.error(
        'No reason given',
        `Provide the new reason, e.g. \`${ctx.prefix}reason ${number} clarified details\`.`,
      );
    }

    const updated = await service.setReason(ctx.guildId, number, newReason, ctx.user);
    if (!updated) return ctx.error('Could not update', 'The case could not be updated.');

    const embed = embeds.success('Case updated', `Case **#${number}** has a new reason.`);
    if (existing.reason) {
      embed.addFields(
        { name: 'Before', value: helpers.truncate(existing.reason, 500) },
        { name: 'After', value: helpers.truncate(newReason, 500) },
      );
    } else {
      embed.addFields({ name: 'Reason', value: helpers.truncate(newReason, 500) });
    }

    await ctx.reply({ embeds: [embed] });
  },
});

module.exports = { commands: [nick, note, caseCommand, history, reason] };
