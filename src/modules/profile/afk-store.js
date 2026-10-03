'use strict';

/**
 * AFK store.
 *
 * Members can mark themselves away; the message event clears the status when
 * they speak and tells anyone who pinged an AFK member that they are away.
 *
 * Table: afk (guild_id, user_id unique)
 */

const logger = require('../../lib/logger');

const log = logger.child('afk');

/** Mark a member as AFK. */
async function set(guildId, userId, reason = 'AFK') {
  const db = require('../../db');
  return db.upsert('afk', {
    guild_id: guildId,
    user_id: userId,
    reason: String(reason).slice(0, 200) || 'AFK',
    set_at: new Date().toISOString(),
  }, 'guild_id,user_id');
}

/** Clear a member's AFK status. */
async function clear(guildId, userId) {
  const db = require('../../db');
  return db.remove('afk', { guild_id: guildId, user_id: userId });
}

/** A member's AFK row, or null. */
async function get(guildId, userId) {
  const db = require('../../db');
  return db.selectOne('afk', { where: { guild_id: guildId, user_id: userId }, optional: true });
}

/** How long ago the member went AFK, as a Discord relative timestamp. */
function since(row) {
  const helpers = require('../../lib/helpers');
  return row?.set_at ? helpers.timestamp(new Date(row.set_at), 'R') : 'recently';
}

/**
 * Handle a message for AFK purposes:
 *   1. tell anyone who pinged an AFK member that they are away
 *   2. clear the author's own AFK status and welcome them back
 *
 * @param {import('discord.js').Message} message
 * @returns {Promise<boolean>} whether the author was away
 */
async function clearOnSpeak(message) {
  const guildId = message.guild.id;
  const authorId = message.author.id;

  // ---- 1. mention notifications -----------------------------------------
  const mentioned = message.mentions?.users;
  if (mentioned && mentioned.size > 0) {
    const notifications = [];
    for (const user of mentioned.values()) {
      if (user.id === authorId || user.bot) continue;
      // eslint-disable-next-line no-await-in-loop
      const row = await get(guildId, user.id).catch(() => null);
      if (row) {
        notifications.push(`💤 **${user.username}** is AFK: ${row.reason} (${since(row)})`);
      }
    }

    if (notifications.length > 0) {
      await message.channel.send({ content: notifications.join('\n'), allowedMentions: { parse: [] } })
        .catch(() => {});
    }
  }

  // ---- 2. clearing the author -------------------------------------------
  const own = await get(guildId, authorId).catch(() => null);
  if (!own) return false;

  await clear(guildId, authorId).catch(() => {});

  await message.channel.send({
    content: `👋 Welcome back, **${message.author.username}** — I cleared your AFK status.`,
    allowedMentions: { parse: [] },
  }).catch((error) => log.debug('afk clear notice failed:', error.message));

  return true;
}

module.exports = { set, clear, get, since, clearOnSpeak };
