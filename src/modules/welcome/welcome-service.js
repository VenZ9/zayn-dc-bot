'use strict';

/**
 * Welcome & Goodbye service.
 *
 * Renders greeting messages and keeps autorole assignment in one place, so the
 * join event and `/welcome test` behave identically.
 *
 * Message placeholders:
 *   {user}        mention
 *   {user.tag}    username#0000 (or the new username)
 *   {user.name}   username
 *   {user.id}     snowflake
 *   {server}      guild name
 *   {count}       current member count
 *   {ordinal}     member count as 1st / 2nd / 3rd
 *   {created}     account creation date
 */

const { EmbedBuilder } = require('discord.js');
const helpers = require('../../lib/helpers');
const logger = require('../../lib/logger');
const config = require('../../config');
const { COLORS } = require('../../lib/constants');

const log = logger.child('welcome');

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

/** Ordinal suffix for a number: 1 -> 1st. */
function ordinal(number) {
  const value = Number(number);
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  switch (value % 10) {
    case 1: return `${value}st`;
    case 2: return `${value}nd`;
    case 3: return `${value}rd`;
    default: return `${value}th`;
  }
}

/** Replace placeholders in a template. */
function applyPlaceholders(template, values) {
  if (!template) return '';

  const map = {
    '{user}': values.mention ?? '',
    '{user.tag}': values.tag ?? '',
    '{user.name}': values.username ?? '',
    '{user.id}': values.id ?? '',
    '{server}': values.guildName ?? '',
    '{count}': values.memberCount !== undefined ? String(values.memberCount) : '',
    '{ordinal}': values.memberCount !== undefined ? ordinal(values.memberCount) : '',
    '{created}': values.createdAt ? helpers.timestamp(values.createdAt) : '',
  };

  let output = String(template);
  for (const [key, replacement] of Object.entries(map)) {
    output = output.split(key).join(replacement);
  }
  return output;
}

/** Build the placeholder bag for a member. */
function memberValues(member) {
  return {
    mention: `<@${member.id}>`,
    tag: member.user.tag ?? member.user.username,
    username: member.user.username,
    id: member.id,
    guildName: member.guild.name,
    memberCount: member.guild.memberCount,
    createdAt: member.user.createdAt,
  };
}

/** Build the placeholder bag for a user that has already left. */
function userValues(user, guild) {
  return {
    mention: `<@${user.id}>`,
    tag: user.tag ?? user.username,
    username: user.username,
    id: user.id,
    guildName: guild?.name ?? 'the server',
    memberCount: guild?.memberCount,
    createdAt: user.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Turn a stored message string into a sendable embed.
 *
 * A message that is only an image URL becomes a bare image embed; anything else
 * becomes a description. A literal `\n` in stored text is honoured.
 */
function render(template, values, options = {}) {
  const { defaultText = 'Welcome, {user}!', color = COLORS.success, imageUrl = null } = options;

  const text = applyPlaceholders(template || defaultText, values).replace(/\\n/g, '\n').trim();
  const embed = new EmbedBuilder().setColor(color);

  const isImage = /^https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?$/i.test(text);

  if (isImage) {
    embed.setImage(text);
  } else if (text) {
    embed.setDescription(helpers.truncate(text, 4000));
  }

  if (imageUrl && imageUrl !== text) embed.setImage(imageUrl);
  if (values.memberCount !== undefined) {
    embed.addFields({ name: 'Member count', value: helpers.formatNumber(values.memberCount), inline: true });
  }

  embed.setFooter({ text: config.brandFooterText });
  if (values.createdAt) embed.setTimestamp(new Date());

  return { embeds: [embed] };
}

/**
 * Send a welcome or goodbye message for a member.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {'welcome'|'goodbye'} kind
 * @param {object} guildConfig
 */
async function send(member, kind, guildConfig) {
  const enabled = kind === 'welcome' ? guildConfig.welcome_enabled : guildConfig.goodbye_enabled;
  if (!enabled) return { ok: false, reason: 'disabled' };

  const channelId = kind === 'welcome' ? guildConfig.welcome_channel : guildConfig.goodbye_channel;
  if (!channelId) return { ok: false, reason: 'no_channel' };

  const channel = member.guild.channels.cache.get(channelId)
    ?? await member.guild.channels.fetch(channelId).catch(() => null);

  if (!channel || !channel.isTextBased()) return { ok: false, reason: 'channel_missing' };

  const template = kind === 'welcome' ? guildConfig.welcome_message : guildConfig.goodbye_message;
  const imageUrl = kind === 'welcome' ? guildConfig.welcome_image : null;

  const payload = render(template, memberValues(member), {
    defaultText: kind === 'welcome'
      ? 'Welcome to **{server}**, {user}! You are member **#{count}**.'
      : '**{user.tag}** has left **{server}**.',
    color: kind === 'welcome' ? COLORS.success : COLORS.danger,
    imageUrl,
  });

  const sent = await channel.send({
    content: `<@${member.id}>`,
    embeds: payload.embeds,
    allowedMentions: { users: [member.id] },
  }).catch((error) => {
    log.warn(`${kind} message failed for ${member.id}:`, error.message);
    return null;
  });

  if (!sent) return { ok: false, reason: 'send_failed' };
  return { ok: true, message: sent };
}

/** Send the welcome DM, when enabled. */
async function sendDirectMessage(member, guildConfig) {
  if (!guildConfig.welcome_dm || !guildConfig.welcome_enabled) return { ok: false, reason: 'disabled' };

  const text = applyPlaceholders(
    guildConfig.welcome_message || 'Thanks for joining **{server}**!',
    memberValues(member),
  ).replace(/\\n/g, '\n');

  const sent = await member.send({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.brand)
        .setTitle(`Welcome to ${member.guild.name}`)
        .setDescription(helpers.truncate(text, 4000))
        .setThumbnail(member.guild.iconURL({ size: 256 }))
        .setFooter({ text: config.brandFooterText }),
    ],
  }).then(() => true).catch((error) => {
    log.debug(`welcome DM to ${member.id} failed:`, error.message);
    return false;
  });

  return { ok: sent };
}

