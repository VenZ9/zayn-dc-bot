'use strict';

/**
 * Logging service.
 *
 * Every loggable event arrives here, and this file decides whether the guild
 * wants it, where it goes, and what it looks like.
 *
 * Design notes:
 *   - config is cached per guild for 15s (same cache the rest of the bot uses)
 *   - a channel can be configured per event type, or one fallback channel used
 *     for everything
 *   - ignored channels, roles and users are honoured before anything is sent
 *   - every send is guarded: a deleted log channel must not throw into the
 *     gateway handler, because that would kill unrelated features
 */

const { ChannelType, AuditLogEvent } = require('discord.js');
const logger = require('../../lib/logger');
const embeds = require('../../lib/embeds');
const helpers = require('../../lib/helpers');
const { COLORS } = require('../../lib/constants');

const log = logger.child('logging');

/** How long a resolved logs_config row stays cached, in ms. */
const CONFIG_TTL_MS = 15_000;

/** @type {Map<string, {at: number, value: object}>} */
const cache = new Map();

/** The event keys a guild can enable, grouped for `/logs`. */
const LOG_EVENTS = Object.freeze({
  messages: [
    'messageDelete', 'messageUpdate', 'messageBulkDelete',
  ],
  members: [
    'memberAdd', 'memberRemove', 'memberUpdate', 'memberNickname', 'memberRoles',
  ],
  channels: [
    'channelCreate', 'channelDelete', 'channelUpdate',
  ],
  roles: [
    'roleCreate', 'roleDelete', 'roleUpdate',
  ],
  voice: [
    'voiceJoin', 'voiceLeave', 'voiceMove',
  ],
  moderation: [
    'banAdd', 'banRemove', 'modAction',
  ],
  server: [
    'guildUpdate', 'emojiUpdate', 'scheduledEventCreate', 'scheduledEventDelete', 'scheduledEventUpdate',
  ],
  invites: [
    'inviteCreate', 'inviteDelete',
  ],
});

/** Flat list of every valid event key. */
const ALL_EVENTS = Object.freeze(Object.values(LOG_EVENTS).flat());

/**
 * Load a guild's logging config, with caching.
 * @param {string} guildId
 * @param {boolean} [fresh]
 */
