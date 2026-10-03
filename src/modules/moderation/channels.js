'use strict';

/**
 * Channel control: /purge, /slowmode, /lock, /unlock, /hide, /unhide.
 *
 * All of these act on a channel rather than a member, so they share a
 * permission-overwrite helper and a target-channel resolver.
 */

const { PermissionFlagsBits, ChannelType } = require('discord.js');
const { defineCommand } = require('../../core/command');
const { PERMS } = require('../../lib/permissions');
const helpers = require('../../lib/helpers');
const embeds = require('../../lib/embeds');
const service = require('./moderation-service');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the channel to act on, defaulting to the current one.
 * @param {import('../../core/context').Context} ctx
 */
async function resolveChannel(ctx) {
  const raw = ctx.get('channel');
  if (!raw) return ctx.channel;

  // Already resolved by the prefix runner.
  if (raw && typeof raw === 'object' && raw.id) return raw;

  const id = helpers.extractId(String(raw));
  if (id) return ctx.guild.channels.cache.get(id) ?? null;

  const lowered = String(raw).toLowerCase().replace(/^#/, '');
  return ctx.guild.channels.cache.find((channel) => channel.name?.toLowerCase() === lowered) ?? null;
}

/**
 * Apply or remove a permission overwrite for the guild's default role.
 *
 * This is how "lock" works in practice: deny SendMessages for @everyone.
 *
 * @param {import('discord.js').GuildChannel} channel
 * @param {boolean} locked true to lock, false to unlock
 */
async function setLocked(channel, locked) {
  return channel.permissionOverwrites.edit(
    channel.guild.roles.everyone,
    { SendMessages: locked ? false : null },
    { reason: locked ? 'Channel locked' : 'Channel unlocked' },
  );
}

/** Hide or reveal a channel for @everyone. */
async function setHidden(channel, hidden) {
  return channel.permissionOverwrites.edit(
    channel.guild.roles.everyone,
    { ViewChannel: hidden ? false : null },
    { reason: hidden ? 'Channel hidden' : 'Channel revealed' },
  );
}

// ---------------------------------------------------------------------------
// /purge
// ---------------------------------------------------------------------------

const purge = defineCommand({
  name: 'purge',
  description: 'Bulk delete messages in a channel',
  module: 'moderation',
  node: 'moderation.purge',
  userPerms: PERMS.manageMessages,
  botPerms: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory],
  aliases: ['clear', 'prune'],
  usage: '<amount> [user] [filter]',
  cooldown: 5,
  examples: ['/purge 50', '/purge 100 @spammer', '.clear 25 bots'],
  args: [
    { name: 'amount', type: 'integer', required: true, description: 'How many messages to scan (1-100)', min: 1, max: 100 },
    { name: 'user', type: 'user', required: false, description: 'Only delete messages from this user' },
    {
      name: 'filter',
      type: 'string',
      required: false,
      description: 'Only delete matching messages',
      choices: [
        { name: 'Bots only', value: 'bots' },
        { name: 'Humans only', value: 'humans' },
        { name: 'With links', value: 'links' },
        { name: 'With attachments', value: 'attachments' },
        { name: 'With embeds', value: 'embeds' },
      ],
    },
  ],

  async run(ctx) {
    const amount = helpers.clamp(Number(ctx.get('amount')) || 0, 1, 100);
    if (amount <= 0) return ctx.error('Invalid amount', 'Pick a number between 1 and 100.');

    const targetUser = ctx.get('user');
    const filter = ctx.get('filter');

    const confirmed = await ctx.confirm({
      title: `Delete up to ${amount} messages?`,
      body: [
        `**Channel:** <#${ctx.channelId}>`,
        targetUser ? `**From:** <@${targetUser.id}>` : null,
        filter ? `**Filter:** ${filter}` : null,
        '',
        'Messages younger than 14 days are removed. Older ones cannot be bulk deleted '
        + 'and are reported so you can handle them individually.',
      ].filter(Boolean).join('\n'),
      confirmLabel: `Delete ${amount}`,
    });
    if (!confirmed) return;

    await ctx.defer({ ephemeral: true });

    // Fetch one extra so we can skip the trigger message itself.
    const fetched = await ctx.channel.messages.fetch({ limit: amount }).catch((error) => {
      ctx.log.error('purge fetch failed:', error);
      return null;
    });

    if (!fetched) {
      return ctx.editReply({
        embeds: [embeds.error('Could not read messages', 'I need **Read Message History** in this channel.')],
      });
    }

    let candidates = [...fetched.values()];

    // Never delete the command's own invocation on the prefix path; the slash
    // interaction is not a message so it does not appear here.
    if (ctx.isPrefix && ctx.message) {
      candidates = candidates.filter((message) => message.id !== ctx.message.id);
    }

    if (targetUser) {
      candidates = candidates.filter((message) => message.author.id === targetUser.id);
    }

    if (filter) {
      candidates = candidates.filter((message) => {
        switch (filter) {
          case 'bots': return message.author.bot;
          case 'humans': return !message.author.bot;
          case 'links': return /https?:\/\//i.test(message.content);
          case 'attachments': return message.attachments.size > 0;
          case 'embeds': return message.embeds.length > 0;
          default: return true;
        }
      });
    }

    if (candidates.length === 0) {
      return ctx.editReply({
        embeds: [embeds.info('Nothing to delete', 'No messages matched those filters.')],
      });
    }

    // Discord refuses bulk deletes for anything older than 14 days.
    const cutoff = Date.now() - 14 * 86400 * 1000;
    const deletable = candidates.filter((message) => message.createdTimestamp > cutoff);
    const tooOld = candidates.length - deletable.length;

    let deleted = 0;
    // bulkDelete caps at 100 per call.
    for (let index = 0; index < deletable.length; index += 100) {
      const slice = deletable.slice(index, index + 100);
      const removed = await ctx.channel.bulkDelete(slice, true)
        .then((collection) => collection.size)
        .catch((error) => {
          ctx.log.warn('bulkDelete failed:', error.message);
          return 0;
        });
      deleted += removed;

      // Space out calls to stay well inside the rate limit.
      if (index + 100 < deletable.length) await helpers.sleep(350);
    }

    await service.createCase({
      guild: ctx.guild,
      action: 'purge',
      target: targetUser ?? ctx.user,
      moderator: ctx.user,
      reason: `Purged ${deleted} message(s) in #${ctx.channel.name}${filter ? ` (filter: ${filter})` : ''}`,
      active: false,
      metadata: { channel_id: ctx.channelId, deleted, too_old: tooOld, filter, target: targetUser?.id ?? null },
      source: ctx.kind,
    });

    const embed = embeds.success('Messages deleted', `Removed **${deleted}** message(s) from <#${ctx.channelId}>.`);
    if (tooOld > 0) {
      embed.addFields({
        name: 'Skipped',
        value: `${tooOld} message(s) are older than 14 days and must be deleted individually.`,
      });
    }

    await ctx.editReply({ embeds: [embed] });
  },
});

