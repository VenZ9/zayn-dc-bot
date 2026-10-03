'use strict';

/**
 * Supabase data layer.
 *
 * One place that knows how to talk to Postgres. Every module goes through the
 * `db` helpers below, which means:
 *   - errors are normalised and logged once, in one format
 *   - writes use upsert where the schema allows it, so a retry is safe
 *   - missing configuration degrades gracefully instead of throwing on import
 *
 * The bot uses the service_role key over the REST API. RLS is enabled with no
 * policies, so only this key can read or write.
 */

const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../lib/logger');

const log = logger.child('db');

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

let client = null;

if (config.hasDatabase) {
  client = createClient(config.supabase.url, config.supabase.key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
    global: {
      headers: { 'x-application-name': 'zayn-dc-bot' },
    },
  });
} else {
  log.warn('Supabase credentials missing - running without persistence.');
}

/** True when a client was created. */
const isEnabled = () => client !== null;

// ---------------------------------------------------------------------------
// Error normalisation
// ---------------------------------------------------------------------------

/**
 * Turn whatever supabase-js threw into a predictable shape.
 * @returns {{ message: string, code: string|null, details: string|null, hint: string|null }}
 */
function normaliseError(error) {
  if (!error) return { message: 'Unknown database error', code: null, details: null, hint: null };
  return {
    message: error.message || String(error),
    code: error.code || null,
    details: error.details || null,
    hint: error.hint || null,
  };
}

/** Error subclass so callers can `instanceof DbError`. */
class DbError extends Error {
  constructor(error, context) {
    const normalised = normaliseError(error);
    super(`${context}: ${normalised.message}`);
    this.name = 'DbError';
    this.code = normalised.code;
    this.details = normalised.details;
    this.hint = normalised.hint;
    this.context = context;
  }
}

// ---------------------------------------------------------------------------
// Core query helpers
// ---------------------------------------------------------------------------

/**
 * Run a supabase query builder and unwrap the result.
 *
 * @template T
 * @param {string} context  human readable label used in error messages
 * @param {PromiseLike<{data: T, error: any}>} query
 * @param {{ optional?: boolean, fallback?: any }} [options]
 * @returns {Promise<T|null>}
 */
async function run(context, query, options = {}) {
  const { optional = false, fallback = null } = options;

  if (!client) {
    if (optional) return fallback;
    throw new DbError(
      { message: 'Supabase is not configured (SUPABASE_URL / SUPABASE_KEY missing)' },
      context,
    );
  }

  let result;
  try {
    result = await query;
  } catch (thrown) {
    // Network-level failure (DNS, TLS, timeout) never reaches the error field.
    if (optional) {
      log.warn(`${context} failed (optional):`, thrown?.message || thrown);
      return fallback;
    }
    log.error(`${context} threw:`, thrown);
    throw new DbError(thrown, context);
  }

  const { data, error } = result || {};

  if (error) {
    // PGRST116 = "no rows", which is not an error for a single-row read.
    if (error.code === 'PGRST116') return fallback;
    if (optional) {
      log.warn(`${context} failed (optional):`, error.message);
      return fallback;
    }
    log.error(`${context} failed:`, error.message);
    throw new DbError(error, context);
  }

  return data === undefined ? fallback : data;
}

// ---------------------------------------------------------------------------
// Table accessors
// ---------------------------------------------------------------------------

/** Raw builder for a table, so callers can chain freely. */
const from = (table) => {
  if (!client) {
    throw new DbError({ message: 'Supabase is not configured' }, `from(${table})`);
  }
  return client.from(table);
};

/** SELECT many rows. */
async function select(table, { columns = '*', where = {}, order, limit, range, optional = false, fallback = [] } = {}) {
  let query = from(table).select(columns);
  for (const [key, value] of Object.entries(where)) {
    if (value === null) query = query.is(key, null);
    else if (Array.isArray(value)) query = query.in(key, value);
    else query = query.eq(key, value);
  }
  if (order) {
    query = query.order(order.column, { ascending: order.ascending !== false });
  }
  if (typeof limit === 'number') query = query.limit(limit);
  if (range) query = query.range(range.from, range.to);
  const data = await run(`select ${table}`, query, { optional, fallback });
  return Array.isArray(data) ? data : (data ?? []);
}

/** SELECT a single row, or null. Does not throw when there are zero rows. */
async function selectOne(table, { columns = '*', where = {}, optional = false } = {}) {
  let query = from(table).select(columns);
  for (const [key, value] of Object.entries(where)) {
    if (value === null) query = query.is(key, null);
    else if (Array.isArray(value)) query = query.in(key, value);
    else query = query.eq(key, value);
  }
  const data = await run(`selectOne ${table}`, query.maybeSingle(), { optional, fallback: null });
  return data ?? null;
}