async function getConfig(guildId, fresh = false) {
  const cached = cache.get(guildId);
  if (!fresh && cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.value;

  const db = require('../../db');
  const row = await db.selectOne('logs_config', { where: { guild_id: guildId }, optional: true });

  const value = {
    enabled: row?.enabled ?? false,
    events: row?.events ?? {},
    ignored_channels: row?.ignored_channels ?? [],
    ignored_roles: row?.ignored_roles ?? [],
    ignored_users: row?.ignored_users ?? [],
  };

  cache.set(guildId, { at: Date.now(), value });
  return value;
}

/** Patch the logging config. */
async function setConfig(guildId, patch) {
  const db = require('../../db');
  await db.upsert('logs_config', { guild_id: guildId, ...patch }, 'guild_id');
  cache.delete(guildId);
  return getConfig(guildId, true);
}

/** Drop the cached row. */
const invalidate = (guildId) => cache.delete(guildId);

/**
 * Resolve the destination channel for an event.
 *
 * Specific event channel first, then the catch-all `default` key.
 * @returns {Promise<import('discord.js').TextChannel|null>}
 */
async function resolveChannel(client, guildId, eventKey) {
  const config = await getConfig(guildId);
  if (!config.enabled) return null;

  const channelId = config.events?.[eventKey] || config.events?.default;
  if (!channelId) return null;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return null;

  // Never log into a thread or a forum post - they are noisy and short lived.
  if (channel.type === ChannelType.GuildForum) return null;

  return channel;
}

/**
 * Should this event be suppressed because of an ignore rule?
 * @param {object} config
 * @param {{ channelId?: string, userId?: string, roleIds?: string[] }} subject
 */
function isIgnored(config, subject = {}) {
  const { channelId, userId, roleIds = [] } = subject;

  if (channelId && config.ignored_channels.includes(channelId)) return true;
  if (userId && config.ignored_users.includes(userId)) return true;
  if (roleIds.some((roleId) => config.ignored_roles.includes(roleId))) return true;

  return false;
}

/**
 * Send a log embed.
 *
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {string} eventKey
 * @param {(build: typeof embeds) => import('discord.js').EmbedBuilder} build
 * @param {{ channelId?: string, userId?: string, roleIds?: string[] }} [subject]
 */
async function send(client, guildId, eventKey, build, subject = {}) {
  try {
    const config = await getConfig(guildId);
    if (!config.enabled) return;

    // Moderation and audit logs are never suppressed by message ignore rules -
    // they are the record that matters most.
    const exempt = eventKey.startsWith('mod') || eventKey.startsWith('ban');
    if (!exempt && isIgnored(config, subject)) return;

    const channel = await resolveChannel(client, guildId, eventKey);
    if (!channel) return;

    const embed = build(embeds);
    if (!embed) return;

    // Keep the embed's own footer when it set one (mod actions carry a case id).
    embeds.applyBranding(embed, { keepFooter: Boolean(embed.data?.footer?.text) });

    await channel.send({ embeds: [embed] });
  } catch (error) {
    // A logging failure must never surface as a command failure.
    log.debug(`log "${eventKey}" for ${guildId} failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Audit-log helpers
// ---------------------------------------------------------------------------

/**
 * Look up who performed an action, from Discord's own audit log.
 *
 * Discord does not tell us the executor, so this is the only way to attribute a
 * ban or a channel deletion. Results are best-effort: the audit log may not
 * have caught up yet when the gateway event arrives.
 *
 * @param {import('discord.js').Guild} guild
 * @param {AuditLogEvent} type
 * @param {(entry: any) => boolean} [match]
 */
async function findExecutor(guild, type, match) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 5 });
    const entry = logs.entries.find((candidate) => {
      if (Date.now() - candidate.createdTimestamp > 15_000) return false;
      return match ? match(candidate) : true;
    });
    return entry?.executor ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Message events
// ---------------------------------------------------------------------------

async function onMessage(message) {
  void message;
  // Intentionally empty: logging a message for a "messageCreate" log would be
  // untenable at scale and is not one of the requested event types.
}

async function onMessageDelete(message) {
  if (!message?.guild || !message.author) return;
  if (message.author.bot) return;

  // Partials give us an uncached message; skip rather than guessing content.
  const partial = message.partial === true;

  await send(
    message.client,
    message.guild.id,
    'messageDelete',
    ({ embed, COLORS: colors }) => {
      const built = embed({
        color: colors.danger,
        title: '🗑️ Message deleted',
        description: partial
          ? 'Message content was not cached.'
          : (message.content ? helpers.truncate(message.content, 1900) : '*No text content*'),
      });
      built.addFields(
        { name: 'Author', value: `${message.author.tag ?? message.author.username} (<@${message.author.id}>)`, inline: true },
        { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
      );
      if (message.attachments?.size > 0) {
        built.addFields({ name: 'Attachments', value: pluralAttachments(message.attachments), inline: false });
      }
      return built;
    },
    { channelId: message.channel.id, userId: message.author.id },
  );
}

async function onMessageUpdate(before, after) {
  // Edits fire with partial "before" states; require both to be usable.
  if (!after?.guild) return;
  if (after.author?.bot) return;
  if (before?.partial && !before.content) return;
  if (before?.content === after.content) return;

  await send(
    after.client,
    after.guild.id,
    'messageUpdate',
    ({ embed, COLORS: colors }) => embed({
      color: colors.warning,
      title: '✏️ Message edited',
      description: [
        `**Before**\n${helpers.truncate(before.content || '*unknown*', 900)}`,
        '',
        `**After**\n${helpers.truncate(after.content || '*unknown*', 900)}`,
      ].join('\n'),
    }).addFields(
      { name: 'Author', value: `<@${after.author.id}>`, inline: true },
      { name: 'Channel', value: `<#${after.channel.id}>`, inline: true },
      { name: 'Jump', value: `[Open message](${after.url})`, inline: true },
    ),
    { channelId: after.channel.id, userId: after.author.id },
  );
}

async function onMessageBulkDelete(messages, channel) {
  if (!channel?.guild) return;
  const collection = messages;
  const list = collection instanceof Map ? [...collection.values()] : (Array.isArray(collection) ? collection : []);

  await send(
    channel.client,
    channel.guild.id,
    'messageBulkDelete',
    ({ embed, COLORS: colors }) => {
      const built = embed({
        color: colors.danger,
        title: `🗑️ ${list.length} messages purged`,
        description: `In <#${channel.id}>`,
      });
      const preview = list
        .slice(0, 10)
        .map((entry) => `**${entry.author?.tag ?? 'unknown'}**: ${helpers.truncate(entry.content || '*no content*', 80)}`)
        .join('\n');
      if (preview) built.addFields({ name: 'Preview', value: preview });
      return built;
    },
    { channelId: channel.id },
  );
}

/** "3 files: a.png, b.png, c.png" */
function pluralAttachments(attachments) {
  const names = attachments.map((attachment) => attachment.name).slice(0, 5);
  return `${attachments.size} file(s): ${names.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Member events
// ---------------------------------------------------------------------------

async function onMemberAdd(member) {
  await send(member.client, member.guild.id, 'memberAdd', ({ embed, COLORS: colors }) => embed({
    color: colors.success,
    title: '📥 Member joined',
    description: `<@${member.id}> (${member.user.tag ?? member.user.username})`,
  }).addFields(
    { name: 'Account created', value: helpers.timestamp(member.user.createdAt, 'R'), inline: true },
    { name: 'Members', value: helpers.formatNumber(member.guild.memberCount), inline: true },
  ), { userId: member.id });
}

async function onMemberRemove(member) {
  // The member object may be partial after a leave.
  const tag = member.user?.tag ?? member.user?.username ?? 'Unknown';

  await send(member.guild.client, member.guild.id, 'memberRemove', ({ embed, COLORS: colors }) => {
    const built = embed({
      color: colors.danger,
      title: '📤 Member left',
      description: `**${tag}** (<@${member.id}>)`,
    });
    if (member.joinedAt) {
      built.addFields({ name: 'Joined', value: helpers.timestamp(member.joinedAt, 'R'), inline: true });
    }
    const roles = member.roles?.cache?.filter((role) => role.id !== member.guild.id);
    if (roles?.size) {
      built.addFields({ name: 'Roles', value: roles.map((role) => role.name).slice(0, 15).join(', ') });
    }
    return built;
  }, { userId: member.id });
}

async function onMemberUpdate(before, after) {
  // ---- nickname ---------------------------------------------------------
  if (before.nickname !== after.nickname) {
    await send(after.client, after.guild.id, 'memberNickname', ({ embed, COLORS: colors }) => embed({
      color: colors.info,
      title: '📝 Nickname changed',
      description: `<@${after.id}>`,
    }).addFields(
      { name: 'Before', value: before.nickname || before.user.username, inline: true },
      { name: 'After', value: after.nickname || after.user.username, inline: true },
    ), { userId: after.id });
  }

  // ---- roles ------------------------------------------------------------
  const added = after.roles.cache.filter((role) => !before.roles.cache.has(role.id));
  const removed = before.roles.cache.filter((role) => !after.roles.cache.has(role.id));

  if (added.size > 0 || removed.size > 0) {
    const executor = await findExecutor(after.guild, AuditLogEvent.MemberRoleUpdate, (entry) => entry.target?.id === after.id);

    await send(after.client, after.guild.id, 'memberRoles', ({ embed, COLORS: colors }) => {
      const built = embed({
        color: colors.info,
        title: '🎭 Roles updated',
        description: `<@${after.id}>`,
      });
      if (added.size) built.addFields({ name: 'Added', value: added.map((role) => `<@&${role.id}>`).join(', ') });
      if (removed.size) built.addFields({ name: 'Removed', value: removed.map((role) => `<@&${role.id}>`).join(', ') });
      built.addFields({ name: 'By', value: executor ? `<@${executor.id}>` : 'Unknown', inline: true });
      return built;
    }, { userId: after.id, roleIds: [...added.keys(), ...removed.keys()] });
  }
}

// ---------------------------------------------------------------------------
// Channel events
// ---------------------------------------------------------------------------

async function onChannelCreate(channel) {
  if (!channel.guild) return;
  await send(channel.client, channel.guild.id, 'channelCreate', ({ embed, COLORS: colors }) => {
    const built = embed({
      color: colors.success,
      title: '📁 Channel created',
      description: `<#${channel.id}> (${channel.name})`,
    });
    appendChannelDetails(built, channel);
    return built;
  }, { channelId: channel.id });
}

