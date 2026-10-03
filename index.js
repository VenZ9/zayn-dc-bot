'use strict';

/**
 * ZAYN'S DC BOT - entrypoint.
 *
 * Boot order:
 *   1. load .env
 *   2. fail fast on bad configuration
 *   3. load every command module and build the component router
 *   4. build the client and attach the event handlers
 *   5. log in
 *
 * The background scheduler is started by the `ready` event, not here, so it
 * only runs once the guild cache is populated.
 */

require('dotenv').config();

const path = require('node:path');

const config = require('./src/config');
const logger = require('./src/lib/logger');
const loader = require('./src/core/loader');
const components = require('./src/core/components');
const health = require('./src/core/health');
const { createClient } = require('./src/core/client');

const log = logger.child('boot');

/** Where the command modules and event handlers live. */
const MODULES_DIR = path.join(__dirname, 'src', 'modules');
const EVENTS_DIR = path.join(__dirname, 'src', 'events');

/**
 * Load commands, build the lookup structures and the component router.
 * The router and resolver are attached to the registry because the slash,
 * prefix and interaction entry points all read them from there.
 */
function buildRegistry() {
  const registry = loader.loadCommands(MODULES_DIR);

  if (registry.list.length === 0) {
    throw new Error(`No commands were loaded from ${MODULES_DIR}. Check the build.`);
  }

  registry.router = components.buildRouter(registry);
  registry.resolve = (name) => loader.resolveCommand(registry, name);

  if (registry.problems && registry.problems.length > 0) {
    log.warn(`${registry.problems.length} command definition problem(s) - see the warnings above.`);
  }

  return registry;
}

async function main() {
  // ---- 1. configuration ---------------------------------------------------
  config.assertValid();
  log.info(`${config.brand.name}'s bot starting (${config.isProduction ? 'production' : 'development'})`);

  if (!config.hasDatabase) {
    log.warn('Supabase is not configured - commands that persist data will fail.');
  }

  // ---- 2. commands --------------------------------------------------------
  const registry = buildRegistry();
  log.info(`registry ready: ${registry.commands.size} command(s), ${registry.router.routes.length} component route(s)`);

  // ---- 3. client ----------------------------------------------------------
  const client = createClient();
  client.registry = registry;

  // ---- 3b. health endpoint ------------------------------------------------
  // Bound before login so the platform's probe has something to talk to while
  // the gateway handshake is still in flight. Never fatal: a bot that cannot
  // bind a port is still a working bot.
  try {
    health.start(client);
  } catch (error) {
    log.warn('could not start the health endpoint:', error.message);
  }

  // ---- 4. events ----------------------------------------------------------
  const handlers = loader.loadEvents(EVENTS_DIR);
  loader.registerEvents(client, handlers);

  // ---- 5. shutdown --------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal} - shutting down`);

    // Fail the platform's liveness probe first so it stops routing to us while
    // we drain, then close the listener.
    try {
      health.markShuttingDown();
      await health.stop();
    } catch (error) {
      log.warn('health endpoint stop failed:', error.message);
    }

    try {
      if (config.tasksEnabled) {
        const scheduler = require('./src/tasks/scheduler');
        scheduler.stop();
      }
    } catch (error) {
      log.warn('scheduler stop failed:', error.message);
    }

    try {
      await client.destroy();
    } catch (error) {
      log.warn('client destroy failed:', error.message);
    }

    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection:', reason instanceof Error ? reason : String(reason));
  });
  process.on('uncaughtException', (error) => {
    log.error('uncaught exception:', error);
  });

  // ---- 6. login -----------------------------------------------------------
  log.info('logging in to Discord...');
  await client.login(config.token);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`\nFailed to start:\n${error?.stack || error?.message || error}\n`);
  process.exit(1);
});