/** COUNT matching rows without transferring them. */
async function count(table, where = {}, { optional = false } = {}) {
  let query = from(table).select('*', { count: 'exact', head: true });
  for (const [key, value] of Object.entries(where)) {
    if (value === null) query = query.is(key, null);
    else if (Array.isArray(value)) query = query.in(key, value);
    else query = query.eq(key, value);
  }
  if (!client) return optional ? 0 : run(`count ${table}`, query);
  const { count: total, error } = await query;
  if (error) {
    if (optional) {
      log.warn(`count ${table} failed (optional):`, error.message);
      return 0;
    }
    throw new DbError(error, `count ${table}`);
  }
  return total ?? 0;
}

/** INSERT one row and return it. */
async function insert(table, row) {
  const data = await run(`insert ${table}`, from(table).insert(row).select().maybeSingle());
  return data ?? null;
}

/** INSERT many rows and return them. */
async function insertMany(table, rows) {
  if (!rows || rows.length === 0) return [];
  const data = await run(`insertMany ${table}`, from(table).insert(rows).select());
  return Array.isArray(data) ? data : [];
}

/**
 * UPSERT and return the row. Requires a unique constraint on the conflict
 * target, which the schema provides for every table that uses this.
 */
async function upsert(table, row, onConflict) {
  let query = from(table).upsert(row, onConflict ? { onConflict } : undefined).select();
  const data = await run(`upsert ${table}`, query.maybeSingle());
  return data ?? null;
}

/** UPDATE matching rows and return them. */
async function update(table, where, patch) {
  let query = from(table).update(patch);
  for (const [key, value] of Object.entries(where)) {
    if (value === null) query = query.is(key, null);
    else if (Array.isArray(value)) query = query.in(key, value);
    else query = query.eq(key, value);
  }
  const data = await run(`update ${table}`, query.select());
  return Array.isArray(data) ? data : [];
}

/** DELETE matching rows and return what was removed. */
async function remove(table, where) {
  let query = from(table).delete();
  for (const [key, value] of Object.entries(where)) {
    if (value === null) query = query.is(key, null);
    else if (Array.isArray(value)) query = query.in(key, value);
    else query = query.eq(key, value);
  }
  const data = await run(`delete ${table}`, query.select());
  return Array.isArray(data) ? data : [];
}

/**
 * Call a Postgres function defined in schema.sql.
 * Used for the atomic increment helpers.
 */