async function onChannelDelete(channel) {
  if (!channel.guild) return;
  const executor = await findExecutor(channel.guild, AuditLogEvent.ChannelDelete, (entry) => entry.target?.id === channel.id);

  await send(channel.client, channel.guild.id, 'channelDelete', ({ embed, COLORS: colors }) => {
    const built = embed({
      color: colors.danger,
      title: '📁 Channel deleted',
      description: `**#${channel.name}** (${channel.id})`,
    });
    appendChannelDetails(built, channel);
    built.addFields({ name: 'By', value: executor ? `<@${executor.id}>` : 'Unknown', inline: true });
    return built;
  }, { channelId: channel.id });
}

async function onChannelUpdate(before, after) {
  if (!after.guild) return;

  // Only report meaningful changes - position and permission overwrite churn is
  // constant and would drown the channel.
  const changes = [];
  if (before.name !== after.name) changes.push(`**Name**: \`${before.name}\` → \`${after.name}\``);
  if (before.topic !== after.topic) changes.push(`**Topic**: ${before.topic ? helpers.truncate(before.topic, 200) : '*none*'} → ${after.topic ? helpers.truncate(after.topic, 200) : '*none*'}`);
  if (before.nsfw !== after.nsfw) changes.push(`**NSFW**: ${before.nsfw} → ${after.nsfw}`);
  if (before.slowmode !== after.slowmode) changes.push(`**Slowmode**: ${before.rateLimitPerUser}s → ${after.rateLimitPerUser}s`);
  if (before.parentId !== after.parentId) changes.push('**Category** changed');
  if (before.type !== after.type) changes.push('**Type** changed');

  if (changes.length === 0) return;

  const executor = await findExecutor(after.guild, AuditLogEvent.ChannelUpdate, (entry) => entry.target?.id === after.id);

  await send(after.client, after.guild.id, 'channelUpdate', ({ embed, COLORS: colors }) => {
    const built = embed({
      color: colors.warning,
      title: '📁 Channel updated',
      description: `<#${after.id}>\n\n${changes.join('\n')}`,
    });
    built.addFields({ name: 'By', value: executor ? `<@${executor.id}>` : 'Unknown', inline: true });
    return built;
  }, { channelId: after.id });
}

