'use strict';

/**
 * Offline test for the slash-command registrar.
 *
 * Drives src/core/registrar.js against a fake REST client so the registration
 * logic - scope selection, the up-to-date skip, force, and per-guild failure
 * isolation - is verified without touching Discord.
 *
 *   node scripts/test-registrar.js
 */

const path = require('node:path');

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test.test.test';
process.env.CLIENT_ID = process.env.CLIENT_ID || '123456789012345678';
process.env.GUILD_IDS = process.env.GUILD_IDS || '111111111111111111,222222222222222222';

const config = require('../src/config');
const loader = require('../src/core/loader');
const registrar = require('../src/core/registrar');

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  \u2714 ${label}`);
  } else {
    failures += 1;
    console.log(`  \u2716 ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

/**
 * A fake REST client. `store` maps a route key to the commands Discord "has".
 * `failFor` is a set of guild ids whose PUT should throw.
 */
function fakeRest({ store = {}, failFor = new Set() } = {}) {
  const calls = { get: [], put: [] };
  return {
    calls,
    store,
    async get(route) {
      calls.get.push(route);
      return store[route] ?? null;
    },
    async put(route, { body }) {
      calls.put.push({ route, count: body.length });
      const guildId = route.match(/guilds\/(\d+)/)?.[1];
      if (guildId && failFor.has(guildId)) {
        const error = new Error('Missing Access');
        error.status = 403;
        throw error;
      }
      // Discord echoes the commands back with server-assigned fields.
      const echoed = body.map((command, index) => ({
        ...command,
        id: String(900000000000000000n + BigInt(index)),
        application_id: config.clientId,
        version: '1',
        ...(guildId ? { guild_id: guildId } : {}),
      }));
      store[route] = echoed;
      return echoed;
    },
  };
}

const GUILD_A = '111111111111111111';
const GUILD_B = '222222222222222222';
const routeGuild = (id) => `/applications/${config.clientId}/guilds/${id}/commands`;
const routeGlobal = `/applications/${config.clientId}/commands`;

async function main() {
  const registry = loader.loadCommands(path.join(__dirname, '..', 'src', 'modules'));
  const body = registrar.buildBody(registry);

  console.log('\nregistrar test\n');

  // ---- 1. payload ---------------------------------------------------------
  console.log('1. payload');
  check('builds a non-empty command body', body.length > 0, `got ${body.length}`);
  check('every payload has a name and description',
    body.every((c) => typeof c.name === 'string' && typeof c.description === 'string'));
  check('no duplicate command names',
    new Set(body.map((c) => c.name)).size === body.length);

  // ---- 2. fingerprint stability ------------------------------------------
  console.log('\n2. fingerprint');
  const hash = registrar.fingerprint(body);
  check('is deterministic', registrar.fingerprint(body) === hash);
  check('ignores top-level order',
    registrar.fingerprint([...body].reverse()) === hash);
  check('ignores server-assigned fields',
    registrar.fingerprint(body.map((c) => ({ ...c, id: '123', version: '9', application_id: 'x' }))) === hash);
  check('detects a real change',
    registrar.fingerprint([...body.slice(1), { name: 'zzz_new', description: 'new' }]) !== hash);
  check('detects a changed description',
    registrar.fingerprint(body.map((c, i) => (i === 0 ? { ...c, description: 'changed' } : c))) !== hash);

  // ---- 3. first run registers --------------------------------------------
  console.log('\n3. first run (nothing registered yet)');
  let rest = fakeRest();
  let summary = await registrar.registerCommands({ registry, global: false, rest });
  check('reports ok', summary.ok === true);
  check('scope is guild', summary.scope === 'guild');
  check('PUT once per guild', rest.calls.put.length === 2, `got ${rest.calls.put.length}`);
  check('registered both guilds', summary.guilds.length === 2);
  check('registered count is commands x guilds',
    summary.registered === body.length * 2, `got ${summary.registered}`);
  check('nothing skipped', summary.skipped.length === 0);
  check('nothing failed', summary.failed.length === 0);

  // ---- 4. second run skips ------------------------------------------------
  console.log('\n4. second run (unchanged)');
  rest = fakeRest({ store: rest.store });
  summary = await registrar.registerCommands({ registry, global: false, rest });
  check('reports ok', summary.ok === true);
  check('no PUT issued', rest.calls.put.length === 0, `got ${rest.calls.put.length}`);
  check('both guilds skipped', summary.skipped.length === 2);
  check('registered count is 0', summary.registered === 0);

  // ---- 5. force re-registers ---------------------------------------------
  console.log('\n5. force');
  rest = fakeRest({ store: rest.store });
  summary = await registrar.registerCommands({ registry, global: false, force: true, rest });
  check('PUT issued despite being up to date', rest.calls.put.length === 2);

  // ---- 6. changed command set re-registers -------------------------------
  console.log('\n6. changed command set');
  const staleStore = { [routeGuild(GUILD_A)]: [{ name: 'old', description: 'stale' }] };
  rest = fakeRest({ store: staleStore });
  summary = await registrar.registerCommands({ registry, global: false, rest });
  check('re-registers when the remote set differs', rest.calls.put.length === 2);

  // ---- 7. per-guild failure isolation ------------------------------------
  console.log('\n7. one guild fails');
  rest = fakeRest({ failFor: new Set([GUILD_B]) });
  summary = await registrar.registerCommands({ registry, global: false, rest });
  check('overall ok is false', summary.ok === false);
  check('the good guild still registered', summary.guilds.length === 1 && summary.guilds[0].guildId === GUILD_A);
  check('the bad guild is reported', summary.failed.length === 1 && summary.failed[0].guildId === GUILD_B);
  check('the error message is preserved', /Missing Access/.test(summary.failed[0].error));

  // ---- 8. global scope ----------------------------------------------------
  console.log('\n8. global scope');
  rest = fakeRest();
  summary = await registrar.registerCommands({ registry, global: true, rest });
  check('scope is global', summary.scope === 'global');
  check('PUT to the global route', rest.calls.put[0]?.route === routeGlobal);
  check('registered once', summary.registered === body.length);

  // ---- 9. scope auto-selection -------------------------------------------
  console.log('\n9. scope auto-selection from GUILD_IDS');
  const savedGuilds = config.guildIds;
  config.guildIds = [];
  rest = fakeRest();
  summary = await registrar.registerCommands({ registry, rest });
  check('empty GUILD_IDS falls back to global', summary.scope === 'global');
  config.guildIds = savedGuilds;

  // ---- 10. guards ---------------------------------------------------------
  console.log('\n10. guards');
  summary = await registrar.registerCommands({ registry: { list: [] }, rest: fakeRest() });
  check('empty registry is refused', summary.ok === false && summary.reason === 'no-commands');

  const savedClientId = config.clientId;
  config.clientId = '';
  summary = await registrar.registerCommands({ registry, rest: fakeRest() });
  check('missing CLIENT_ID is refused', summary.ok === false && summary.reason === 'no-client-id');
  config.clientId = savedClientId;

  // ---- 11. describe -------------------------------------------------------
  console.log('\n11. describe');
  rest = fakeRest();
  summary = await registrar.registerCommands({ registry, global: false, rest });
  const line = registrar.describe(summary);
  check('describe names the scope', /scope=guild/.test(line), line);
  check('describe names the app id', line.includes(config.clientId), line);
  check('describe names the command count', line.includes(`commands=${body.length}`), line);

  console.log(`\n${failures === 0 ? '\u2714' : '\u2716'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\ntest crashed:', error);
  process.exit(1);
});