// ---------------------------------------------------------------------------
// /slowmode
// ---------------------------------------------------------------------------

const slowmode = defineCommand({
  name: 'slowmode',
  description: 'Set the slowmode rate for a channel',
  module: 'moderation',
  node: 'moderation.slowmode',
  userPerms: PERMS.manageChannels,
  botPerms: [PermissionFlagsBits.ManageChannels],
  aliases: ['sm'],
  usage: '[duration] [channel]',
  cooldown: 3,
  examples: ['/slowmode 10s', '/slowmode off', '.sm 30s #general'],
  args: [
    { name: 'duration', type: 'string', required: false, description: 'e.g. 5s, 30s, 1m, or "off" to disable' },
    { name: 'channel', type: 'channel', required: false, description: 'Channel to change (defaults to this one)' },
  ],

  async run(ctx) {
    const channel = await resolveChannel(ctx);
    if (!channel) return ctx.error('Channel not found', 'I could not find that channel.');

    if (typeof channel.setRateLimitPerUser !== 'function') {
      return ctx.error('Unsupported', 'That channel type does not support slowmode.');
    }

    const raw = ctx.get('duration');
    let seconds = 0;

    if (raw && String(raw).toLowerCase() !== 'off') {
      const parsed = helpers.parseDuration(raw);
      if (parsed === null) {
        return ctx.error('Invalid duration', 'Use a value like `5s`, `30s`, `1m`, or `off`.');
      }
      // Discord accepts 0-21600 seconds, but only 0/5/10/15/30/60/... cleanly.
      const allowed = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];
      seconds = allowed.reduce((closest, value) =>
        Math.abs(value - parsed) < Math.abs(closest - parsed) ? value : closest, 0);

      if (seconds > 21600) seconds = 21600;
    }

    const updated = await channel.setRateLimitPerUser(seconds, `By ${ctx.user.tag ?? ctx.user.username}`)
      .then(() => true)
      .catch((error) => error);

    if (updated !== true) {
      return ctx.error('Could not change slowmode', updated.message ?? String(updated));
    }

    await service.createCase({
      guild: ctx.guild,
      action: 'slowmode',
      target: ctx.user,
      moderator: ctx.user,
      reason: seconds === 0 ? `Slowmode disabled in #${channel.name}` : `Slowmode set to ${seconds}s in #${channel.name}`,
      active: false,
      metadata: { channel_id: channel.id, seconds },
      source: ctx.kind,
    });

    await ctx.reply({
      embeds: [
        embeds.success(
          seconds === 0 ? 'Slowmode disabled' : 'Slowmode updated',
          seconds === 0
            ? `<#${channel.id}> now has no slowmode.`
            : `<#${channel.id}> now allows one message every **${helpers.formatDuration(seconds)}**.`,
        ),
      ],
    });
  },
});

// ---------------------------------------------------------------------------
// /lock and /unlock
// ---------------------------------------------------------------------------