// ---------------------------------------------------------------------------
// Autorole
// ---------------------------------------------------------------------------

/**
 * Apply the configured autorole to a new member.
 *
 * Silently does nothing when it is unset, the role is gone, or the bot's role
 * is not high enough - a failed autorole must never block a join.
 */
async function applyAutorole(member, guildConfig) {
  const roleId = guildConfig.autorole_id;
  if (!roleId) return { ok: false, reason: 'unset' };

  const role = member.guild.roles.cache.get(roleId);
  if (!role) return { ok: false, reason: 'role_missing' };

  const me = member.guild.members.me;
  if (!me || me.roles.highest.position <= role.position) {
    log.warn(`autorole ${roleId} sits above my highest role in ${member.guild.id}`);
    return { ok: false, reason: 'hierarchy' };
  }

  const done = await member.roles.add(role, 'Autorole on join').then(() => true).catch((error) => error);
  if (done !== true) return { ok: false, reason: done.message };

  return { ok: true, role };
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** Read the current welcome configuration in a stable shape. */
function currentConfig(guildConfig) {
  return {
    welcome: {
      enabled: guildConfig.welcome_enabled === true,
      channel: guildConfig.welcome_channel ?? null,
      message: guildConfig.welcome_message ?? null,
      image: guildConfig.welcome_image ?? null,
      dm: guildConfig.welcome_dm === true,
    },
    goodbye: {
      enabled: guildConfig.goodbye_enabled === true,
      channel: guildConfig.goodbye_channel ?? null,
      message: guildConfig.goodbye_message ?? null,
    },
    autorole: guildConfig.autorole_id ?? null,
  };
}

/** Helpers for rendering channel and role mentions safely in an embed. */
function describe(guild) {
  return {
    channelOf: (id) => (id
      ? (guild.channels.cache.has(id) ? `<#${id}>` : `\`${id}\` *(missing)*`)
      : '*not set*'),
    roleOf: (id) => (id
      ? (guild.roles.cache.has(id) ? `<@&${id}>` : `\`${id}\` *(missing)*`)
      : '*not set*'),
  };
}

module.exports = {
  ordinal,
  applyPlaceholders,
  memberValues,
  userValues,
  render,
  send,
  sendDirectMessage,
  applyAutorole,
  currentConfig,
  describe,
};
