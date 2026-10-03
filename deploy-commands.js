'use strict';

/**
 * Register slash commands with Discord - the manual, local path.
 *
 *   npm run deploy           register in every guild listed in GUILD_IDS
 *   npm run deploy:global    register globally (can take up to an hour)
 *   npm run deploy -- --force  re-register even if nothing changed
 *
 * The bot ALSO registers its commands automatically on startup (see
 * src/events/ready.js), so this script is a fallback rather than a required
 * step. Both paths share one implementation in src/core/registrar.js, so they
 * can never drift apart.
 *
 * Guild registration is the default because it appears instantly, which matters
 * while the command set is still changing.
 */

require('dotenv').config();

const path = require('node:path');

const config = require('./src/config');
const logger = require('./src/lib/logger');
const loader = require('./src/core/loader');
const registrar = require('./src/core/registrar');

const log = logger.child('deploy');

async function main() {
  config.assertValid();

  const global = process.argv.includes('--global');
  const force = process.argv.includes('--force');

  const registry = loader.loadCommands(path.join(__dirname, 'src', 'modules'));

  // eslint-disable-next-line no-console
  console.log(`\n${config.brand.name}'s bot - command registration`);
  // eslint-disable-next-line no-console
  console.log(`  application id : ${config.clientId}`);
  // eslint-disable-next-line no-console
  console.log(`  scope          : ${global ? 'global' : `guild (${config.guildIds.length})`}`);
  // eslint-disable-next-line no-console
  console.log(`  guild ids      : ${config.guildIds.join(', ') || '(none)'}`);
  // eslint-disable-next-line no-console
  console.log(`  commands       : ${registrar.buildBody(registry).length}\n`);

  if (!global && config.guildIds.length === 0) {
    // eslint-disable-next-line no-console
    console.error(
      'GUILD_IDS is empty. Set it to the server IDs the bot runs in, or run with --global.\n',
    );
    process.exit(1);
  }

  const summary = await registrar.registerCommands({ registry, global, force });

  // eslint-disable-next-line no-console
  console.log('');
  for (const guild of summary.guilds) {
    // eslint-disable-next-line no-console
    console.log(`\u2714 ${guild.guildId}: registered ${guild.count} command(s).`);
  }
  for (const guildId of summary.skipped) {
    // eslint-disable-next-line no-console
    console.log(`= ${guildId}: already up to date (use --force to re-send).`);
  }
  for (const failure of summary.failed) {
    // eslint-disable-next-line no-console
    console.error(`\u2716 ${failure.guildId}: ${failure.error}`);
  }

  if (summary.scope === 'global' && summary.registered > 0) {
    // eslint-disable-next-line no-console
    console.log('\nGlobal commands can take up to an hour to appear in every server.');
  }

  // eslint-disable-next-line no-console
  console.log(`\n${registrar.describe(summary)}\n`);

  if (!summary.ok) process.exit(1);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`\nCommand registration failed:\n${error?.stack || error?.message || error}\n`);
  process.exit(1);
});
