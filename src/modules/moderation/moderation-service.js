'use strict';

/**
 * Moderation service.
 *
 * All the shared mechanics for moderation: creating cases with sequential
 * numbers, applying actions, and lifting temporary ones. Commands are thin -
 * they validate input and call in here.
 *
 * Every action produces exactly one case row. That is what makes `/case`,
 * `/history` and `/modlogs` trustworthy.
 */

const { PermissionFlagsBits } = require('discord.js');
const logger = require('../../lib/logger');
const helpers = require('../../lib/helpers');
const embeds = require('../../lib/embeds');

const log = logger.child('moderation');

// ---------------------------------------------------------------------------
// Case numbers
// ---------------------------------------------------------------------------

/**
 * Allocate the next case number for a guild.
 *
 * Uses the `next_case_number` SQL function so the read and the insert happen
 * inside one transaction - two moderators acting at the same instant cannot be
 * handed the same number.
 *
 * @param {string} guildId
 */
async function nextCaseNumber(guildId) {
  const db = require('../../db');
  const value = await db.rpc('next_case_number', { p_guild_id: guildId }, { optional: true, fallback: null });

  if (typeof value === 'number' && Number.isFinite(value)) return value;

  // Fallback for a database that has not had schema.sql run yet.
  const existing = await db.count('mod_cases', { guild_id: guildId }, { optional: true });
  return existing + 1;
}

// ---------------------------------------------------------------------------
// Case creation
// ---------------------------------------------------------------------------

/**
 * Record a moderation action.
 *
 * @param {object} params
 * @param {import('discord.js').Guild} params.guild
 * @param {string} params.action
 * @param {import('discord.js').User|import('discord.js').GuildMember} params.target
 * @param {import('discord.js').User|import('discord.js').GuildMember} params.moderator
 * @param {string} [params.reason]
 * @param {number} [params.duration]      seconds, for temporary actions
 * @param {boolean} [params.active]       false for actions with nothing to lift
 * @param {object} [params.metadata]
 * @param {string} [params.source]
 * @returns {Promise<object|null>} the created case
 */
