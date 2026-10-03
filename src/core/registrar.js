'use strict';

/**
 * Slash command registration.
 *
 * One implementation, two callers:
 *
 *   - `deploy-commands.js` (`npm run deploy`)  - the manual, local path
 *   - `src/events/ready.js`                    - automatic, on every boot
 *
 * Registration is idempotent: Discord's PUT replaces the entire command set for
 * a scope, so re-sending an identical payload is harmless. To avoid a pointless
 * round-trip on every restart we first GET the existing commands and compare a
 * content fingerprint; an unchanged set is skipped.
 *
 * Scope:
 *   - GUILD_IDS set   -> per-guild registration (instant - the default)
 *   - GUILD_IDS empty -> global registration (can take up to an hour)
 *
 * The fingerprint deliberately ignores the fields Discord adds on the way back
 * (id, application_id, version, guild_id, localisation maps). A false mismatch
 * only costs one redundant PUT; a false match would leave stale commands, so
 * the volatile-key list is kept tight.
 */

const crypto = require('node:crypto');
const { REST, Routes } = require('discord.js');

const config = require('../config');
const logger = require('../lib/logger');

const log = logger.child('registrar');

/** Fields Discord returns that we never send - ignored when comparing. */
const VOLATILE_KEYS = new Set([
  'id',
  'application_id',
  'version',
  'guild_id',
  'name_localizations',
  'description_localizations',
  'integration_types',
  'contexts',
  'handler',
  'managed',
]);

/**
 * Recursively normalise a value for hashing: drop volatile keys, drop
 * null/undefined, sort object keys. Arrays keep their order (option order is
 * meaningful to Discord).
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_KEYS.has(key)) continue;
      const child = value[key];
      if (child === undefined || child === null) continue;
      out[key] = canonicalize(child);
    }
    return out;
  }
  return value;
}

/**
 * Stable content hash of a command set. Order-independent at the top level so
 * a reordered registry does not look like a change.
 *
 * @param {object[]} commands slash payloads (local) or API responses (remote)
 * @returns {string} 16-char hex digest
 */
function fingerprint(commands) {
  const canonical = (Array.isArray(commands) ? commands : [])
    .map(canonicalize)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Every command's slash payload, skipping any that opt out of slash.
 *
 * @param {{ list: object[] }} registry
 * @returns {object[]}
 */
function buildBody(registry) {
  if (!registry || !Array.isArray(registry.list)) return [];
  return registry.list
    .filter((command) => command.slashEnabled !== false && command.slashData)
    .map((command) => command.slashData);
}

/** A REST client for the configured token. */
function createRest() {
  return new REST({ version: '10' }).setToken(config.token);
}

/**
 * Log the facts that make a "commands are missing" report diagnosable straight
 * from the platform logs.
 *
 * @param {{ list: object[] }} registry
 */
function logContext(registry) {
  const body = buildBody(registry);
  log.info(`application id: ${config.clientId || '(unset)'}`);
  log.info(
    `guild scope: ${config.guildIds.length > 0
      ? config.guildIds.join(', ')
      : '(GUILD_IDS empty - will register globally)'}`,
  );
  log.info(`slash commands to register: ${body.length}`);
  return body.length;
}

/**
 * Register the registry's slash commands.
 *
 * @param {object} options
 * @param {{ list: object[] }} options.registry
 * @param {boolean|null} [options.global]  force global (true) / guild (false);
 *                                         null = decide from GUILD_IDS
 * @param {boolean} [options.force]        skip the up-to-date check
 * @param {import('discord.js').REST} [options.rest] reuse a REST client
 * @returns {Promise<object>} a summary suitable for logging
 */
async function registerCommands({ registry, global = null, force = false, rest = null } = {}) {
  const body = buildBody(registry);

  if (body.length === 0) {
    log.error('no slash commands to register - the registry is empty');
    return { ok: false, reason: 'no-commands', registered: 0, commandCount: 0, scope: 'none' };
  }

  if (!config.clientId) {
    log.error('CLIENT_ID is not set - cannot register commands');
    return { ok: false, reason: 'no-client-id', registered: 0, commandCount: body.length, scope: 'none' };
  }

  const useGlobal = global === null ? config.guildIds.length === 0 : Boolean(global);
  const restClient = rest || createRest();
  const hash = fingerprint(body);

  const summary = {
    ok: true,
    scope: useGlobal ? 'global' : 'guild',
    applicationId: config.clientId,
    commandCount: body.length,
    registered: 0,
    guilds: [],
    skipped: [],
    failed: [],
    hash,
  };

  // ---- global -------------------------------------------------------------
  if (useGlobal) {
    try {
      const existing = await restClient
        .get(Routes.applicationCommands(config.clientId))
        .catch(() => null);

      if (!force && Array.isArray(existing) && fingerprint(existing) === hash) {
        summary.skipped.push('global');
        log.info(`global commands already up to date (${body.length}) - skipping`);
        return summary;
      }

      const data = await restClient.put(Routes.applicationCommands(config.clientId), { body });
      summary.registered = data.length;
      log.info(
        `registered ${data.length} global command(s) - they can take up to an hour to appear`,
      );
    } catch (error) {
      summary.ok = false;
      summary.failed.push({ guildId: 'global', error: error.message });
      log.error(`global registration failed: ${error.message}`);
    }
    return summary;
  }

  // ---- per guild ----------------------------------------------------------
  for (const guildId of config.guildIds) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const existing = await restClient
        .get(Routes.applicationGuildCommands(config.clientId, guildId))
        .catch(() => null);

      if (!force && Array.isArray(existing) && fingerprint(existing) === hash) {
        summary.skipped.push(guildId);
        log.info(`guild ${guildId}: commands already up to date (${body.length}) - skipping`);
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const data = await restClient.put(
        Routes.applicationGuildCommands(config.clientId, guildId),
        { body },
      );

      summary.guilds.push({ guildId, count: data.length });
      summary.registered += data.length;
      log.info(`guild ${guildId}: registered ${data.length} command(s)`);
    } catch (error) {
      summary.ok = false;
      summary.failed.push({ guildId, error: error.message });
      log.error(
        `guild ${guildId}: registration failed - ${error.message}. `
        + 'Is the bot actually a member of that server, and is GUILD_IDS correct?',
      );
    }
  }

  return summary;
}

/** One-line human summary of a registration result. */
function describe(summary) {
  if (!summary) return 'registration: no result';
  if (summary.reason === 'no-commands') return 'registration: no slash commands to register';
  if (summary.reason === 'no-client-id') return 'registration: CLIENT_ID is not set';

  const parts = [
    `scope=${summary.scope}`,
    `app=${summary.applicationId}`,
    `commands=${summary.commandCount}`,
  ];
  if (summary.guilds.length > 0) {
    parts.push(`registered=${summary.guilds.map((g) => `${g.guildId}(${g.count})`).join(',')}`);
  }
  if (summary.skipped.length > 0) parts.push(`up-to-date=${summary.skipped.join(',')}`);
  if (summary.failed.length > 0) {
    parts.push(`failed=${summary.failed.map((f) => f.guildId).join(',')}`);
  }
  return `registration: ${parts.join(' ')}`;
}

module.exports = {
  buildBody,
  fingerprint,
  canonicalize,
  registerCommands,
  describe,
  logContext,
  createRest,
};
