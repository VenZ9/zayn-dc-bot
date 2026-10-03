'use strict';

/**
 * Profile store.
 *
 * Backs the user profile module: bio, badges, birthday, timezone, privacy and
 * reputation. The `profiles` table is global (one row per user, not per guild).
 *
 * Tables:
 *   profiles    - bio, badges, birthday, timezone, privacy, reputation
 *   reputation  - individual rep gifts, per guild
 */

const logger = require('../../lib/logger');
const { BADGES } = require('../../lib/constants');

const log = logger.child('profiles');

/** Default privacy flags for a new profile. */
const DEFAULT_PRIVACY = Object.freeze({
  profile: true,
  bio: true,
  birthday: false,
  stats: true,
  badges: true,
});

/** Fetch a profile row, or null. */
async function get(userId) {
  const db = require('../../db');
  return db.selectOne('profiles', { where: { user_id: userId }, optional: true });
}

/** Fetch a profile, creating a default row when none exists. */
async function ensure(userId) {
  const db = require('../../db');
  const existing = await get(userId);
  if (existing) return existing;

  const created = await db.upsert('profiles', {
    user_id: userId,
    badges: [],
    privacy: { ...DEFAULT_PRIVACY },
  }, 'user_id').catch((error) => {
    log.error('profile create failed:', error);
    return null;
  });

  return created ?? { user_id: userId, badges: [], privacy: { ...DEFAULT_PRIVACY } };
}

/** Patch a profile. */
async function update(userId, patch) {
  const db = require('../../db');
  await ensure(userId);
  const rows = await db.update('profiles', { user_id: userId }, patch).catch(() => []);
  return rows[0] ?? get(userId);
}

/** Add a badge if the member does not already hold it. */
async function addBadge(userId, badge) {
  if (!BADGES[badge]) return null;

  const profile = await ensure(userId);
  const badges = new Set(Array.isArray(profile.badges) ? profile.badges : []);
  if (badges.has(badge)) return profile;

  badges.add(badge);
  return update(userId, { badges: Array.from(badges) });
}

/** Remove a badge. */
async function removeBadge(userId, badge) {
  const profile = await ensure(userId);
  const badges = (Array.isArray(profile.badges) ? profile.badges : []).filter((entry) => entry !== badge);
  return update(userId, { badges });
}

/** Set a single privacy flag. */
async function setPrivacy(userId, key, value) {
  const profile = await ensure(userId);
  const privacy = { ...DEFAULT_PRIVACY, ...(profile.privacy ?? {}) };
  if (!(key in DEFAULT_PRIVACY)) return { ok: false, error: `${key} is not a privacy setting.` };

  privacy[key] = value === true;
  await update(userId, { privacy });
  return { ok: true, privacy };
}

/** Should a field be shown to other members? */
function visible(profile, key) {
  const privacy = { ...DEFAULT_PRIVACY, ...(profile?.privacy ?? {}) };
  return privacy[key] !== false;
}

// ---------------------------------------------------------------------------
// Reputation
// ---------------------------------------------------------------------------

/** Give reputation from one member to another. */
async function giveReputation(guildId, giverId, targetId, reason = null) {
  const db = require('../../db');

  if (giverId === targetId) return { ok: false, error: 'You cannot give reputation to yourself.' };

  // One gift per giver/target pair per day.
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const recent = await db.select('reputation', {
    where: { guild_id: guildId, giver_id: giverId, target_id: targetId },
    order: { column: 'created_at', ascending: false },
    limit: 1,
    optional: true,
    fallback: [],
  });

  if (recent[0] && new Date(recent[0].created_at) >= dayStart) {
    return { ok: false, error: 'You have already given them reputation today.' };
  }

  await db.insert('reputation', {
    guild_id: guildId,
    giver_id: giverId,
    target_id: targetId,
    reason: reason ? String(reason).slice(0, 200) : null,
  });

  // Keep the cached total on the profile in step.
  const profile = await ensure(targetId);
  const total = Number(profile.reputation ?? 0) + 1;
  await update(targetId, { reputation: total });

  return { ok: true, total };
}

/** How much reputation a member has received in a guild. */
async function reputationCount(guildId, targetId) {
  const db = require('../../db');
  return db.count('reputation', { guild_id: guildId, target_id: targetId }, { optional: true });
}

/** Recent reputation gifts for a member. */
async function reputationHistory(guildId, targetId, limit = 5) {
  const db = require('../../db');
  return db.select('reputation', {
    where: { guild_id: guildId, target_id: targetId },
    order: { column: 'created_at', ascending: false },
    limit,
    optional: true,
    fallback: [],
  });
}

module.exports = {
  DEFAULT_PRIVACY,
  get,
  ensure,
  update,
  addBadge,
  removeBadge,
  setPrivacy,
  visible,
  giveReputation,
  reputationCount,
  reputationHistory,
};
