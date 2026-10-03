'use strict';

/**
 * Leveling service.
 *
 * The XP curve itself lives in lib/constants (xpForLevel / levelFromXp) so the
 * value shown by /rank and the value used by the message event can never drift.
 *
 * Tables:
 *   levels        - per member XP and level
 *   level_rewards - role granted at a level
 */

const helpers = require('../../lib/helpers');
const logger = require('../../lib/logger');
const { xpForLevel, xpForNextLevel, levelFromXp } = require('../../lib/constants');

const log = logger.child('levels');

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A member's level row, or null when they have never gained XP. */
async function getUser(guildId, userId) {
  const db = require('../../db');
  return db.selectOne('levels', { where: { guild_id: guildId, user_id: userId }, optional: true });
}

/** Position on the leaderboard for a total XP value. */
async function rankOf(guildId, totalXp) {
  const db = require('../../db');
  return db.count('levels', {}, { optional: true }).then(async () => {
    // Count members with more total XP than this one.
    try {
      const { count, error } = await db.from('levels')
        .select('*', { count: 'exact', head: true })
        .eq('guild_id', guildId)
        .gt('total_xp', totalXp);
      if (error) throw error;
      return (count ?? 0) + 1;
    } catch (error) {
      log.warn('rank lookup failed:', error.message);
      return null;
    }
  });
}

/** A page of the leaderboard, highest total XP first. */
async function leaderboard(guildId, { limit = 10, offset = 0 } = {}) {
  const db = require('../../db');
  return db.select('levels', {
    where: { guild_id: guildId },
    order: { column: 'total_xp', ascending: false },
    limit,
    range: { from: offset, to: offset + limit - 1 },
    optional: true,
    fallback: [],
  });
}

/** Total number of ranked members. */
async function totalRanked(guildId) {
  const db = require('../../db');
  return db.count('levels', { guild_id: guildId }, { optional: true });
}

/** The guild's current configuration values relevant to levelling. */
function settings(guildConfig) {
  return {
    enabled: guildConfig.levels_enabled !== false,
    announceChannel: guildConfig.levels_announce_channel ?? null,
    baseXp: Number(guildConfig.levels_base_xp ?? 15),
    minXp: Number(guildConfig.levels_min_xp ?? 5),
    maxXp: Number(guildConfig.levels_max_xp ?? 25),
    cooldown: Number(guildConfig.levels_cooldown_secs ?? 60),
    stackRewards: guildConfig.levels_stack_rewards === true,
  };
}

/**
 * Compute the progress summary for a member.
 * @param {object|null} row
 */
