'use strict';

/**
 * Timezone- and unit-aware formatting for the leveling and analytics modules.
 *
 * Kept separate from helpers.js because these functions are about *presenting*
 * a member's progress consistently across /rank, /leaderboard and announcements.
 */

const { xpForLevel, xpForNextLevel, levelFromXp } = require('./constants');
const helpers = require('./helpers');

/**
 * Summarise a member's XP into the values the UI needs.
 *
 * `xp` is the progress inside the current level, `totalXp` the lifetime total.
 * The level is always recomputed from `totalXp` so a stale or hand-edited level
 * column can never disagree with the XP bar.
 *
 * @param {number} totalXp
 * @returns {{ level: number, totalXp: number, levelXp: number, neededXp: number, progress: number, percent: number }}
 */
function progressFromXp(totalXp) {
  const safeTotal = Math.max(0, Math.floor(Number(totalXp) || 0));
  const level = levelFromXp(safeTotal);
  const floor = xpForLevel(level);
  const ceiling = xpForLevel(level + 1);
  const levelXp = safeTotal - floor;
  const neededXp = ceiling - floor;
  const percent = neededXp > 0 ? Math.min(100, Math.round((levelXp / neededXp) * 100)) : 0;

  return {
    level,
    totalXp: safeTotal,
    levelXp,
    neededXp,
    progress: percent / 100,
    percent,
    nextLevelXp: xpForNextLevel(level),
  };
}

/**
 * The visual XP bar used by /rank and level-up announcements.
 * @param {number} totalXp
 * @param {number} [size]
 */
function renderBar(totalXp, size = 14) {
  const { levelXp, neededXp, percent } = progressFromXp(totalXp);
  return `${helpers.progressBar(levelXp, neededXp, size)} **${percent}%**`;
}

/**
 * Rank title shown next to the level. Purely cosmetic.
 * @param {number} level
 */
function rankTitle(level) {
  const titles = [
    [0, 'Newcomer'],
    [5, 'Regular'],
    [10, 'Member'],
    [20, 'Active'],
    [30, 'Veteran'],
    [50, 'Elite'],
    [75, 'Master'],
    [100, 'Legend'],
  ];
  let title = titles[0][1];
  for (const [threshold, name] of titles) {
    if (level >= threshold) title = name;
  }
  return title;
}

/**
 * How much XP the next message should award.
 *
 * Uses the per-guild min/max from config so servers can tune the pace without
 * touching code. Values are clamped to sane bounds because they arrive from a
 * database row that a moderator could have set to something odd.
 *
 * @param {{ levels_min_xp?: number, levels_max_xp?: number }} guildConfig
 */
function rollXpForMessage(guildConfig = {}) {
  const min = helpers.clamp(Number(guildConfig.levels_min_xp) || 5, 1, 500);
  const max = helpers.clamp(Number(guildConfig.levels_max_xp) || 25, min, 1000);
  return helpers.randomInt(min, max);
}

/**
 * Should this message award XP, given the cooldown and the last award time?
 * @param {Date|string|null} lastXpAt
 * @param {number} cooldownSeconds
 */
function isXpEligible(lastXpAt, cooldownSeconds) {
  if (!lastXpAt) return true;
  const cooldownMs = Math.max(0, Number(cooldownSeconds) || 0) * 1000;
  if (cooldownMs === 0) return true;
  return Date.now() - new Date(lastXpAt).getTime() >= cooldownMs;
}

/**
 * Format a duration in seconds as "3h 12m" for voice stats.
 * @param {number} seconds
 */
function voiceTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  if (value < 60) return `${value}s`;
  return helpers.formatDuration(value, { units: 2 });
}

/**
 * Sort rows into leaderboard entries with the correct rank, handling ties.
 * @param {Array<{ user_id: string, total_xp: number, level: number }>} rows
 */
function toLeaderboard(rows, { offset = 0 } = {}) {
  let lastXp = null;
  let lastRank = 0;

  return rows.map((row, index) => {
    const xp = Number(row.total_xp) || 0;
    const rank = xp === lastXp ? lastRank : index + 1 + offset;
    lastXp = xp;
    lastRank = rank;

    return {
      rank,
      userId: row.user_id,
      totalXp: xp,
      level: levelFromXp(xp),
      medal: rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`,
    };
  });
}

/** Percentage as a whole number, guarding against divide-by-zero. */
function percent(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

/**
 * Change between two counts, as `+12 (5.2%)`.
 * @param {number} before
 * @param {number} after
 */
function delta(before, after) {
  const difference = after - before;
  if (difference === 0) return 'no change';
  const sign = difference > 0 ? '+' : '';
  if (before === 0) return `${sign}${helpers.formatNumber(difference)} (new)`;
  const pct = ((difference / before) * 100).toFixed(1);
  return `${sign}${helpers.formatNumber(difference)} (${sign}${pct}%)`;
}

/** Arrow indicating direction of change. */
function trendIcon(before, after) {
  if (after > before) return '📈';
  if (after < before) return '📉';
  return '➡️';
}

/** Abbreviate a big number: 1234 -> 1.2k */
function abbreviate(value) {
  const number = Number(value) || 0;
  if (Math.abs(number) < 1000) return String(number);
  if (Math.abs(number) < 1_000_000) return `${(number / 1000).toFixed(1)}k`;
  return `${(number / 1_000_000).toFixed(1)}m`;
}

module.exports = {
  progressFromXp,
  renderBar,
  rankTitle,
  rollXpForMessage,
  isXpEligible,
  voiceTime,
  toLeaderboard,
  percent,
  delta,
  trendIcon,
  abbreviate,
};
