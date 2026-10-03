'use strict';

/**
 * Custom command + autoresponder engine.
 *
 * The message handler calls `handleMessage` before treating a message as an
 * unknown command, so this is where guild-defined text triggers are answered.
 *
 * Order of business:
 *   1. If the message is a prefixed custom command, run it (respecting
 *      permissions and the per-user cooldown).
 *   2. Otherwise check autoresponders, first match wins.
 *
 * Returns true when it produced a reply, so the caller does not also report
 * "unknown command".
 */

const helpers = require('../../lib/helpers');
const logger = require('../../lib/logger');
const custom = require('./custom-command-service');
const autoresponders = require('../autoresponders/autoresponder-service');

const log = logger.child('custom-engine');

/**
 * Handle a message against custom commands and autoresponders.
 *
 * @param {import('discord.js').Message} message
 * @returns {Promise<boolean>} whether a reply was sent
 */
async function handleMessage(message) {
  if (!message.guild || message.author?.bot) return false;

  const content = message.content?.trim() ?? '';
  if (content.length === 0) return false;

  const db = require('../../db');

  // ---- 1. prefixed custom command ---------------------------------------
  try {
    const prefixInfo = await db.getPrefix(message.guild.id);

    if (prefixInfo.enabled && content.startsWith(prefixInfo.prefix)) {
      const withoutPrefix = content.slice(prefixInfo.prefix.length).trim();
      const [first, ...rest] = withoutPrefix.split(/\s+/);

      if (first) {
        const command = await custom.match(message.guild.id, first);

        if (command && command.enabled !== false) {
          const member = message.member
            ?? await message.guild.members.fetch(message.author.id).catch(() => null);

          if (member) {
            const permitted = custom.canUse(command, member, message.channelId);

            if (!permitted.ok) {
              // Silent: a denied custom command is not worth a public error.
              return true;
            }

            const remaining = await custom.cooldownRemaining(command, member.id);
            if (remaining > 0) {
              return true;
            }

            const response = custom.buildResponse(command.response, {
              userId: member.id,
              username: member.user.tag ?? member.user.username,
              guildName: message.guild.name,
              channelId: message.channelId,
              memberCount: message.guild.memberCount,
              args: rest.join(' '),
            });

            const ok = await sendCommandReply(message, command, response);
            if (ok) {
              await custom.recordUse(command, message.guild.id, member.id);
              await custom.bumpUses(message.guild.id, command.name, command.uses);
            }
            return true;
          }
        }
      }
    }
  } catch (error) {
    log.error('custom command handling failed:', error);
  }

  // ---- 2. autoresponders -------------------------------------------------
  try {
    const handled = await runAutoresponders(message);
    if (handled) return true;
  } catch (error) {
    log.error('autoresponder handling failed:', error);
  }

  return false;
}

/** Send a custom command's reply, as an embed or plain text. */
async function sendCommandReply(message, command, response) {
  if (!response) return false;

  if (command.embed) {
    const embeds = require('../../lib/embeds');
    const sent = await message.channel.send({
      embeds: [embeds.embed({ description: helpers.truncate(response, 4000) })],
      allowedMentions: { parse: [] },
    }).catch((error) => {
      log.debug('custom embed reply failed:', error.message);
      return null;
    });
    return Boolean(sent);
  }

  const sent = await message.channel.send({
    content: helpers.truncate(response, 2000),
    allowedMentions: { parse: [] },
  }).catch((error) => {
    log.debug('custom reply failed:', error.message);
    return null;
  });

  return Boolean(sent);
}

/** Check every enabled autoresponder; the first match replies. */
async function runAutoresponders(message) {
  const db = require('../../db');

  const rows = await db.select('autoresponders', {
    where: { guild_id: message.guild.id, enabled: true },
    limit: 200,
    optional: true,
    fallback: [],
  });

  if (rows.length === 0) return false;

  const member = message.member
    ?? await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return false;

  for (const row of rows) {
    // eslint-disable-next-line no-continue
    if (!autoresponders.matches(row, message.content)) continue;
    // eslint-disable-next-line no-continue
    if (!autoresponders.allowed(row, member, message.channelId)) continue;

    const response = custom.buildResponse(row.response, {
      userId: member.id,
      username: member.user.tag ?? member.user.username,
      guildName: message.guild.name,
      channelId: message.channelId,
      memberCount: message.guild.memberCount,
      args: '',
    });

    if (!response) continue;

    // eslint-disable-next-line no-await-in-loop
    const sent = await message.channel.send({
      content: helpers.truncate(response, 2000),
      allowedMentions: { parse: [] },
    }).catch((error) => {
      log.debug('autoresponder reply failed:', error.message);
      return null;
    });

    if (sent) {
      await autoresponders.bumpUses(row.id, row.uses);
      return true;
    }
  }

  return false;
}

module.exports = { handleMessage, runAutoresponders };