function progress(row) {
  const totalXp = Number(row?.total_xp ?? 0);
  const level = row?.level ?? levelFromXp(totalXp);
  const currentFloor = xpForLevel(level);
  const nextLevelXp = xpForLevel(level + 1);

  const intoLevel = Math.max(0, totalXp - currentFloor);
  const needed = Math.max(1, nextLevelXp - currentFloor);

  return {
    totalXp,
    level,
    intoLevel,
    needed,
    nextLevelXp,
    xpForNext: xpForNextLevel(level),
    ratio: Math.min(1, intoLevel / needed),
    messages: Number(row?.messages ?? 0),
    voiceSeconds: Number(row?.voice_seconds ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Add XP to a member and return what changed.
 *
 * The row is upserted on (guild_id, user_id) so the first message from a new
 * member creates it atomically.
 *
 * @returns {Promise<{ levelUp: boolean, level: number, previousLevel: number, totalXp: number, profile: object }>}
 */
async function addXp(guildId, userId, amount) {
  const db = require('../../db');

  const existing = await getUser(guildId, userId);
  const previousTotal = Number(existing?.total_xp ?? 0);
  const previousLevel = existing?.level ?? levelFromXp(previousTotal);

  const totalXp = previousTotal + Math.max(0, Math.round(amount));
  const level = levelFromXp(totalXp);

  const row = await db.upsert('levels', {
    guild_id: guildId,
    user_id: userId,
    xp: totalXp,
    total_xp: totalXp,
    level,
    messages: Number(existing?.messages ?? 0) + 1,
    last_xp_at: new Date().toISOString(),
  }, 'guild_id,user_id').catch((error) => {
    log.warn('addXp failed:', error.message);
    return null;
  });

  return {
    levelUp: level > previousLevel,
    level,
    previousLevel,
    totalXp,
    profile: progress(row ?? { total_xp: totalXp, level }),
  };
}

/** Directly set a member's XP. */
async function setXp(guildId, userId, totalXp) {
  const db = require('../../db');
  const value = Math.max(0, Math.round(totalXp));
  const level = levelFromXp(value);

  return db.upsert('levels', {
    guild_id: guildId,
    user_id: userId,
    xp: value,
    total_xp: value,
    level,
  }, 'guild_id,user_id');
}

/** Reset a member's progress. */
async function resetUser(guildId, userId) {
  const db = require('../../db');
  return db.update('levels', { guild_id: guildId, user_id: userId }, {
    xp: 0,
    total_xp: 0,
    level: 0,
  });
}

/** Wipe a guild's leaderboard. */
async function resetGuild(guildId) {
  const db = require('../../db');
  return db.remove('levels', { guild_id: guildId });
}

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

/** Reward rows for a guild, lowest level first. */
async function rewards(guildId) {
  const db = require('../../db');
  return db.select('level_rewards', {
    where: { guild_id: guildId },
    order: { column: 'level', ascending: true },
    limit: 200,
    optional: true,
    fallback: [],
  });
}

/** Add or replace a reward at a level. */
async function addReward(guildId, level, roleId) {
  const db = require('../../db');
  return db.upsert('level_rewards', {
    guild_id: guildId,
    level,
    role_id: roleId,
  }, 'guild_id,level,role_id');
}

/** Remove a reward. */
async function removeReward(guildId, level, roleId) {
  const db = require('../../db');
  return db.remove('level_rewards', { guild_id: guildId, level, role_id });
}

/**
 * Apply any rewards the member has just become eligible for.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {number} level          the level just reached
 * @param {number} previousLevel
 * @param {object} config         levelling settings
 * @returns {Promise<Array<{ level: number, role: object }>>} roles granted
 */
async function applyRewards(member, level, previousLevel, config) {
  const rows = await rewards(member.guild.id);
  if (rows.length === 0) return [];

  const me = member.guild.members.me;
  const granted = [];

  for (const row of rows) {
    // Only rewards crossed on this level-up.
    if (row.level > level || row.level <= previousLevel) continue;

    const role = member.guild.roles.cache.get(row.role_id);
    if (!role) continue;
    if (!me || me.roles.highest.position <= role.position) {
      log.warn(`level reward ${role.id} is above my highest role in ${member.guild.id}`);
      continue;
    }
    if (member.roles.cache.has(role.id)) continue;

    // eslint-disable-next-line no-await-in-loop
    const done = await member.roles.add(role, `Level ${row.level} reward`)
      .then(() => true).catch((error) => error);

    if (done === true) granted.push({ level: row.level, role });
    else log.warn(`could not grant level reward ${role.id}:`, done?.message ?? done);
  }

  // When stacking is disabled, remove lower rewards now superseded.
  if (!config.stackRewards) {
    const superseded = rows
      .filter((row) => row.level < level)
      .sort((a, b) => b.level - a.level)
      .slice(1);

    for (const row of superseded) {
      if (!member.roles.cache.has(row.role_id)) continue;
      // eslint-disable-next-line no-await-in-loop
      await member.roles.remove(row.role_id, 'Replaced by a higher level reward').catch(() => {});
    }
  }

  return granted;
}

/** Remove every reward role the member holds (used by /levels reset). */
async function stripRewards(member) {
  const rows = await rewards(member.guild.id);
  const removed = [];

  for (const row of rows) {
    if (!member.roles.cache.has(row.role_id)) continue;
    // eslint-disable-next-line no-await-in-loop
    const done = await member.roles.remove(row.role_id, 'Progress reset')
      .then(() => true).catch(() => false);
    if (done) removed.push(row.role_id);
  }

  return removed;
}

/** XP range for a settings object, with sane ordering. */
function xpRange(config) {
  const min = Math.max(1, Number(config.minXp ?? 5));
  const max = Math.max(min, Number(config.maxXp ?? 25));
  return { min, max, base: Number(config.baseXp ?? 15) };
}

/** Roll a random XP amount for a message. */
function rollXp(config) {
  const { min, max } = xpRange(config);
  return helpers.randomInt(min, max);
}

module.exports = {
  getUser,
  rankOf,
  leaderboard,
  totalRanked,
  settings,
  progress,
  addXp,
  setXp,
  resetUser,
  resetGuild,
  rewards,
  addReward,
  removeReward,
  applyRewards,
  stripRewards,
  xpRange,
  rollXp,
};