/** Append type / category / slowmode to a channel embed. */
function appendChannelDetails(built, channel) {
  const typeName = ChannelType[channel.type] ?? String(channel.type);
  built.addFields({ name: 'Type', value: typeName, inline: true });
  if (channel.parent) built.addFields({ name: 'Category', value: channel.parent.name, inline: true });
  if (channel.rateLimitPerUser) {
    built.addFields({ name: 'Slowmode', value: `${channel.rateLimitPerUser}s`, inline: true });
  }
}

// ---------------------------------------------------------------------------
// Role events
// ---------------------------------------------------------------------------

async function onRoleCreate(role) {
  await send(role.client, role.guild.id, 'roleCreate', ({ embed, COLORS: colors }) => embed({
    color: colors.success,
    title: '🎭 Role created',
    description: `<@&${role.id}> (${role.name})`,
  }).addFields(
    { name: 'Colour', value: role.hexColor, inline: true },
    { name: 'Mentionable', value: String(role.mentionable), inline: true },
    { name: 'Hoisted', value: String(role.hoist), inline: true },
  ));
}

async function onRoleDelete(role) {
  const executor = await findExecutor(role.guild, AuditLogEvent.RoleDelete, (entry) => entry.target?.id === role.id);
  await send(role.client, role.guild.id, 'roleDelete', ({ embed, COLORS: colors }) => embed({
    color: colors.danger,
    title: '🎭 Role deleted',
    description: `**${role.name}** (${role.id})`,
  }).addFields({ name: 'By', value: executor ? `<@${executor.id}>` : 'Unknown', inline: true }));
}