async function rpc(fn, args = {}, { optional = false, fallback = null } = {}) {
  if (!client) {
    if (optional) return fallback;
    throw new DbError({ message: 'Supabase is not configured' }, `rpc ${fn}`);
  }
  const data = await run(`rpc ${fn}`, client.rpc(fn, args), { optional, fallback });
  return data ?? fallback;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * Round-trip check used by the health endpoint and boot sequence.
 * @returns {Promise<{ok: boolean, latencyMs: number|null, error: string|null, enabled: boolean}>}
 */
async function ping() {
  if (!client) {
    return { ok: false, latencyMs: null, error: 'Supabase not configured', enabled: false };
  }
  const startedAt = Date.now();
  try {
    // Cheapest query that proves both connectivity and schema access.
    const { error } = await client.from('guild_config').select('guild_id', { head: true, count: 'exact' }).limit(1);
    const latencyMs = Date.now() - startedAt;
    if (error) return { ok: false, latencyMs, error: error.message, enabled: true };
    return { ok: true, latencyMs, error: null, enabled: true };
  } catch (thrown) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: thrown?.message || String(thrown),
      enabled: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Guild config helpers (used by nearly every module)
// ---------------------------------------------------------------------------

/**
 * In-memory guild config cache.
 *
 * Config is read on almost every command, so caching it matters. The cache is
 * short-lived on purpose: with one bot instance there is no cross-instance
 * invalidation to worry about, and a few seconds of staleness after
 * `/config prefix` is invisible to users.
 */
const configCache = new Map();
const CONFIG_TTL_MS = 15_000;

/** Defaults matching the schema, used when a guild has no row yet. */
const GUILD_CONFIG_DEFAULTS = Object.freeze({
  prefix: config.defaultPrefix,
  prefix_enabled: true,
  prefix_delete_message: false,
  language: 'en',
  timezone: 'UTC',
  mod_log_channel: null,
  modlog_enabled: true,
  mute_role_id: null,
  dj_role_id: null,
  welcome_enabled: false,
  welcome_channel: null,
  welcome_message: null,
  welcome_image: null,
  welcome_dm: false,
  goodbye_enabled: false,
  goodbye_channel: null,
  goodbye_message: null,
  autorole_id: null,
  levels_enabled: true,
  levels_announce_channel: null,
  levels_base_xp: 15,
  levels_min_xp: 5,
  levels_max_xp: 25,
  levels_cooldown_secs: 60,
  levels_stack_rewards: false,
});

/**
 * Get a guild's config, creating the row on first access.
 * @param {string} guildId
 * @param {{ fresh?: boolean }} [options]
 */
async function getGuildConfig(guildId, options = {}) {
  const { fresh = false } = options;
  if (!guildId) return { guild_id: null, ...GUILD_CONFIG_DEFAULTS };

  const cached = configCache.get(guildId);
  if (!fresh && cached && Date.now() - cached.at < CONFIG_TTL_MS) {
    return cached.value;
  }

  const row = await selectOne('guild_config', { where: { guild_id: guildId }, optional: true });

  if (row) {
    const value = { ...GUILD_CONFIG_DEFAULTS, ...row };
    configCache.set(guildId, { at: Date.now(), value });
    return value;
  }

  // No row yet - create one so later writes are plain updates.
  const created = await upsert('guild_config', { guild_id: guildId }, 'guild_id').catch(() => null);
  const value = { guild_id: guildId, ...GUILD_CONFIG_DEFAULTS, ...(created || {}) };
  configCache.set(guildId, { at: Date.now(), value });
  return value;
}

/**
 * Patch a guild's config and refresh the cache.
 * @param {string} guildId
 * @param {object} patch
 */
async function setGuildConfig(guildId, patch) {
  const updated = await upsert('guild_config', { guild_id: guildId, ...patch }, 'guild_id');
  configCache.delete(guildId);
  const value = await getGuildConfig(guildId, { fresh: true });
  return { updated, config: value };
}

/** Drop a cached config (used after `/config reset`). */
function invalidateGuildConfig(guildId) {
  configCache.delete(guildId);
}

/** Wipe every cached config - used by tests and the health endpoint. */
function clearConfigCache() {
  configCache.clear();
}

/** Quick prefix lookup for the messageCreate hot path. */
async function getPrefix(guildId) {
  try {
    const cfg = await getGuildConfig(guildId);
    return {
      prefix: cfg.prefix || config.defaultPrefix,
      enabled: cfg.prefix_enabled !== false && config.prefixCommandsEnabled,
      deleteMessage: cfg.prefix_delete_message === true,
    };
  } catch (error) {
    log.warn('getPrefix fell back to default:', error.message);
    return { prefix: config.defaultPrefix, enabled: config.prefixCommandsEnabled, deleteMessage: false };
  }
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

/**
 * Record a staff action. Never throws - auditing must not break the action it
 * is describing.
 */
async function writeAudit(entry) {
  try {
    const row = {
      guild_id: entry.guildId,
      actor_id: entry.actorId ?? null,
      actor_tag: entry.actorTag ?? null,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      details: entry.details ?? {},
      source: entry.source ?? 'slash',
    };
    await insert('audit_log', row);
  } catch (error) {
    log.warn('audit write failed:', error.message);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // client access
  get client() { return client; },
  isEnabled,
  ping,

  // query surface
  from,
  select,
  selectOne,
  count,
  insert,
  insertMany,
  upsert,
  update,
  remove,
  rpc,

  // guild config
  getGuildConfig,
  setGuildConfig,
  invalidateGuildConfig,
  clearConfigCache,
  getPrefix,
  GUILD_CONFIG_DEFAULTS,

  // audit
  writeAudit,

  // errors
  DbError,
  normaliseError,

  // raw helpers for the few places that need to build a query by hand
  tables: {
    guildConfig: 'guild_config',
    modCases: 'mod_cases',
    notes: 'notes',
    tickets: 'tickets',
    ticketPanels: 'ticket_panels',
    levels: 'levels',
    levelRewards: 'level_rewards',
    giveaways: 'giveaways',
    giveawayEntries: 'giveaway_entries',
    customCommands: 'custom_commands',
    customCommandUses: 'custom_command_uses',
    autoresponders: 'autoresponders',
    scheduledTasks: 'scheduled_tasks',
    events: 'events',
    eventAttendees: 'event_attendees',
    polls: 'polls',
    logsConfig: 'logs_config',
    auditLog: 'audit_log',
    reactionRoles: 'reaction_roles',
    roleMenus: 'role_menus',
    profiles: 'profiles',
    reputation: 'reputation',
    afk: 'afk',
    analyticsCounters: 'analytics_counters',
    analyticsDaily: 'analytics_daily',
    analyticsChannels: 'analytics_channels',
    analyticsMembers: 'analytics_members',
    memberSnapshots: 'member_snapshots',
    voiceSessions: 'voice_sessions',
    invites: 'invites',
  },
};
