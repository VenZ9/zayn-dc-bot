'use strict';

/**
 * Voice session tracker.
 *
 * Owns the authoritative record of who was in which voice channel, and turns
 * that into voice XP and analytics. The logging module sends the user-facing
 * embed; this file never sends anything.
 *
 * Sessions are stored in `voice_sessions` with `left_at = null` while open, so
 * a bot restart still knows who was connected and can close the row correctly.
 */

const logger = require('../../lib/logger');
const helpers = require('../../lib/helpers');

const log = logger.child('voice');

/** Minimum seconds a session must last before it counts, to ignore hopping. */
const MIN_SESSION_SECONDS = 30;

/** Voice XP awarded per minute of presence. */
const XP_PER_MINUTE = 3;

/**
 * Handle a voice state change: close the old session, open the new one.
 * @param {import('discord.js').VoiceState} before
 * @param {import('discord.js').VoiceState} after
 */
async function onVoiceStateUpdate(before, after) {
  const guild = after.guild ?? before.guild;
  if (!guild) return;

  const member = after.member ?? before.member;
  if (!member || member.user?.bot) return;

  const db = require('../../db');
  if (!db.isEnabled()) return;

  const beforeChannelId = before.channelId;
  const afterChannelId = after.channelId;

  if (beforeChannelId === afterChannelId) {
    // Same channel: mute / deafen / stream changes are not session events.
    return;
  }

  try {
    // ---- close the previous session ------------------------------------
    if (beforeChannelId) {
      await closeSession(guild.id, member.id, beforeChannelId);
    }

    // ---- open a new one -------------------------------------------------
    if (afterChannelId) {
      await db.insert('voice_sessions', {
        guild_id: guild.id,
        user_id: member.id,
        channel_id: afterChannelId,
        joined_at: new Date().toISOString(),
      });
    }
  } catch (error) {
    log.warn(`voice session update failed for ${member.id}: ${error.message}`);
  }
}

/**
 * Close an open session, record its length and award voice XP.
 *
 * The update is scoped to rows with `left_at` null, so a channel move cannot
 * close the same session twice.
 */
async function closeSession(guildId, userId, channelId) {
  const db = require('../../db');

  const open = await db.select('voice_sessions', {
    where: { guild_id: guildId, user_id: userId, channel_id: channelId, left_at: null },
    order: { column: 'joined_at', ascending: false },
    limit: 1,
    optional: true,
    fallback: [],
  });

  const session = open[0];
  if (!session) return;

  const joinedAt = new Date(session.joined_at).getTime();
  const seconds = Math.max(0, Math.round((Date.now() - joinedAt) / 1000));

  // Claim the row before counting it, so an overlapping update cannot double it.
  const claimed = await db.update(
    'voice_sessions',
    { id: session.id, left_at: null },
    { left_at: new Date().toISOString(), seconds },
  ).catch(() => []);

  if (claimed.length === 0) return;
  if (seconds < MIN_SESSION_SECONDS) return;

  // ---- analytics ---------------------------------------------------------
  await db.rpc('bump_analytics', {
    p_guild_id: guildId,
    p_day: helpers.today(),
    p_voice: seconds,
  }, { optional: true });

  await db.rpc('bump_member', {
    p_guild_id: guildId,
    p_user_id: userId,
    p_voice: seconds,
  }, { optional: true });

  // ---- voice XP ----------------------------------------------------------
  const xp = Math.floor((seconds / 60) * XP_PER_MINUTE);
  if (xp > 0) {
    try {
      const leveling = require('../levels/leveling');
      await leveling.awardVoiceXp(guildId, userId, xp);
    } catch (error) {
      log.debug(`voice xp failed for ${userId}: ${error.message}`);
    }
  }
}

/**
 * Close every open session for a member, e.g. when they leave the guild.
 * @param {string} guildId
 * @param {string} userId
 */
async function closeForUser(guildId, userId) {
  const db = require('../../db');
  if (!db.isEnabled()) return;

  const open = await db.select('voice_sessions', {
    where: { guild_id: guildId, user_id: userId, left_at: null },
    optional: true,
    fallback: [],
  });

  for (const session of open) {
    await closeSession(guildId, userId, session.channel_id);
  }
}

/**
 * Close sessions left open by a restart.
 *
 * Called on boot: any row still open belongs to a previous process, and its
 * duration is not knowable, so it is closed at its join time rather than
 * credited with the whole downtime.
 *
 * @param {import('discord.js').Client} client
 */
async function reconcileOnBoot(client) {
  const db = require('../../db');
  if (!db.isEnabled()) return;

  const open = await db.select('voice_sessions', {
    where: { left_at: null },
    limit: 500,
    optional: true,
    fallback: [],
  });

  if (open.length === 0) return;

  let closed = 0;
  for (const session of open) {
    await db.update('voice_sessions', { id: session.id }, {
      left_at: session.joined_at,
      seconds: 0,
    }).catch(() => {});
    closed += 1;
  }

  log.info(`closed ${closed} voice session(s) left open by a previous run`);
  void client;
}

module.exports = {
  onVoiceStateUpdate,
  closeSession,
  closeForUser,
  reconcileOnBoot,
  XP_PER_MINUTE,
  MIN_SESSION_SECONDS,
};
