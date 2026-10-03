'use strict';

/**
 * Tiny leveled logger.
 *
 * Deliberately dependency-free so it can be used from index.js before anything
 * else is loaded. Handles the two things that actually matter in a container:
 *   - structured-ish output that stays readable in Koyeb's log viewer
 *   - secrets never reaching the log (see `redact`)
 */

const config = require('../config');

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, silent: 100 };

/** ANSI colours, disabled when not attached to a TTY or when NO_COLOR is set. */
const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColour ? `\u001b[${code}m${text}\u001b[0m` : text);

const PALETTE = {
  trace: '90',
  debug: '36',
  info: '32',
  warn: '33',
  error: '31',
};

const LABEL = {
  trace: 'TRACE',
  debug: 'DEBUG',
  info: ' INFO',
  warn: ' WARN',
  error: 'ERROR',
};

const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

/**
 * Hide anything that looks like a credential before it reaches stdout.
 * Koyeb keeps logs around - a leaked token there is a leaked token.
 */
function redact(value) {
  if (typeof value === 'string') {
    return value
      // Discord bot tokens: xxx.yyy.zzz
      .replace(/[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}/g, '[REDACTED_TOKEN]')
      // JWTs / supabase service keys
      .replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, '[REDACTED_JWT]')
      .replace(/sb_secret_[\w-]+/g, '[REDACTED_KEY]')
      .replace(/sb_publishable_[\w-]+/g, '[REDACTED_KEY]');
  }
  if (value instanceof Error) {
    return value.stack ? redact(value.stack) : value.message;
  }
  if (value && typeof value === 'object') {
    try {
      return JSON.parse(redact(JSON.stringify(value)));
    } catch {
      return value;
    }
  }
  return value;
}

/** Timestamp in the container's local time, ISO-ish for easy grepping. */
function stamp() {
  const now = new Date();
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

function emit(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  const prefix = `${paint('90', stamp())} ${paint(PALETTE[level], LABEL[level])} ${paint('35', `[${scope}]`)}`;
  const cleaned = args.map(redact);
  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  sink(prefix, ...cleaned);
}

/**
 * Create a logger bound to a scope name.
 * @param {string} scope usually the module or command name
 */
function createLogger(scope = 'bot') {
  return {
    trace: (...args) => emit('trace', scope, args),
    debug: (...args) => emit('debug', scope, args),
    info: (...args) => emit('info', scope, args),
    warn: (...args) => emit('warn', scope, args),
    error: (...args) => emit('error', scope, args),
    /** Derive a child logger, e.g. log.child('giveaway') */
    child: (sub) => createLogger(`${scope}:${sub}`),
    /** The scope this logger writes under. */
    scope,
  };
}

const root = createLogger('bot');

module.exports = root;
module.exports.createLogger = createLogger;
module.exports.redact = redact;
module.exports.LEVELS = LEVELS;