async function onRoleUpdate(before, after) {
  const changes = [];
  if (before.name !== after.name) changes.push(`**Name**: \`${before.name}\` → \`${after.name}\``);
  if (before.hexColor !== after.hexColor) changes.push(`**Colour**: ${before.hexColor} → ${after.hexColor}`);
  if (before.hoist !== after.hoist) changes.push(`**Hoisted**: ${before.hoist} → ${after.hoist}`);
  if (before.mentionable !== after.mentionable) changes.push(`**Mentionable**: ${before.mentionable} → ${after.mentionable}`);
  if (before.permissions?.bitfield !== after.permissions?.bitfield) changes.push('**Permissions** changed');

  if (changes.length === 0) return;

  const executor = await findExecutor(after.guild, AuditLogEvent.RoleUpdate, (entry) => entry.target?.id === after.id);

  await send(after.client, after.guild.id, 'roleUpdate', ({ embed, COLORS: colors }) => embed({
    color: colors.warning,
    title: '🎭 Role updated',
    description: `<@&${after.id}>\n\n${changes.join('\n')}`,
  }).addFields({ name: 'By', value: executor ? `<@${executor.id}>` : 'Unknown', inline: true }));
}

// ---------------------------------------------------------------------------
// Moderation events
// ---------------------------------------------------------------------------

async function onBanAdd(ban) {
  const executor = await findExecutor(ban.guild, AuditLogEvent.MemberBanAdd, (entry) => entry.target?.id === ban.user.id);

  await send(ban.client, ban.guild.id, 'banAdd', ({ embed, COLORS: colors }) => {
    const built = embed({
      color: colors.danger,
      title: '🔨 Member banned',
      description: `<@${ban.user.id}> (${ban.user.tag ?? ban.user.username})`,
    });
    if (ban.reason) built.addFields({ name: 'Reason', value: helpers.truncate(ban.reason, 500) });
    built.addFields({ name: 'By', value: executor ? `<@${executor.id}>` : 'Unknown', inline: true });
    return built;
  }, { userId: ban.user.id });
}

async function onBanRemove(ban) {
  const executor = await findExecutor(ban.guild, AuditLogEvent.MemberBanRemove, (entry) => entry.target?.id === ban.user.id);

  await send(ban.client, ban.guild.id, 'banRemove', ({ embed, COLORS: colors }) => embed({
    color: colors.success,
    title: '🔓 Member unbanned',
    description: `<@${ban.user.id}> (${ban.user.tag ?? ban.user.username})`,
  }).addFields({ name: 'By', value: executor ? `<@${executor.id}>` : 'Unknown', inline: true }), { userId: ban.user.id });
}

/**
 * Log a moderation action performed *through the bot*.
 * Unlike the gateway handlers above, this carries a case number.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} params
 */
async function onModAction(guild, params) {
  const { action, target, moderator, reason, caseNumber, duration, extra } = params;

  await send(guild.client, guild.id, 'modAction', ({ embed, COLORS: colors }) => {
    const built = embed({
      color: colors.warning,
      title: `${actionEmoji(action)} ${capitalise(action)}`,
      description: `**Target:** ${target}\n**Moderator:** ${moderator}`,
      keepFooter: false,
    });
    if (caseNumber) built.addFields({ name: 'Case', value: `#${caseNumber}`, inline: true });
    if (reason) built.addFields({ name: 'Reason', value: helpers.truncate(reason, 500) });
    if (duration) built.addFields({ name: 'Duration', value: helpers.formatDuration(duration), inline: true });
    if (extra) built.addFields({ name: 'Notes', value: helpers.truncate(String(extra), 500) });
    return built;
  });
}

