'use strict';

/**
 * messageCreate - the busiest event in the bot.
 *
 * Order matters here. Each step short-circuits the next:
 *
 *   1. ignore bots / DMs / webhooks
 *   2. clear the author's AFK status if they speak (and tell anyone who pinged them)
 *   3. custom commands + autoresponders
 *   4. prefix command
 *   5. XP award (only when the message is not a command)
 *   6. analytics counters
 *   7. logging
 *
 * XP deliberately runs last so a message that triggered a command does not also
 * earn XP - otherwise `.rank` spam would be a levelling exploit.
 */

const logger = require('../lib/logger');
const prefix = require('../core/prefix');
const helpers = require('../lib/helpers');
const embeds = require('../lib/embeds');

const log = logger.child('message');

module.exports = {
  name: 'messageCreate',
  async execute(client, message) {
    // ---- 1. guard --------------------------------------------------------
    if (!message || !message.guild) return;
    if (message.author?.bot || message.webhookId || message.system) return;
    if (!message.content && message.attachments.size === 0) return;

    const guildId = message.guild.id;
    const userId = message.author.id;

    // ---- 2. AFK ----------------------------------------------------------
    let wasAfk = false;
    try {
      const afk = require('../modules/profile/afk-store');
      wasAfk = await afk.clearOnSpeak(message);
    } catch (error) {
      log.debug('afk clear failed:', error.message);
    }

    // ---- 3. custom commands + autoresponders ------------------------------
    let handledByCustom = false;
    if (message.content) {
      try {
        const custom = require('../modules/custom/custom-engine');
        handledByCustom = await custom.handleMessage(message);
      } catch (error) {
        log.error('custom command engine failed:', error);
      }
    }

    // ---- 4. prefix command ------------------------------------------------
    let handledByPrefix = false;
    if (!handledByCustom) {
      try {
        const result = await prefix.handleMessage(message, client.registry);
        handledByPrefix = result.handled;
        if (!result.handled && result.reason === 'unknown') {
          // Looks like a command attempt but nothing matched. Stay quiet -
          // suggesting a correction on every typo would be noisy.
          log.debug(`unknown prefix command "${result.name}" from ${userId}`);
        }
      } catch (error) {
        log.error('prefix runner failed:', error);
      }
    }

    const isCommand = handledByCustom || handledByPrefix;

    // ---- 5. XP ------------------------------------------------------------
    if (!isCommand) {
      try {
        const leveling = require('../modules/levels/leveling');
        await leveling.awardMessageXp(message);
      } catch (error) {
        log.error('xp award failed:', error);
      }
    }

    // ---- 6. analytics -----------------------------------------------------
    // Skip analytics for commands (they are counted separately) but always
    // count the message itself.
    try {
      await bumpCounters(guildId, message.channel.id, userId);
    } catch (error) {
      log.debug('analytics bump failed:', error.message);
    }

    // ---- 7. logging -------------------------------------------------------
    try {
      const logging = require('../modules/logs/logger');
      await logging.onMessage(message);
    } catch (error) {
      log.error('message logging failed:', error);
    }

    void wasAfk; // handled inside the afk store
    void embeds;
    void helpers;
  },
};

/**
 * Increment the guild, channel and member counters in one round trip each.
 * Failures are swallowed by the caller - analytics must never break chat.
 */
async function bumpCounters(guildId, channelId, userId) {
  const db = require('../db');
  if (!db.isEnabled()) return;

  await Promise.all([
    db.rpc('bump_analytics', {
      p_guild_id: guildId,
      p_day: helpers.today(),
      p_messages: 1,
    }, { optional: true }),
    db.rpc('bump_channel', {
      p_guild_id: guildId,
      p_channel_id: channelId,
      p_messages: 1,
    }, { optional: true }),
    db.rpc('bump_member', {
      p_guild_id: guildId,
      p_user_id: userId,
      p_messages: 1,
    }, { optional: true }),
  ]);
}
