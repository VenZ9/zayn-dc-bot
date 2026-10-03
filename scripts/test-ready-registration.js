'use strict';

/**
 * Integration test for automatic registration on startup.
 *
 * Fires the real `ready` event handler with a stubbed client and a deliberately
 * invalid token, so the registrar makes a genuine HTTPS call to Discord and gets
 * an auth error. That proves three things at once:
 *
 *   1. ready.js actually reaches the registrar (the code path runs)
 *   2. the startup diagnostics are logged (app id, guild ids, command count)
 *   3. a registration failure is NON-FATAL - the bot still finishes booting
 *
 * Output is captured by intercepting process.stdout, because the logger writes
 * there and `logger.child()` returns a fresh object that cannot be patched from
 * the outside.
 *
 *   node scripts/test-ready-registration.js
 */

const path = require('node:path');

process.env.DISCORD_TOKEN = 'invalid.token.for-testing';
process.env.CLIENT_ID = '123456789012345678';
process.env.GUILD_IDS = '111111111111111111';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_KEY = 'test-key';
process.env.TASKS_ENABLED = 'false';
process.env.HEALTH_ENABLED = 'false';
process.env.AUTO_REGISTER_COMMANDS = 'true';

// ---- capture stdout AND stderr before anything else loads ------------------
// The logger sends info to stdout but warn/error to stderr, so both streams
// have to be intercepted or the failure-path assertions see nothing.
const captured = [];
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk, ...rest) => {
  captured.push(String(chunk));
  return originalStdoutWrite(chunk, ...rest);
};
process.stderr.write = (chunk, ...rest) => {
  captured.push(String(chunk));
  return originalStderrWrite(chunk, ...rest);
};

const loader = require('../src/core/loader');
const ready = require('../src/events/ready');

let failures = 0;
let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (condition) console.log(`  \u2714 ${label}`);
  else { failures += 1; console.log(`  \u2716 ${label}${detail ? ` - ${detail}` : ''}`); }
}

/** A client stub with just enough surface for the ready handler. */
function stubClient(registry) {
  const guilds = new Map([['111111111111111111', { id: '111111111111111111', name: 'Test Guild' }]]);
  guilds.cache = {
    size: guilds.size,
    has: (id) => guilds.has(id),
    filter: () => ({ map: () => [] }),
  };
  return {
    registry,
    user: { tag: 'TestBot#0001', id: '123456789012345678', setPresence: () => {} },
    guilds,
    users: { cache: { size: 1 } },
    ws: { ping: 42 },
    options: { intents: { has: () => true } },
  };
}

async function main() {
  console.log('\nready-event auto-registration test\n');

  const registry = loader.loadCommands(path.join(__dirname, '..', 'src', 'modules'));
  const client = stubClient(registry);

  console.log('1. handler runs without throwing');
  let threw = null;
  try {
    await ready.execute(client);
  } catch (error) {
    threw = error;
  }
  check('ready handler completed (failure is non-fatal)', threw === null, threw?.message);

  const text = captured.join('');

  console.log('\n2. startup diagnostics are logged');
  check('logs the application id', text.includes('application id: 123456789012345678'));
  check('logs the guild scope', text.includes('guild scope: 111111111111111111'));
  check('logs the command count', /slash commands to register: \d+/.test(text));
  check('logs the command count as 48', text.includes('slash commands to register: 48'));

  console.log('\n3. the registration attempt actually happened');
  check('reached the registrar (a registration summary was logged)',
    /registration: scope=/.test(text));
  check('the bad token produced a real API-layer error',
    /registration failed|Expected token|401|Unauthorized/i.test(text));

  console.log('\n4. failure is reported, not swallowed');
  check('warns the operator to run npm run deploy', /npm run deploy/.test(text));

  console.log('\n5. the rest of boot still ran');
  check('logged in line present', /logged in as TestBot#0001/.test(text));
  check('presence was set (no presence error)', !/could not set presence/.test(text));
  check('the database client initialised (no WebSocket crash)',
    !/without native WebSocket support/.test(text));

  console.log(`\n${failures === 0 ? '\u2714' : '\u2716'} ${checks - failures}/${checks} checks passed\n`);
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  console.error('\ntest crashed:', error);
  process.exit(1);
});