/** Emoji per moderation action. */
function actionEmoji(action) {
  const map = {
    ban: '🔨', tempban: '⏳', unban: '🔓', kick: '👢', mute: '🔇', unmute: '🔊',
    warn: '⚠️', clearwarns: '🧹', purge: '🗑️', slowmode: '🐌', lock: '🔒', unlock: '🔓',
    hide: '🙈', unhide: '👁️', nick: '📝', note: '🗒️',
  };
  return map[action] ?? '🛡️';
}

/** "tempban" -> "Tempban" */
const capitalise = (text) => String(text || '').charAt(0).toUpperCase() + String(text || '').slice(1);

// ---------------------------------------------------------------------------
// Server events
// ---------------------------------------------------------------------------

async function onGuildUpdate(before, after) {
  const changes = [];
  if (before.name !== after.name) changes.push(`**Name**: \`${before.name}\` → \`${after.name}\``);
  if (before.icon !== after.icon) changes.push('**Icon** changed');
  if (before.banner !== after.banner) changes.push('**Banner** changed');
  if (before.ownerId !== after.ownerId) changes.push(`**Owner**: <@${before.ownerId}> → <@${after.ownerId}>`);
  if (before.verificationLevel !== after.verificationLevel) changes.push(`**Verification**: ${before.verificationLevel} → ${after.verificationLevel}`);
  if (before.systemChannelId !== after.systemChannelId) changes.push('**System channel** changed');
  if (before.afkChannelId !== after.afkChannelId) changes.push('**AFK channel** changed');

  if (changes.length === 0) return;

  const executor = await findExecutor(after, AuditLogEvent.GuildUpdate);

  await send(after.client, after.id, 'guildUpdate', ({ embed, COLORS: colors }) => embed({
    color: colors.warning,
    title: '⚙️ Server updated',
    description: changes.join('\n'),
  }).addFields({ name: 'By', value: executor ? `<@${executor.id}>` : 'Unknown', inline: true }));
}

async function onEmojiUpdate(guild, emojis) {
  // Only report additions and removals - renames are rare and noisy to diff.
  void guild;
  void emojis;
}

// ---------------------------------------------------------------------------
// Invite events
// ---------------------------------------------------------------------------

async function onInviteCreate(invite) {
  if (!invite.guild) return;
  await send(invite.client, invite.guild.id, 'inviteCreate', ({ embed, COLORS: colors }) => embed({
    color: colors.success,
    title: '🔗 Invite created',
    description: `\`${invite.code}\``,
  }).addFields(
    { name: 'Inviter', value: invite.inviter ? `<@${invite.inviter.id}>` : 'Unknown', inline: true },
    { name: 'Channel', value: invite.channel ? `<#${invite.channel.id}>` : 'Unknown', inline: true },
    { name: 'Max uses', value: invite.maxUses ? String(invite.maxUses) : '∞', inline: true },
    { name: 'Expires', value: invite.expiresAt ? helpers.timestamp(invite.expiresAt, 'R') : 'Never', inline: true },
  ));
}

async function onInviteDelete(invite) {
  if (!invite.guild) return;
  await send(invite.client, invite.guild.id, 'inviteDelete', ({ embed, COLORS: colors }) => embed({
    color: colors.danger,
    title: '🔗 Invite deleted',
    description: `\`${invite.code}\``,
  }).addFields(
    { name: 'Channel', value: invite.channel ? `<#${invite.channel.id}>` : 'Unknown', inline: true },
  ));
}

// ---------------------------------------------------------------------------
// Voice events
// ---------------------------------------------------------------------------

