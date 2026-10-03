'use strict';

/**
 * Optional health-check HTTP server.
 *
 * A Discord bot does not need to listen on a port to work, but every PaaS
 * (Fly.io, Koyeb, Railway, Render) wants *something* to probe so it can tell a
 * healthy machine from a wedged one. This module binds a tiny HTTP server that
 * answers liveness and readiness questions and then gets out of the way.
 *
 *   GET /            -> 200, one-line summary (also the default probe target)
 *   GET /health      -> 200 when the process is up, 503 while shutting down
 *   GET /healthz     -> alias of /health
 *   GET /ready       -> 200 only once the Discord client is logged in and the
 *                       database round-trip succeeds; 503 otherwise
 *   GET /metrics     -> 200, Prometheus-style text counters
 *
 * The server is deliberately dependency-free and never throws: if the port is
 * already taken the bot still starts, it just logs a warning. A bot that cannot
 * bind a health port is still a working bot.
 *
 * Fly.io note: `fly.toml` declares an internal_port and a TCP check against it.
 * Fly injects PORT, so the server binds whatever PORT says (default 8000).
 */

const http = require('node:http');

const config = require('../config');
const logger = require('../lib/logger');

const log = logger.child('health');

/** Set once the Discord client is ready; drives /ready. */
let readyAt = null;
/** Set while a shutdown is in progress so probes start failing. */
let shuttingDown = false;
/** The live http.Server, or null when the endpoint is disabled. */
let server = null;

/** Milliseconds since the process started. */
function uptimeMs() {
  return Math.round(process.uptime() * 1000);
}

/** Human-readable uptime, e.g. "3h 12m 4s". */
function formatUptime(ms) {
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

/**
 * Snapshot of the bot's state, used by every endpoint.
 * @param {import('discord.js').Client|null} client
 */
function snapshot(client) {
  const loggedIn = Boolean(client && client.isReady && client.isReady());
  return {
    ok: !shuttingDown,
    status: shuttingDown ? 'shutting_down' : (loggedIn ? 'ready' : 'starting'),
    bot: config.brand.name,
    brand: config.brand.discord,
    uptimeMs: uptimeMs(),
    uptime: formatUptime(uptimeMs()),
    readyAt: readyAt ? new Date(readyAt).toISOString() : null,
    discord: {
      loggedIn,
      user: loggedIn ? client.user.tag : null,
      id: loggedIn ? client.user.id : null,
      ping: loggedIn ? Math.round(client.ws.ping) : null,
      guilds: loggedIn ? client.guilds.cache.size : 0,
      users: loggedIn ? client.users.cache.size : 0,
    },
    database: {
      configured: config.hasDatabase,
    },
    tasks: {
      enabled: config.tasksEnabled,
      intervalSeconds: config.taskIntervalSeconds,
    },
    node: process.version,
    env: config.nodeEnv,
  };
}

/** Send a JSON response. */
function sendJson(res, statusCode, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Send a plain-text response. */
function sendText(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * Build the request handler. Exported so tests can drive it without a socket.
 * @param {() => import('discord.js').Client|null} getClient
 */
function createHandler(getClient) {
  return async function handle(req, res) {
    // Only GET/HEAD are meaningful here; anything else is a client mistake.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }

    // Strip the query string and any trailing slash: "/health/" == "/health".
    const path = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
    const client = getClient();
    const state = snapshot(client);

    try {
      switch (path) {
        case '/':
        case '/health':
        case '/healthz': {
          // Liveness: the process is alive and not shutting down.
          const code = state.ok ? 200 : 503;
          if (path === '/') {
            sendText(res, code, `${state.bot} - ${state.status} - up ${state.uptime}\n`);
          } else {
            sendJson(res, code, state);
          }
          return;
        }

        case '/ready': {
          // Readiness: logged in AND the database answers.
          let dbOk = true;
          let dbError = null;
          let dbLatency = null;

          if (config.hasDatabase) {
            try {
              const db = require('../db');
              const ping = await db.ping();
              dbOk = Boolean(ping.ok);
              dbError = ping.error || null;
              dbLatency = ping.latencyMs ?? null;
            } catch (error) {
              dbOk = false;
              dbError = error.message;
            }
          }

          const ready = state.ok && state.discord.loggedIn && dbOk;
          sendJson(res, ready ? 200 : 503, {
            ...state,
            ready,
            database: { ...state.database, ok: dbOk, latencyMs: dbLatency, error: dbError },
          });
          return;
        }

        case '/metrics': {
          // Prometheus text exposition format - enough for a basic dashboard.
          const lines = [
            '# HELP bot_up 1 when the process is running and not shutting down.',
            '# TYPE bot_up gauge',
            `bot_up ${state.ok ? 1 : 0}`,
            '# HELP bot_ready 1 when logged in to Discord.',
            '# TYPE bot_ready gauge',
            `bot_ready ${state.discord.loggedIn ? 1 : 0}`,
            '# HELP bot_uptime_seconds Process uptime in seconds.',
            '# TYPE bot_uptime_seconds counter',
            `bot_uptime_seconds ${Math.floor(uptimeMs() / 1000)}`,
            '# HELP bot_guilds Number of guilds the bot is in.',
            '# TYPE bot_guilds gauge',
            `bot_guilds ${state.discord.guilds}`,
            '# HELP bot_ws_ping_ms Discord gateway latency in milliseconds.',
            '# TYPE bot_ws_ping_ms gauge',
            `bot_ws_ping_ms ${state.discord.ping ?? 0}`,
            '',
          ];
          sendText(res, 200, lines.join('\n'));
          return;
        }

        default:
          sendJson(res, 404, { error: 'not_found', path });
      }
    } catch (error) {
      log.error('request failed:', error);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.end();
    }
  };
}

/**
 * Start the health server.
 *
 * @param {import('discord.js').Client|null} client
 * @returns {import('node:http').Server|null} the server, or null when disabled
 */
function start(client) {
  if (!config.healthEnabled) {
    log.info('health endpoint disabled (HEALTH_ENABLED=false)');
    return null;
  }

  if (server) return server;

  const handler = createHandler(() => client);
  server = http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      log.error('unhandled request error:', error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  // A probe that arrives while the socket is busy should not queue forever.
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10000;

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      log.warn(
        `port ${config.port} is already in use - the health endpoint is off, `
        + 'but the bot itself is unaffected.',
      );
    } else {
      log.error('health server error:', error);
    }
    server = null;
  });

  server.listen(config.port, '0.0.0.0', () => {
    log.info(`health endpoint listening on 0.0.0.0:${config.port} (/, /health, /ready, /metrics)`);
  });

  return server;
}

/** Mark the bot as ready - flips /ready to 200. */
function markReady() {
  readyAt = Date.now();
}

/** Mark the bot as shutting down - flips /health to 503 so the platform drains. */
function markShuttingDown() {
  shuttingDown = true;
}

/** Stop the server. Resolves even if it was never started. */
function stop() {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    const closing = server;
    server = null;
    closing.close(() => resolve());
    // Do not let a lingering keep-alive socket hold the process open.
    setTimeout(() => {
      try {
        closing.closeAllConnections?.();
      } catch {
        /* older Node - nothing to do */
      }
      resolve();
    }, 2000).unref?.();
  });
}

module.exports = {
  start,
  stop,
  markReady,
  markShuttingDown,
  snapshot,
  createHandler,
  formatUptime,
  get server() {
    return server;
  },
};