async function createCase(params) {
  const {
    guild, action, target, moderator, reason, duration, active = true, metadata = {}, source = 'slash',
  } = params;

  const db = require('../../db');

  const caseNumber = await nextCaseNumber(guild.id);
  const expiresAt = duration ? new Date(Date.now() + duration * 1000).toISOString() : null;

  const row = {
    guild_id: guild.id,
    case_number: caseNumber,
    action,
    target_id: target.id,
    target_tag: target.tag ?? target.user?.tag ?? target.username ?? null,
    moderator_id: moderator.id,
    moderator_tag: moderator.tag ?? moderator.user?.tag ?? moderator.username ?? null,
    reason: reason ? helpers.truncate(reason, 1000) : null,
    duration: duration ?? null,
    expires_at: expiresAt,
    active,
    metadata,
  };

  let created = null;
  try {
    created = await db.insert('mod_cases', row);
  } catch (error) {
    log.error(`could not record case for ${action}:`, error);
    return null;
  }

  // ---- analytics ---------------------------------------------------------
  if (created) {
    try {
      const cfg = await db.getGuildConfig(guild.id);
      if (cfg.modlog_enabled !== false) {
        const logging = require('../logs/logger');
        await logging.onModAction(guild, {
          action,
          target: `${target.tag ?? target.username ?? target.id} (<@${target.id}>)`,
          moderator: `<@${moderator.id}>`,
          reason,
          caseNumber,
          duration,
          extra: metadata?.notes,
        });
      }

      await db.rpc('bump_analytics', {
        p_guild_id: guild.id,
        p_day: helpers.today(),
      }, { optional: true });

      await db.writeAudit({
        guildId: guild.id,
        actorId: moderator.id,
        actorTag: moderator.tag ?? moderator.username,
        action: `mod.${action}`,
        targetType: 'user',
        targetId: target.id,
        details: { caseNumber, reason, duration },
        source,
      });
    } catch (error) {
      log.debug('case side-effects failed:', error.message);
    }
  }

  return created;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Ban a member, with an optional duration for a tempban.
 * @returns {Promise<{ ok: boolean, error?: string, case?: object }>}
 */
async function ban(guild, target, moderator, { reason, duration, deleteMessageSeconds = 0, source = 'slash' } = {}) {
  // ---- already banned? --------------------------------------------------
  const existingBan = await guild.bans.fetch(target.id).catch(() => null);
  if (existingBan) {
    return { ok: false, error: 'That user is already banned.' };
  }

  try {
    await guild.bans.create(target.id, {
      reason: auditReason(moderator, reason, duration),
      deleteMessageSeconds: helpers.clamp(Number(deleteMessageSeconds) || 0, 0, 604800),
    });
  } catch (error) {
    return { ok: false, error: `Discord refused the ban: ${error.message}` };
  }

  const created = await createCase({
    guild,
    action: duration ? 'tempban' : 'ban',
    target,
    moderator,
    reason,
    duration,
    active: Boolean(duration),
    metadata: { delete_message_seconds: deleteMessageSeconds },
    source,
  });

  return { ok: true, case: created };
}

/**
 * Kick a member.
 */
async function kick(guild, member, moderator, { reason, source = 'slash' } = {}) {
  try {
    await member.kick(auditReason(moderator, reason));
  } catch (error) {
    return { ok: false, error: `Discord refused the kick: ${error.message}` };
  }

  const created = await createCase({
    guild,
    action: 'kick',
    target: member.user ?? member,
    moderator,
    reason,
    active: false,
    source,
  });

  return { ok: true, case: created };
}

/**
 * Time a member out.
 *
 * `until` is omitted on purpose: discord.js v14.16 deprecates it in favour of
 * the duration string, and passing both is an error.
 *
 * @param {number} duration seconds, 1 to 2419200 (28 days)
 */
async function mute(guild, member, moderator, { reason, duration = 600, source = 'slash' } = {}) {
  const seconds = helpers.clamp(Number(duration) || 600, 1, 2_419_200);

  try {
    await member.timeout(seconds * 1000, auditReason(moderator, reason));
  } catch (error) {
    return { ok: false, error: `Discord refused the timeout: ${error.message}` };
  }

  const created = await createCase({
    guild,
    action: 'mute',
    target: member.user ?? member,
    moderator,
    reason,
    duration: seconds,
    active: true,
    source,
  });

  return { ok: true, case: created, duration: seconds };
}

/** Remove a timeout. */
async function unmute(guild, member, moderator, { reason, source = 'slash' } = {}) {
  if (!member.isCommunicationDisabled?.()) {
    return { ok: false, error: 'That member is not currently timed out.' };
  }

  try {
    await member.timeout(null, auditReason(moderator, reason));
  } catch (error) {
    return { ok: false, error: `Discord refused to remove the timeout: ${error.message}` };
  }

  // Resolve the open mute case so /history shows it as lifted.
  const db = require('../../db');
  const open = await db.select('mod_cases', {
    where: { guild_id: guild.id, target_id: member.id, action: 'mute', active: true },
    limit: 10,
    optional: true,
    fallback: [],
  });
  for (const row of open) {
    await db.update('mod_cases', { id: row.id }, {
      active: false,
      resolved: true,
      resolved_by: moderator.id,
      resolved_at: new Date().toISOString(),
    }).catch(() => {});
  }

  const created = await createCase({
    guild,
    action: 'unmute',
    target: member.user ?? member,
    moderator,
    reason,
    active: false,
    source,
  });

  return { ok: true, case: created };
}

/** Warn a member. */
async function warn(guild, target, moderator, { reason, source = 'slash' } = {}) {
  const created = await createCase({
    guild,
    action: 'warn',
    target,
    moderator,
    reason,
    active: false,
    source,
  });

  if (!created) return { ok: false, error: 'The warning could not be saved.' };
  return { ok: true, case: created };
}

// ---------------------------------------------------------------------------
// Lifting temporary actions
// ---------------------------------------------------------------------------

/**
 * Remove a temporary ban when its time expires. Called by the scheduler.
 * @param {import('discord.js').Client} client
 * @param {object} row a mod_cases row
 */
async function liftTempban(client, row) {
  const guild = await client.guilds.fetch(row.guild_id).catch(() => null);
  if (!guild) return;

  const removed = await guild.bans.remove(row.target_id, 'Temporary ban expired').then(() => true).catch(() => false);
  if (!removed) {
    log.warn(`could not lift tempban ${row.id} for ${row.target_id} (already unbanned?)`);
  }

  const db = require('../../db');
  await db.update('mod_cases', { id: row.id }, {
    active: false,
    resolved: true,
    resolved_at: new Date().toISOString(),
    metadata: { ...(row.metadata || {}), lifted_by: 'scheduler' },
  }).catch(() => {});

  log.info(`tempban lifted for ${row.target_id} in ${row.guild_id}`);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Fetch a single case by number.
 * @param {string} guildId
 * @param {number} caseNumber
 */
async function getCase(guildId, caseNumber) {
  const db = require('../../db');
  return db.selectOne('mod_cases', {
    where: { guild_id: guildId, case_number: Number(caseNumber) },
    optional: true,
  });
}

/** A member's full moderation history, newest first. */
async function getHistory(guildId, userId, { limit = 25, actions = null } = {}) {
  const db = require('../../db');
  const where = { guild_id: guildId, target_id: userId };
  const rows = await db.select('mod_cases', {
    where,
    order: { column: 'created_at', ascending: false },
    limit: limit * 2,
    optional: true,
    fallback: [],
  });

  const filtered = actions && actions.length > 0
    ? rows.filter((row) => actions.includes(row.action))
    : rows;

  return filtered.slice(0, limit);
}

/** Counts per action, for /history and /warnings summaries. */
function summarise(cases) {
  const counts = {};
  for (const row of cases) {
    counts[row.action] = (counts[row.action] || 0) + 1;
  }
  return counts;
}

/** Active warnings for a member. */
async function getActiveWarnings(guildId, userId) {
  const db = require('../../db');
  return db.select('mod_cases', {
    where: { guild_id: guildId, target_id: userId, action: 'warn', resolved: false },
    order: { column: 'created_at', ascending: false },
    limit: 100,
    optional: true,
    fallback: [],
  });
}

/** Mark warnings as resolved (used by /clearwarns). */
async function clearWarnings(guildId, userId, moderator, { ids = null } = {}) {
  const db = require('../../db');
  const where = { guild_id: guildId, target_id: userId, action: 'warn', resolved: false };
  const warnings = await db.select('mod_cases', { where, limit: 200, optional: true, fallback: [] });

  const targets = ids
    ? warnings.filter((row) => ids.includes(row.case_number))
    : warnings;

  let cleared = 0;
  for (const row of targets) {
    const updated = await db.update('mod_cases', { id: row.id }, {
      resolved: true,
      resolved_by: moderator.id,
      resolved_at: new Date().toISOString(),
    }).catch(() => []);
    if (updated.length > 0) cleared += 1;
  }

  if (cleared > 0) {
    await createCase({
      guild: { id: guildId },
      action: 'clearwarns',
      target: { id: userId, tag: null, username: null },
      moderator,
      reason: `Cleared ${cleared} warning(s)`,
      active: false,
    });
  }

  return { cleared, total: warnings.length };
}

/**
 * Update the reason on an existing case.
 * @param {string} guildId
 * @param {number} caseNumber
 * @param {string} reason
 * @param {import('discord.js').User} moderator
 */
async function setReason(guildId, caseNumber, reason, moderator) {
  const db = require('../../db');
  const existing = await getCase(guildId, caseNumber);
  if (!existing) return null;

  const updated = await db.update('mod_cases', { id: existing.id }, {
    reason: helpers.truncate(reason, 1000),
    metadata: { ...(existing.metadata || {}), reason_edited_by: moderator.id, reason_edited_at: new Date().toISOString() },
  });

  return updated[0] ?? null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Emoji for a case action, shared with the logger. */
const ACTION_EMOJI = Object.freeze({
  ban: '🔨', tempban: '⏳', unban: '🔓', kick: '👢', mute: '🔇', unmute: '🔊',
  warn: '⚠️', clearwarns: '🧹', purge: '🗑️', slowmode: '🐌', lock: '🔒', unlock: '🔓',
  hide: '🙈', unhide: '👁️', nick: '📝', note: '🗒️',
});

/**
 * Build the embed for one case.
 * @param {object} row
 * @param {{ guild?: import('discord.js').Guild }} [options]
 */
function caseEmbed(row, options = {}) {
  const { guild } = options;

  const built = embeds.embed({
    color: row.active ? 0xed4245 : 0x99aab5,
    title: `${ACTION_EMOJI[row.action] ?? '🛡️'} Case #${row.case_number} - ${row.action}`,
  });

  built.addFields(
    { name: 'Target', value: `<@${row.target_id}>${row.target_tag ? `\n\`${row.target_tag}\`` : ''}`, inline: true },
    { name: 'Moderator', value: `<@${row.moderator_id}>${row.moderator_tag ? `\n\`${row.moderator_tag}\`` : ''}`, inline: true },
    { name: 'When', value: helpers.timestamp(row.created_at, 'f'), inline: true },
  );

  if (row.reason) {
    built.addFields({ name: 'Reason', value: helpers.truncate(row.reason, 1000) });
  }

  if (row.duration) {
    built.addFields({ name: 'Duration', value: helpers.formatDuration(row.duration), inline: true });
  }
  if (row.expires_at && row.active) {
    built.addFields({ name: 'Expires', value: helpers.timestamp(row.expires_at, 'R'), inline: true });
  }
  if (row.resolved) {
    built.addFields({
      name: 'Lifted',
      value: `${row.resolved_by ? `<@${row.resolved_by}>` : 'System'} ${row.resolved_at ? helpers.timestamp(row.resolved_at, 'R') : ''}`.trim(),
      inline: true,
    });
  }

  built.setFooter({ text: `Case #${row.case_number}${guild ? ` • ${guild.name}` : ''} | ${require('../../config').brandFooterText}` });
  return built;
}

/**
 * A compact one-line summary of a case, for lists.
 * @param {object} row
 */
function caseLine(row) {
  const emoji = ACTION_EMOJI[row.action] ?? '🛡️';
  const when = helpers.timestamp(row.created_at, 'R');
  const reason = row.reason ? ` - ${helpers.truncate(row.reason, 60)}` : '';
  const state = row.active ? ' 🟢' : '';
  return `\`#${String(row.case_number).padStart(4, '0')}\` ${emoji} **${row.action}** by <@${row.moderator_id}> ${when}${reason}${state}`;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/**
 * Build the audit-log reason string Discord stores.
 *
 * Discord shows this to everyone who can see the audit log, so the responsible
 * moderator is named explicitly - the audit log records the bot as the actor.
 */
function auditReason(moderator, reason, duration) {
  const who = moderator?.tag ?? moderator?.username ?? moderator?.id ?? 'unknown';
  const parts = [`By ${who}`];
  if (reason) parts.push(reason);
  if (duration) parts.push(`(${helpers.formatDuration(duration)})`);
  return helpers.truncate(parts.join(' | '), 500);
}

/** Does the bot have the permissions this action needs? */
function botCan(guild, bits) {
  const me = guild.members.me;
  if (!me) return { ok: false, missing: ['bot not cached'] };
  const missing = bits.filter((bit) => !me.permissions.has(bit)).map((bit) => String(bit));
  return { ok: missing.length === 0, missing };
}

module.exports = {
  nextCaseNumber,
  createCase,
  ban,
  kick,
  mute,
  unmute,
  warn,
  liftTempban,
  getCase,
  getHistory,
  getSummary: summarise,
  getActiveWarnings,
  clearWarnings,
  setReason,
  caseEmbed,
  caseLine,
  auditReason,
  botCan,
  ACTION_EMOJI,
  PermissionFlagsBits,
};
