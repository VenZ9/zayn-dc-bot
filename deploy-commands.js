'use strict';

/**
 * Register slash commands with Discord.
 *
 *   npm run deploy           register in every guild listed in GUILD_IDS
 *   npm run deploy:global    register globally (can take up to an hour)
 *
 * Guild registration is the default because it appears instantly, which matters
 * while the command set is still changing.
 */

require('dotenv').config();

const path = require('node:path');
const { REST, Routes } = require('discord.js');

const config = require('./src/config');
const logger = require('./src/lib/logger');
const loader = require('./src/core/loader');

const log = logger.child('deploy');

/** Every command's slash payload, skipping any that opt out of slash. */
function buildBody(registry) {
  return registry.list
    .filter((command) => command.slashEnabled !== false && command.slashData)
    .map((command) => command.slashData);
}

async function main() {
  config.assertValid();

  const global = process.argv.includes('--global');
  const registry = loader.loadCommands(path.join(__dirname, 'src', 'modules'));
  const body = buildBody(registry);

  if (body.length === 0) {
    // eslint-disable-next-line no-console
    console.error('No slash commands to register.');
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(`Registering ${body.length} command(s) ${global ? 'globally' : `in ${config.guildIds.length} guild(s)`}...`);

  const rest = new REST({ version: '10' }).setToken(config.token);

  if (global) {
    const data = await rest.put(Routes.applicationCommands(config.clientId), { body });
    // eslint-disable-next-line no-console
    console.log(`✔ Registered ${data.length} global command(s). They may take up to an hour to appear.`);
    return;
  }

  if (config.guildIds.length === 0) {
    // eslint-disable-next-line no-console
    console.error(
      'GUILD_IDS is empty. Set it to the server IDs the bot runs in, or run with --global.',
    );
    process.exit(1);
  }

  for (const guildId of config.guildIds) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const data = await rest.put(
        Routes.applicationGuildCommands(config.clientId, guildId),
        { body },
      );
      // eslint-disable-next-line no-console
      console.log(`✔ ${guildId}: registered ${data.length} command(s).`);
    } catch (error) {
      log.error(`guild ${guildId} failed:`, error.message);
      // eslint-disable-next-line no-console
      console.error(`✖ ${guildId}: ${error.message}`);
    }
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`\nCommand registration failed:\n${error?.stack || error?.message || error}\n`);
  process.exit(1);
});
