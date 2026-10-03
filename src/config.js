'use strict';

/**
 * Central configuration.
 *
 * Everything that varies between deployments is read here, validated once, and
 * exported as plain values. Nothing else in the codebase reads process.env
 * directly - so a bad .env fails loudly at boot instead of halfway through a
 * command.
 */

require('dotenv').config();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Read a string env var with a default. */
function str(key, fallback = '') {
  const raw = process.env[key];
  if (raw === undefined || raw === null) return fallback;
  const trimmed = String(raw).trim();
  return trimmed === '' ? fallback : trimmed;
}

/** Read a boolean env var. Accepts true/1/yes/on (case-insensitive). */
function bool(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'y'].includes(String(raw).trim().toLowerCase());
}

/** Read an integer env var, clamped to [min, max]. */
function int(key, fallback, min = -Infinity, max = Infinity) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Read a comma (or whitespace) separated list of IDs.
 * Duplicates and blanks are removed so `GUILD_IDS=a,a,b` behaves sanely.
 */
function list(key) {
  const raw = str(key, '');
  if (!raw) return [];
  return [...new Set(
    raw
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean),
  )];
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

const guildIds = list('GUILD_IDS');

const config = {
  // ---- Discord ------------------------------------------------------------
  token: str('DISCORD_TOKEN'),
  clientId: str('CLIENT_ID'),

  /**
   * Guilds to register slash commands in. Per-guild registration is instant,
   * which is what we want for a private bot - global commands can take an hour
   * to appear.
   */
  guildIds,
  devGuildId: str('DEV_GUILD_ID', guildIds[0] || ''),

  /** User IDs that skip every permission check. */
  adminIds: list('BOT_ADMINS'),

  // ---- Supabase -----------------------------------------------------------
  supabase: {
    url: str('SUPABASE_URL'),
    key: str('SUPABASE_KEY'),
  },
  databaseUrl: str('DATABASE_URL'),

  // ---- Branding -----------------------------------------------------------
  // Shown in every embed footer, the presence, /help and /botinfo.
  brand: {
    name: str('BRAND_NAME', 'ZAYN'),
    discord: str('BRAND_DISCORD', "ZAYN'S DC - whos.zayn_"),
    footer: str('BRAND_FOOTER', 'Built by ZAYN'),
    link: str('BRAND_LINK', ''),
  },

  // ---- Behaviour ----------------------------------------------------------
  defaultPrefix: str('DEFAULT_PREFIX', '.').slice(0, 5),
  prefixCommandsEnabled: bool('PREFIX_COMMANDS_ENABLED', true),
  tasksEnabled: bool('TASKS_ENABLED', true),
  taskIntervalSeconds: int('TASK_INTERVAL_SECONDS', 30, 10, 3600),

  /**
   * Register slash commands automatically on every boot. On by default so that
   * deploying the bot is enough on its own; the registration is idempotent and
   * skipped when the command set has not changed.
   */
  autoRegisterCommands: bool('AUTO_REGISTER_COMMANDS', true),

  // ---- Health endpoint ----------------------------------------------------
  healthEnabled: bool('HEALTH_ENABLED', true),
  /** Koyeb injects PORT; when absent we fall back to 8000. */
  port: int('PORT', 8000, 1, 65535),

  // ---- Logging ------------------------------------------------------------
  logLevel: str('LOG_LEVEL', 'info').toLowerCase(),

  nodeEnv: str('NODE_ENV', 'development'),
};

config.isProduction = config.nodeEnv === 'production';

// ---------------------------------------------------------------------------
// Derived
// ---------------------------------------------------------------------------

/**
 * Footer text appended to every embed the bot sends.
 * Defaults to "Built by ZAYN" and always includes the brand discord handle.
 */
config.brandFooterText = [config.brand.footer, config.brand.discord]
  .filter(Boolean)
  .join(' | ');

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Verify the environment. Returns { errors, warnings }.
 *
 * Split out from boot so `scripts/check.js` can report problems without
 * throwing, and so the bot can start in a degraded "no database" mode while
 * still telling you exactly what is missing.
 */
function validate() {
  const errors = [];
  const warnings = [];

  if (!config.token) {
    errors.push('DISCORD_TOKEN is not set - the bot cannot log in.');
  } else if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(config.token)) {
    warnings.push('DISCORD_TOKEN does not look like a normal bot token.');
  }

  if (!config.clientId) {
    errors.push('CLIENT_ID is not set - slash commands cannot be registered.');
  } else if (!/^\d{15,25}$/.test(config.clientId)) {
    errors.push('CLIENT_ID must be a Discord snowflake (digits only).');
  }

  if (config.guildIds.length === 0) {
    warnings.push(
      'GUILD_IDS is empty - commands will not be registered anywhere. '
      + 'Set it to the server IDs the bot runs in.',
    );
  } else {
    for (const id of config.guildIds) {
      if (!/^\d{15,25}$/.test(id)) {
        errors.push(`GUILD_IDS contains "${id}", which is not a Discord snowflake.`);
      }
    }
  }

  if (!config.supabase.url) {
    errors.push('SUPABASE_URL is not set - persistence is unavailable.');
  } else if (!/^https?:\/\//.test(config.supabase.url)) {
    errors.push('SUPABASE_URL must start with https://');
  }

  if (!config.supabase.key) {
    errors.push('SUPABASE_KEY is not set - persistence is unavailable.');
  } else if (config.supabase.key.startsWith('sb_publishable_')) {
    warnings.push(
      'SUPABASE_KEY looks like a publishable/anon key. Row Level Security will '
      + 'block writes - use the service_role key.',
    );
  }

  if (config.databaseUrl && config.databaseUrl.includes(':6543') && !config.databaseUrl.includes('pgbouncer')) {
    warnings.push(
      'DATABASE_URL uses port 6543 (Supabase pooler). Add ?pgbouncer=true for '
      + 'transaction-pooling compatibility if you use it from Node.',
    );
  }

  if (!config.isProduction && config.token && config.supabase.key) {
    // Fine - just informational.
  }

  return { errors, warnings };
}

/**
 * Throw if the environment is unusable. Called from index.js so the process
 * exits immediately with a readable message rather than crashing later.
 */
function assertValid() {
  const { errors, warnings } = validate();
  for (const warning of warnings) {
    // eslint-disable-next-line no-console
    console.warn(`[config] warning: ${warning}`);
  }
  if (errors.length > 0) {
    const message = [
      'Invalid configuration - fix these before starting the bot:',
      ...errors.map((error) => `  - ${error}`),
      '',
      'See .env.example for the full list of variables.',
    ].join('\n');
    throw new Error(message);
  }
  return true;
}

/** True when Supabase credentials are present. */
config.hasDatabase = Boolean(config.supabase.url && config.supabase.key);

module.exports = config;
module.exports.validate = validate;
module.exports.assertValid = assertValid;
module.exports.helpers = { str, bool, int, list };
