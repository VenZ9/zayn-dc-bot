'use strict';

/**
 * Command and event loader.
 *
 * Walks the source tree, requires every command module, validates definitions
 * and builds the lookup structures the runners need.
 *
 * A command file may export:
 *   - a single command          (module.exports = defineCommand({...}))
 *   - an array of commands      (module.exports = [cmdA, cmdB])
 *   - a bag of commands         (module.exports = { commands: [cmdA, cmdB] })
 *
 * The bag form lets a module keep its subcommand helpers alongside the command
 * without them leaking into the registry.
 */

const fs = require('node:fs');
const path = require('node:path');
const logger = require('../lib/logger');
const { defineCommand } = require('./command');

const log = logger.child('loader');

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

/** Recursively list every `.js` file under `dir`. Missing dirs return []. */
function walk(dir) {
  if (!fs.existsSync(dir)) return [];

  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.startsWith('_')) {
      found.push(full);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Command loading
// ---------------------------------------------------------------------------

/**
 * Load every command under `src/commands`.
 *
 * @param {string} commandsDir
 * @returns {{ commands: Map<string, object>, aliases: Map<string, string>, list: object[], byModule: Record<string, object[]> }}
 */
function loadCommands(commandsDir) {
  const commands = new Map();
  const aliases = new Map();
  const problems = [];

  const files = walk(commandsDir);
  if (files.length === 0) {
    log.warn(`no command files found under ${commandsDir}`);
  }

  for (const file of files) {
    let exported;
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      exported = require(file);
    } catch (error) {
      problems.push(`${path.relative(commandsDir, file)}: ${error.message}`);
      log.error(`failed to require ${path.relative(commandsDir, file)}:`, error);
      continue;
    }

    const relative = path.relative(commandsDir, file);
    const definitions = normaliseExports(exported);

    if (definitions.length === 0) {
      log.debug(`no commands exported from ${relative}`);
      continue;
    }

    for (const definition of definitions) {
      // Infer the module from the folder name when not set explicitly, so a
      // command dropped into commands/moderation/ is grouped correctly.
      if (!definition.module) {
        definition.module = path.basename(path.dirname(file));
      }

      let command;
      try {
        command = defineCommand(definition);
      } catch (error) {
        problems.push(`${relative} (${definition?.name || 'unnamed'}): ${error.message}`);
        log.error(`invalid command definition in ${relative}:`, error.message);
        continue;
      }

      command.file = file;

      if (commands.has(command.name)) {
        const existing = commands.get(command.name);
        problems.push(
          `duplicate command name "${command.name}" in ${relative} `
          + `(already defined in ${path.relative(commandsDir, existing.file)})`,
        );
        log.error(`duplicate command "${command.name}" - keeping the first definition`);
        continue;
      }

      commands.set(command.name, command);

      // Register aliases, skipping any that would shadow a real command name.
      for (const alias of command.aliases) {
        if (commands.has(alias)) {
          log.warn(`alias "${alias}" for "${command.name}" shadows a command - ignored`);
          continue;
        }
        if (aliases.has(alias)) {
          log.warn(`alias "${alias}" already mapped to "${aliases.get(alias)}" - ignored for "${command.name}"`);
          continue;
        }
        aliases.set(alias, command.name);
      }
    }
  }

  const list = [...commands.values()];

  // Group by module for /help.
  const byModule = {};
  for (const command of list) {
    const key = command.module || 'misc';
    (byModule[key] ||= []).push(command);
  }
  for (const key of Object.keys(byModule)) {
    byModule[key].sort((a, b) => a.name.localeCompare(b.name));
  }

  if (problems.length > 0) {
    log.warn(`${problems.length} command definition problem(s):`);
    for (const problem of problems) log.warn(`  - ${problem}`);
  }

  log.info(`loaded ${list.length} commands, ${aliases.size} aliases`);

  return { commands, aliases, list, byModule, problems };
}

/** Normalise whatever a command file exported into an array of definitions. */
function normaliseExports(exported) {
  if (!exported) return [];
  if (Array.isArray(exported)) return exported.filter(Boolean);
  if (Array.isArray(exported.commands)) return exported.commands.filter(Boolean);
  if (exported.commands && typeof exported.commands === 'object') return Object.values(exported.commands).filter(Boolean);
  if (typeof exported === 'object') {
    // A single definition has a `name`; anything else is a bag of exports we
    // ignore (helpers, constants).
    if (exported.name) return [exported];
    return [];
  }
  return [];
}

/** Resolve a command by name or alias. */
function resolveCommand(registry, name) {
  const lowered = String(name || '').toLowerCase();
  if (registry.commands.has(lowered)) return registry.commands.get(lowered);
  const canonical = registry.aliases.get(lowered);
  if (canonical) return registry.commands.get(canonical);
  return null;
}

// ---------------------------------------------------------------------------
// Event loading
// ---------------------------------------------------------------------------

/**
 * Load every event module under `src/events`.
 *
 * Each file exports `{ name, once?, execute }` or an array of those.
 *
 * @param {string} eventsDir
 * @returns {Array<{ name: string, once: boolean, execute: Function, file: string }>}
 */
function loadEvents(eventsDir) {
  const handlers = [];
  const files = walk(eventsDir);

  for (const file of files) {
    let exported;
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      exported = require(file);
    } catch (error) {
      log.error(`failed to require ${path.relative(eventsDir, file)}:`, error);
      continue;
    }

    const definitions = Array.isArray(exported) ? exported : [exported];
    const relative = path.relative(eventsDir, file);

    for (const definition of definitions) {
      if (!definition || typeof definition !== 'object') continue;
      if (!definition.name || typeof definition.execute !== 'function') {
        log.warn(`${relative} does not export { name, execute } - skipped`);
        continue;
      }
      handlers.push({
        name: definition.name,
        once: definition.once === true,
        execute: definition.execute,
        file,
      });
    }
  }

  log.info(`loaded ${handlers.length} event handler(s)`);
  return handlers;
}

/** Load the scheduled background tasks under `src/tasks`. */
function loadTasks(tasksDir) {
  const tasks = [];
  const files = walk(tasksDir);

  for (const file of files) {
    let exported;
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      exported = require(file);
    } catch (error) {
      log.error(`failed to require task ${path.relative(tasksDir, file)}:`, error);
      continue;
    }

    const definitions = Array.isArray(exported) ? exported : [exported];

    for (const definition of definitions) {
      if (!definition || typeof definition !== 'object') continue;
      // A task is anything with `run` and an `name`.
      if (typeof definition.run !== 'function' || !definition.name) {
        continue;
      }
      tasks.push({
        name: definition.name,
        run: definition.run,
        intervalMs: definition.intervalMs ?? null,
        file,
      });
    }
  }

  log.info(`loaded ${tasks.length} background task(s)`);
  return tasks;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Attach loaded events to the client.
 * @param {import('discord.js').Client} client
 * @param {Array<{ name: string, once: boolean, execute: Function }>} handlers
 */
function registerEvents(client, handlers) {
  for (const handler of handlers) {
    const wrapped = async (...args) => {
      try {
        await handler.execute(client, ...args);
      } catch (error) {
        // An event handler throwing must never take the process down.
        log.error(`event "${handler.name}" threw:`, error);
      }
    };

    if (handler.once) client.once(handler.name, wrapped);
    else client.on(handler.name, wrapped);
  }
}

module.exports = {
  walk,
  loadCommands,
  loadEvents,
  loadTasks,
  normaliseExports,
  resolveCommand,
  registerEvents,
};