const lock = defineCommand({
  name: 'lock',
  description: 'Prevent everyone from sending messages in a channel',
  module: 'moderation',
  node: 'moderation.lock',
  userPerms: PERMS.manageChannels,
  botPerms: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
  usage: '[channel] [reason]',
  cooldown: 3,
  args: [
    { name: 'channel', type: 'channel', required: false, description: 'Channel to lock (defaults to this one)' },
    { name: 'reason', type: 'string', required: false, description: 'Why the channel is being locked', maxLength: 300 },
  ],

  async run(ctx) {
    const channel = await resolveChannel(ctx);
    if (!channel) return ctx.error('Channel not found', 'I could not find that channel.');

    if (!ctx.guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return ctx.error('Missing permission', 'I need **Manage Roles** to change channel permissions.');
    }

    const reason = ctx.get('reason') || 'No reason provided';
    const done = await setLocked(channel, true).then(() => true).catch((error) => error);

    if (done !== true) return ctx.error('Could not lock', done.message ?? String(done));

    await service.createCase({
      guild: ctx.guild,
      action: 'lock',
      target: ctx.user,
      moderator: ctx.user,
      reason: `Locked #${channel.name}: ${reason}`,
      active: false,
      metadata: { channel_id: channel.id },
      source: ctx.kind,
    });

    await ctx.reply({
      embeds: [embeds.success('Channel locked', `<#${channel.id}> is now read-only for @everyone.`)],
    });
  },
});

const unlock = defineCommand({
  name: 'unlock',
  description: 'Allow everyone to send messages in a channel again',
  module: 'moderation',
  node: 'moderation.unlock',
  userPerms: PERMS.manageChannels,
  botPerms: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
  usage: '[channel]',
  cooldown: 3,
  args: [
    { name: 'channel', type: 'channel', required: false, description: 'Channel to unlock (defaults to this one)' },
  ],

  async run(ctx) {
    const channel = await resolveChannel(ctx);
    if (!channel) return ctx.error('Channel not found', 'I could not find that channel.');

    const done = await setLocked(channel, false).then(() => true).catch((error) => error);
    if (done !== true) return ctx.error('Could not unlock', done.message ?? String(done));

    await service.createCase({
      guild: ctx.guild,
      action: 'unlock',
      target: ctx.user,
      moderator: ctx.user,
      reason: `Unlocked #${channel.name}`,
      active: false,
      metadata: { channel_id: channel.id },
      source: ctx.kind,
    });

    await ctx.reply({
      embeds: [embeds.success('Channel unlocked', `<#${channel.id}> is open again.`)],
    });
  },
});

// ---------------------------------------------------------------------------
// /hide and /unhide
// ---------------------------------------------------------------------------

const hide = defineCommand({
  name: 'hide',
  description: 'Hide a channel from everyone',
  module: 'moderation',
  node: 'moderation.hide',
  userPerms: PERMS.manageChannels,
  botPerms: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
  usage: '[channel]',
  cooldown: 3,
  args: [
    { name: 'channel', type: 'channel', required: false, description: 'Channel to hide (defaults to this one)' },
  ],

  async run(ctx) {
    const channel = await resolveChannel(ctx);
    if (!channel) return ctx.error('Channel not found', 'I could not find that channel.');

    const done = await setHidden(channel, true).then(() => true).catch((error) => error);
    if (done !== true) return ctx.error('Could not hide', done.message ?? String(done));

    await service.createCase({
      guild: ctx.guild,
      action: 'hide',
      target: ctx.user,
      moderator: ctx.user,
      reason: `Hid #${channel.name}`,
      active: false,
      metadata: { channel_id: channel.id },
      source: ctx.kind,
    });

    // Reply in the current channel: the target may now be invisible.
    await ctx.reply({
      embeds: [embeds.success('Channel hidden', `<#${channel.id}> is no longer visible to @everyone.`)],
    });
  },
});

const unhide = defineCommand({
  name: 'unhide',
  description: 'Make a hidden channel visible again',
  module: 'moderation',
  node: 'moderation.unhide',
  userPerms: PERMS.manageChannels,
  botPerms: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
  usage: '[channel]',
  cooldown: 3,
  args: [
    { name: 'channel', type: 'channel', required: false, description: 'Channel to reveal (defaults to this one)' },
  ],

  async run(ctx) {
    const channel = await resolveChannel(ctx);
    if (!channel) return ctx.error('Channel not found', 'I could not find that channel.');

    const done = await setHidden(channel, false).then(() => true).catch((error) => error);
    if (done !== true) return ctx.error('Could not unhide', done.message ?? String(done));

    await service.createCase({
      guild: ctx.guild,
      action: 'unhide',
      target: ctx.user,
      moderator: ctx.user,
      reason: `Revealed #${channel.name}`,
      active: false,
      metadata: { channel_id: channel.id },
      source: ctx.kind,
    });

    await ctx.reply({
      embeds: [embeds.success('Channel visible', `<#${channel.id}> is visible to @everyone again.`)],
    });
  },
});

module.exports = { commands: [purge, slowmode, lock, unlock, hide, unhide], resolveChannel };
