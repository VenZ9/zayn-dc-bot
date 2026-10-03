'use strict';

/**
 * Invite attribution.
 *
 * Determines who invited a new member by diffing the guild's invite uses before
 * and after the join. Discord gives no "invited by" field, so this diff is the
 * only reliable way.
 *
 * The "before" snapshot is taken by `prime()` (called on ready) and refreshed
 * after every join, so the comparison is always against the immediately
 * preceding state.
 */

const logger = require('../../lib/logger');

const log = logger.child('invites');

/** @type {Map<string, Map<string, number>>} guildId -> (invite code -> uses) */
const snapshot = new Map();

/** Cache a guild's current invite uses. */
async function prime(guild) {
  if (!guild) return;
  try {
    const invites = await guild.invites.fetch();
    const map = new Map();
    for (const invite of invites.values()) {
      map.set(invite.code, invite.uses ?? 0);
    }
    snapshot.set(guild.id, map);
    log.debug(`primed ${map.size} invite(s) for ${guild.name}`);
  } catch (error) {
    // Missing Manage Server permission lands here - not fatal.
    log.debug(`could not prime invites for ${guild.id}: ${error.message}`);
    snapshot.set(guild.id, new Map());
  }
}

/** Prime every guild the bot is in. Called once on ready. */
async function primeAll(client) {
  for (const guild of client.guilds.cache.values()) {
    await prime(guild);
  }
}

/**
 * Attribute a join to an invite and persist the updated use count.
 * @param {import('discord.js').GuildMember} member
 */
async function onMemberAdd(member) {
  const guild = member.guild;
  const previous = snapshot.get(guild.id);

  // Refresh the live list. If this fails we cannot attribute, so bail quietly.
  let current;
  try {
    current = await guild.invites.fetch();
  } catch (error) {
    log.debug(`invite fetch failed for ${guild.id}: ${error.message}`);
    return;
  }

  let usedInvite = null;

  if (previous && previous.size > 0) {
    for (const invite of current.values()) {
      const was = previous.get(invite.code) ?? 0;
      if ((invite.uses ?? 0) > was) {
        usedInvite = invite;
        break;
      }
    }
  }

  // A brand new code that was not in the snapshot also counts.
  if (!usedInvite && previous) {
    for (const invite of current.values()) {
      if (!previous.has(invite.code)) {
        usedInvite = invite;
        break;
      }
    }
  }

  // ---- persist -----------------------------------------------------------
  const db = require('../../db');
  const nextMap = new Map();
  for (const invite of current.values()) nextMap.set(invite.code, invite.uses ?? 0);
  snapshot.set(guild.id, nextMap);

  if (!usedInvite) {
    log.debug(`no invite attributed for ${member.user.tag ?? member.id}`);
    return;
  }

  try {
    const existing = await db.selectOne('invites', {
      where: { guild_id: guild.id, code: usedInvite.code },
      optional: true,
    });

    await db.upsert('invites', {
      guild_id: guild.id,
      code: usedInvite.code,
      inviter_id: usedInvite.inviter?.id ?? existing?.inviter_id ?? null,
      uses: usedInvite.uses ?? 0,
      max_uses: usedInvite.maxUses ?? null,
    }, 'guild_id,code');
  } catch (error) {
    log.debug(`invite persist failed: ${error.message}`);
  }

  // Expose the attribution for the welcome message.
  member.client.inviteCache = member.client.inviteCache || new Map();
  member.client.inviteCache.set(`${guild.id}:${member.id}`, {
    code: usedInvite.code,
    inviterId: usedInvite.inviter?.id ?? null,
    at: Date.now(),
  });
}

/** Record invite creation/deletion so the snapshot stays accurate. */
async function refresh(guild) {
  await prime(guild);
}

/**
 * Look up the recorded inviter for a member.
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {string} userId
 */
function getAttribution(client, guildId, userId) {
  return client.inviteCache?.get(`${guildId}:${userId}`) ?? null;
}

/** Invite stats for /invites. */
async function getStats(guild) {
  const db = require('../../db');

  const stored = await db.select('invites', {
    where: { guild_id: guild.id },
    order: { column: 'uses', ascending: false },
    limit: 50,
    optional: true,
    fallback: [],
  });

  const live = await guild.invites.fetch().catch(() => null);

  return stored.map((row) => ({
    code: row.code,
    uses: row.uses,
    maxUses: row.max_uses,
    inviterId: row.inviter_id,
    url: `https://discord.gg/${row.code}`,
    // Prefer the live count when the invite still exists.
    liveUses: live?.get(row.code)?.uses ?? null,
  }));
}

module.exports = {
  prime,
  primeAll,
  refresh,
  onMemberAdd,
  getAttribution,
  getStats,
  snapshot,
};
