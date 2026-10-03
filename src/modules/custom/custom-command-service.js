'use strict';

/**
 * Custom commands service.
 *
 * Guild-defined triggers that reply with a template. Backed by the
 * `custom_commands` table (column `name`, unique per guild on lower(name)).
 * Uses are recorded in `custom_command_uses` so per-user cooldowns work.
 *
 * Template variables:
 *   {user} {tag} {server} {channel} {count} {args} {arg1}..{arg9}
 *   {random:a|b|c} {time}
 */

const helpers = require('../../lib/helpers');
const logger = require('../../lib/logger');

const log = logger.child('custom');

/** Longest trigger we accept, so it cannot shadow a normal command. */
const MAX_NAME_LENGTH = 32;

/** Normalise a name: lower case, no leading punctuation. */
function normaliseName(input) {
  return String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[!/.,-]+/, '')
    .slice(0, MAX_NAME_LENGTH);
}

/** Validate a name, returning an error message or null. */
function validateName(name) {
  if (!name) return 'The trigger cannot be empty.';
  if (name.length > MAX_NAME_LENGTH) return `Triggers must be ${MAX_NAME_LENGTH} characters or fewer.`;
  if (/\s/.test(name)) return 'Triggers cannot contain spaces.';
  if (!/^[a-z0-9_-]+$/.test(name)) {
    return 'Triggers may only use letters, numbers, hyphens and underscores.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Find a custom command by name. */
async function match(guildId, name) {
  const db = require('../../db');
  return db.selectOne('custom_commands', {
    where: { guild_id: guildId, name: normaliseName(name) },
    optional: true,
  });
}

/** All custom commands for a guild. */
async function list(guildId) {
  const db = require('../../db');
  return db.select('custom_commands', {
    where: { guild_id: guildId },
    order: { column: 'name', ascending: true },
    limit: 500,
    optional: true,
    fallback: [],
  });
}

/** Count how many triggers a guild has defined. */
async function count(guildId) {
  const db = require('../../db');
  return db.count('custom_commands', { guild_id: guildId }, { optional: true });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Create or update a custom command.
 *
 * The unique index is on (guild_id, lower(name)), which PostgREST cannot target
 * with an onConflict clause, so this reads first and then inserts or updates.
 */
async function save(guildId, name, response, options = {}) {
  const key = normaliseName(name);

  const invalid = validateName(key);
  if (invalid) return { ok: false, error: invalid };
  if (!response || String(response).trim().length === 0) {
    return { ok: false, error: 'The response cannot be empty.' };
  }

  const db = require('../../db');
  const existing = await match(guildId, key);

  const payload = {
    guild_id: guildId,
    name: key,
    response: String(response).slice(0, 2000),
    embed: options.embed === true,
    cooldown: Number.isFinite(options.cooldown) ? options.cooldown : (existing?.cooldown ?? 3),
    enabled: options.enabled !== false,
    created_by: existing?.created_by ?? options.createdBy ?? null,
  };

  if (existing) {
    const rows = await db.update('custom_commands', { id: existing.id }, payload);
    return { ok: true, command: rows[0] ?? { ...existing, ...payload } };
  }

  const row = await db.insert('custom_commands', {
    ...payload,
    uses: 0,
    aliases: [],
    allowed_roles: [],
    denied_roles: [],
    allowed_channels: [],
  }).catch((error) => {
    log.error('custom command insert failed:', error);
    return null;
  });

  if (!row) return { ok: false, error: 'The command could not be saved.' };
  return { ok: true, command: row };
}

/** Remove a custom command. */
async function remove(guildId, name) {
  const db = require('../../db');
  const key = normaliseName(name);
  const removed = await db.remove('custom_commands', { guild_id: guildId, name: key });
  return { ok: Array.isArray(removed) ? removed.length > 0 : Boolean(removed) };
}

/** Enable or disable a command. */
async function setEnabled(guildId, name, enabled) {
  const db = require('../../db');
  const key = normaliseName(name);
  const rows = await db.update('custom_commands', { guild_id: guildId, name: key }, { enabled });
  return { ok: rows.length > 0, command: rows[0] ?? null };
}

/** Set the usage conditions on a command. */
async function setConditions(guildId, name, patch) {
  const db = require('../../db');
  const key = normaliseName(name);
  const rows = await db.update('custom_commands', { guild_id: guildId, name: key }, patch);
  return { ok: rows.length > 0, command: rows[0] ?? null };
}

/** Increment the usage counter. */
async function bumpUses(guildId, name, currentUses) {
  const db = require('../../db');
  await db.update('custom_commands', { guild_id: guildId, name }, {
    uses: Number(currentUses ?? 0) + 1,
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Permissions and cooldown
// ---------------------------------------------------------------------------

/**
 * Check whether a member may run a command in a channel.
 * @returns {{ ok: boolean, reason?: string }}
 */
function canUse(command, member, channelId) {
  const allowedChannels = Array.isArray(command.allowed_channels) ? command.allowed_channels : [];
  if (allowedChannels.length > 0 && !allowedChannels.includes(channelId)) {
    return { ok: false, reason: 'This command cannot be used here.' };
  }

  const deniedRoles = Array.isArray(command.denied_roles) ? command.denied_roles : [];
  if (deniedRoles.length > 0 && member.roles.cache.some((role) => deniedRoles.includes(role.id))) {
    return { ok: false, reason: 'You are not allowed to use this command.' };
  }

  const allowedRoles = Array.isArray(command.allowed_roles) ? command.allowed_roles : [];
  if (allowedRoles.length > 0) {
    const has = member.roles.cache.some((role) => allowedRoles.includes(role.id));
    // Administrators and the owner always pass.
    if (!has && !member.permissions.has('ManageGuild')) {
      return { ok: false, reason: 'You need a specific role to use this command.' };
    }
  }

  return { ok: true };
}

/** Seconds left on a member's cooldown for a command (0 when ready). */
async function cooldownRemaining(command, userId) {
  if (!command.cooldown || command.cooldown <= 0) return 0;

  const db = require('../../db');
  const rows = await db.select('custom_command_uses', {
    where: { command_id: command.id, user_id: userId },
    order: { column: 'used_at', ascending: false },
    limit: 1,
    optional: true,
    fallback: [],
  });

  const last = rows[0];
  if (!last?.used_at) return 0;

  const elapsed = (Date.now() - new Date(last.used_at).getTime()) / 1000;
  return Math.max(0, Math.ceil(command.cooldown - elapsed));
}

/** Record a use, trimming older rows so the table does not grow without bound. */
async function recordUse(command, guildId, userId) {
  const db = require('../../db');
  await db.insert('custom_command_uses', {
    command_id: command.id,
    guild_id: guildId,
    user_id: userId,
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Substitute every `{random:a|b|c}` occurrence. */
function resolveRandom(text) {
  return String(text).replace(/\{random:([^}]+)\}/gi, (_whole, options) => {
    const choices = String(options).split('|').map((choice) => choice.trim()).filter(Boolean);
    if (choices.length === 0) return '';
    return choices[Math.floor(Math.random() * choices.length)];
  });
}

/** Build the final response text. */
function buildResponse(template, context = {}) {
  if (!template) return '';

  const args = String(context.args ?? '').trim();
  const parts = args.length > 0 ? args.split(/\s+/) : [];

  const map = {
    '{user}': context.userId ? `<@${context.userId}>` : '',
    '{tag}': context.username ?? '',
    '{server}': context.guildName ?? '',
    '{channel}': context.channelId ? `<#${context.channelId}>` : '',
    '{count}': context.memberCount !== undefined ? helpers.formatNumber(context.memberCount) : '',
    '{args}': args || '*nothing*',
    '{time}': new Date().toISOString().replace('T', ' ').slice(0, 19),
  };

  for (let index = 1; index <= 9; index += 1) {
    map[`{arg${index}}`] = parts[index - 1] ?? '';
  }

  let output = String(template);
  for (const [key, replacement] of Object.entries(map)) {
    output = output.split(key).join(replacement);
  }

  output = resolveRandom(output);
  return output.replace(/\\n/g, '\n').trim();
}

/** Every variable name, for help text. */
const VARIABLES = Object.freeze([
  '{user}', '{tag}', '{server}', '{channel}', '{count}',
  '{args}', '{arg1}...{arg9}', '{random:a|b|c}', '{time}',
]);

module.exports = {
  MAX_NAME_LENGTH,
  VARIABLES,
  normaliseName,
  validateName,
  match,
  list,
  count,
  save,
  remove,
  setEnabled,
  setConditions,
  bumpUses,
  canUse,
  cooldownRemaining,
  recordUse,
  buildResponse,
  resolveRandom,
};
