'use strict';

/**
 * Autoresponder service.
 *
 * Autoresponders reply to plain text in any channel. Backed by the
 * `autoresponders` table.
 *
 * match_type:
 *   exact       the whole message equals the trigger
 *   contains    the message contains the trigger (default)
 *   startswith  the message begins with the trigger
 *   regex       the trigger is a regular expression
 *
 * `wildcard` makes matching case-insensitive and lets `*` stand for any run of
 * characters.
 */

const helpers = require('../../lib/helpers');
const logger = require('../../lib/logger');

const log = logger.child('autoresponders');

const MATCH_TYPES = Object.freeze(['exact', 'contains', 'startswith', 'regex']);

/** Turn a trigger into a RegExp for the given mode. */
function compile(trigger, matchType = 'contains', wildcard = false) {
  const source = String(trigger ?? '');
  if (!source) return null;

  try {
    if (matchType === 'regex') {
      return new RegExp(source, wildcard ? 'i' : '');
    }

    let pattern = source;
    if (wildcard) {
      // Escape everything, then let a glob star through.
      pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
    } else {
      pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    const flags = wildcard ? 'i' : '';

    switch (matchType) {
      case 'exact': return new RegExp(`^${pattern}$`, flags);
      case 'startswith': return new RegExp(`^${pattern}`, flags);
      case 'contains': default: return new RegExp(pattern, flags);
    }
  } catch (error) {
    log.warn(`invalid trigger ${JSON.stringify(source)}:`, error.message);
    return null;
  }
}

/** Does a message match an autoresponder row? */
function matches(row, content) {
  const text = String(content ?? '');
  if (text.length === 0) return false;

  const regex = compile(row.trigger, row.match_type || 'contains', row.wildcard === true);
  if (!regex) return false;

  return regex.test(text);
}

/** Is the member and channel allowed to trigger this responder? */
function allowed(row, member, channelId) {
  const allowedChannels = Array.isArray(row.allowed_channels) ? row.allowed_channels : [];
  if (allowedChannels.length > 0 && !allowedChannels.includes(channelId)) return false;

  const ignoredRoles = Array.isArray(row.ignore_roles) ? row.ignore_roles : [];
  if (ignoredRoles.length > 0 && member.roles.cache.some((role) => ignoredRoles.includes(role.id))) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** All autoresponders for a guild. */
async function list(guildId) {
  const db = require('../../db');
  return db.select('autoresponders', {
    where: { guild_id: guildId },
    order: { column: 'created_at', ascending: false },
    limit: 500,
    optional: true,
    fallback: [],
  });
}

/** Find one by trigger text. */
async function find(guildId, trigger) {
  const db = require('../../db');
  return db.selectOne('autoresponders', {
    where: { guild_id: guildId, trigger: String(trigger) },
    optional: true,
  });
}

/** Create an autoresponder. */
async function create(guildId, trigger, response, options = {}) {
  const db = require('../../db');

  const text = String(trigger ?? '').trim();
  if (!text) return { ok: false, error: 'The trigger cannot be empty.' };
  if (text.length > 200) return { ok: false, error: 'The trigger is too long (200 characters maximum).' };
  if (!response || String(response).trim().length === 0) {
    return { ok: false, error: 'The response cannot be empty.' };
  }

  const matchType = MATCH_TYPES.includes(options.matchType) ? options.matchType : 'contains';

  if (matchType === 'regex') {
    try {
      // eslint-disable-next-line no-new
      new RegExp(text);
    } catch (error) {
      return { ok: false, error: `That is not a valid regular expression: ${error.message}` };
    }
  }

  const row = await db.insert('autoresponders', {
    guild_id: guildId,
    trigger: text,
    response: String(response).slice(0, 2000),
    match_type: matchType,
    wildcard: options.wildcard === true,
    ignore_roles: [],
    allowed_channels: [],
    enabled: true,
    uses: 0,
    created_by: options.createdBy ?? null,
  }).catch((error) => {
    log.error('autoresponder insert failed:', error);
    return null;
  });

  if (!row) return { ok: false, error: 'The autoresponder could not be saved.' };
  return { ok: true, autoresponder: row };
}

/** Delete an autoresponder by id. */
async function remove(guildId, id) {
  const db = require('../../db');
  const removed = await db.remove('autoresponders', { guild_id: guildId, id });
  return { ok: Array.isArray(removed) ? removed.length > 0 : Boolean(removed) };
}

/** Enable or disable an autoresponder. */
async function setEnabled(guildId, id, enabled) {
  const db = require('../../db');
  const rows = await db.update('autoresponders', { guild_id: guildId, id }, { enabled });
  return { ok: rows.length > 0, autoresponder: rows[0] ?? null };
}

/** Increment the usage counter. */
async function bumpUses(id, currentUses) {
  const db = require('../../db');
  await db.update('autoresponders', { id }, { uses: Number(currentUses ?? 0) + 1 }).catch(() => {});
}

module.exports = {
  MATCH_TYPES,
  compile,
  matches,
  allowed,
  list,
  find,
  create,
  remove,
  setEnabled,
  bumpUses,
};