async function onVoiceStateUpdate(before, after) {
  const guild = after.guild ?? before.guild;
  if (!guild) return;

  const member = after.member ?? before.member;
  if (!member || member.user?.bot) return;

  const joined = !before.channel && after.channel;
  const left = before.channel && !after.channel;
  const moved = before.channel && after.channel && before.channel.id !== after.channel.id;

  if (joined) {
    await send(guild.client, guild.id, 'voiceJoin', ({ embed, COLORS: colors }) => embed({
      color: colors.success,
      title: '🔊 Joined voice',
      description: `<@${member.id}> joined <#${after.channel.id}>`,
    }), { userId: member.id, channelId: after.channel.id });
    return;
  }

  if (left) {
    await send(guild.client, guild.id, 'voiceLeave', ({ embed, COLORS: colors }) => embed({
      color: colors.danger,
      title: '🔇 Left voice',
      description: `<@${member.id}> left <#${before.channel.id}>`,
    }), { userId: member.id, channelId: before.channel.id });
    return;
  }

  if (moved) {
    await send(guild.client, guild.id, 'voiceMove', ({ embed, COLORS: colors }) => embed({
      color: colors.info,
      title: '🔀 Moved voice channel',
      description: `<@${member.id}>`,
    }).addFields(
      { name: 'From', value: `<#${before.channel.id}>`, inline: true },
      { name: 'To', value: `<#${after.channel.id}>`, inline: true },
    ), { userId: member.id });
  }
}

// ---------------------------------------------------------------------------
// Scheduled events
// ---------------------------------------------------------------------------

async function onScheduledEventCreate(event) {
  await send(event.client, event.guildId, 'scheduledEventCreate', ({ embed, COLORS: colors }) => embed({
    color: colors.success,
    title: '📅 Scheduled event created',
    description: `**${event.name}**`,
  }).addFields(
    { name: 'Starts', value: helpers.timestamp(event.scheduledStartAt, 'R'), inline: true },
    { name: 'Creator', value: event.creator ? `<@${event.creator.id}>` : 'Unknown', inline: true },
  ));
}

async function onScheduledEventDelete(event) {
  await send(event.client, event.guildId, 'scheduledEventDelete', ({ embed, COLORS: colors }) => embed({
    color: colors.danger,
    title: '📅 Scheduled event deleted',
    description: `**${event.name}**`,
  }));
}

async function onScheduledEventUpdate(before, after) {
  const changes = [];
  if (before.name !== after.name) changes.push(`**Name**: ${before.name} → ${after.name}`);
  if (before.scheduledStartAt?.getTime() !== after.scheduledStartAt?.getTime()) {
    changes.push(`**Start**: ${helpers.timestamp(before.scheduledStartAt, 'R')} → ${helpers.timestamp(after.scheduledStartAt, 'R')}`);
  }
  if (before.status !== after.status) changes.push(`**Status**: ${before.status} → ${after.status}`);

  if (changes.length === 0) return;

  await send(after.client, after.guildId, 'scheduledEventUpdate', ({ embed, COLORS: colors }) => embed({
    color: colors.warning,
    title: '📅 Scheduled event updated',
    description: changes.join('\n'),
  }));
}

module.exports = {
  LOG_EVENTS,
  ALL_EVENTS,
  getConfig,
  setConfig,
  invalidate,
  send,
  findExecutor,
  resolveChannel,

  onMessage,
  onMessageDelete,
  onMessageUpdate,
  onMessageBulkDelete,
  onMemberAdd,
  onMemberRemove,
  onMemberUpdate,
  onChannelCreate,
  onChannelDelete,
  onChannelUpdate,
  onRoleCreate,
  onRoleDelete,
  onRoleUpdate,
  onBanAdd,
  onBanRemove,
  onModAction,
  onGuildUpdate,
  onEmojiUpdate,
  onInviteCreate,
  onInviteDelete,
  onVoiceStateUpdate,
  onScheduledEventCreate,
  onScheduledEventDelete,
  onScheduledEventUpdate,
  COLORS,
};
