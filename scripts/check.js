'use strict';

/**
 * Static health check.
 *
 * Loads every command, event handler and background task the way index.js does,
 * builds the component router, and serialises every slash payload. Prints a
 * summary and exits non-zero if anything failed to load.
 *
 *   npm run check
 *   npm run check:strict   also fail on warnings
 *
 * No Discord connection and no database are required: it reads DISCORD_TOKEN et
 * al. only because config.js validates them on load.
 */

require('dotenv').config();

const path = require('node:path');

// config.js insists on a plausible environment. Fill in placeholders when the
// real values are absent so the check works in CI without secrets.
process.env.DISCORD_TOKEN ||= 'check.placeholder.token';
process.env.CLIENT_ID ||= '000000000000000000';
process.env.GUILD_IDS ||= '000000000000000000';
process.env.SUPABASE_URL ||= 'https://placeholder.supabase.co';
process.env.SUPABASE_KEY ||= 'placeholder-service-role-key';
process.env.LOG_LEVEL ||= 'error';

const logger = require('../src/lib/logger');
const loader = require('../src/core/loader');
const components = require('../src/core/components');

const strict = process.argv.includes('--strict');
const root = path.join(__dirname, '..');

const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
  // eslint-disable-next-line no-console
  console.error(`✖ ${message}`);
}

function warn(message) {
  warnings.push(message);
  // eslint-disable-next-line no-console
  console.warn(`⚠ ${message}`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const registry = loader.loadCommands(path.join(root, 'src', 'modules'));

if (registry.list.length === 0) fail('no commands loaded');

for (const problem of registry.problems ?? []) fail(`command problem: ${problem}`);

// Duplicate names are reported as problems by the loader; re-check the count.
const byName = new Map();
for (const command of registry.list) {
  if (byName.has(command.name)) fail(`duplicate command "${command.name}"`);
  byName.set(command.name, command);

  if (!command.description) warn(`"${command.name}" has no description`);
  if (!command.run && !command.execute) fail(`"${command.name}" has no run handler`);
  if (!command.module) warn(`"${command.name}" has no module`);

  // The payload is built at load time; a throw here means a bad argument spec.
  if (!command.slashData) fail(`"${command.name}" produced no slash payload`);
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const router = components.buildRouter(registry);
const prefixes = new Set();
for (const command of registry.list) {
  if (!command.components) continue;
  for (const prefix of Object.keys(command.components)) {
    if (prefixes.has(prefix)) fail(`duplicate component prefix "${prefix}"`);
    prefixes.add(prefix);
  }
}

// ---------------------------------------------------------------------------
// Events & tasks
// ---------------------------------------------------------------------------

const events = loader.loadEvents(path.join(root, 'src', 'events'));
if (events.length === 0) fail('no event handlers loaded');

const seenEvents = new Set();
for (const handler of events) {
  if (typeof handler.execute !== 'function') fail(`event "${handler.name}" has no execute`);
  if (handler.once && seenEvents.has(`once:${handler.name}`)) warn(`duplicate once listener "${handler.name}"`);
  seenEvents.add(`${handler.once ? 'once:' : 'on:'}${handler.name}`);
}

const tasks = loader.loadTasks(path.join(root, 'src', 'tasks'));
for (const task of tasks) {
  if (typeof task.run !== 'function') fail(`task "${task.name}" has no run`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-console
console.log('');
// eslint-disable-next-line no-console
console.log(`  commands   ${registry.list.length}`);
// eslint-disable-next-line no-console
console.log(`  aliases    ${registry.aliases.size}`);
// eslint-disable-next-line no-console
console.log(`  components ${router.routes.length}`);
// eslint-disable-next-line no-console
console.log(`  events     ${events.length}`);
// eslint-disable-next-line no-console
console.log(`  tasks      ${tasks.length}`);
// eslint-disable-next-line no-console
console.log('');

if (warnings.length > 0) {
  // eslint-disable-next-line no-console
  console.log(`${warnings.length} warning(s)`);
}

if (errors.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`\n${errors.length} error(s) - fix these before deploying.\n`);
  process.exit(1);
}

if (strict && warnings.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`\n${warnings.length} warning(s) in strict mode.\n`);
  process.exit(1);
}

logger.child('check').info('all good');
// eslint-disable-next-line no-console
console.log('✔ everything loaded.\n');
