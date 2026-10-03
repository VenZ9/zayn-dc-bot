'use strict';

/**
 * ready event.
 *
 * Logs the identity, warns about any guild in GUILD_IDS the bot is not actually
 * in (the most common "why are my commands missing" cause), pops the presence,
 * and kicks off the background scheduler.
 */

const { ActivityType } = require('discord.js');
const config = require('../config');
const logger = require('../lib/logger');
const { describeIntentStatus } = require('../core/client');

const log = logger.child('ready');

module.exports = {
  name: 'ready',
  once: true,
  async execute(client) {
    const { user, guilds } = client;

    log.info(`logged in as ${user.tag} (${user.id})`);
    log.info(`serving ${guilds.cache.size} guild(s) for ${client.users.cache.size} cached user(s)`);

    // ---- guild sanity ----------------------------------------------------
    const missing = config.guildIds.filter((id) => !guilds.cache.has(id));
    if (missing.length > 0) {
      log.warn(
        `GUILD_IDS lists ${missing.length} server(s) the bot is not in: ${missing.join(', ')}. `
        + 'Invite the bot, or remove them from GUILD_IDS.',
      );
    }

    const notListed = guilds.cache
      .filter((guild) => !config.guildIds.includes(guild.id))
      .map((guild) => `${guild.name} (${guild.id})`);
    if (notListed.length > 0) {
      log.warn(
        `in ${notListed.length} server(s) that are NOT in GUILD_IDS, so commands are not `
        + `registered there: ${notListed.join(', ')}`,
      );
    }

    // ---- presence --------------------------------------------------------
    // Branding lives here too: "Watching over N servers | ZAYN'S DC".
    try {
      client.user.setPresence({
        status: 'online',
        activities: [{
          name: `${config.brand.discord}`.slice(0, 128),
          type: ActivityType.Custom,
          state: `/help | ${config.brand.discord}`.slice(0, 128),
        }],
      });
    } catch (error) {
      log.warn('could not set presence:', error.message);
    }

    // ---- intents ---------------------------------------------------------
    const intents = describeIntentStatus(client);
    const denied = intents.filter((entry) => entry.granted === false);
    if (denied.length > 0) {
      log.warn('these intents are NOT granted - related features will not work:');
      for (const entry of denied) log.warn(`  - ${entry.name}: ${entry.reason}`);
    }
    log.debug(`privileged intents in use: ${intents.filter((i) => i.privileged).map((i) => i.name).join(', ')}`);

    // ---- database --------------------------------------------------------
    const db = require('../db');
    const health = await db.ping();
    if (health.ok) {
      log.info(`Supabase reachable (${health.latencyMs}ms)`);
    } else if (health.enabled) {
      log.error(
        `Supabase unreachable: ${health.error}. Commands that read or write data will fail. `
        + 'Check SUPABASE_URL / SUPABASE_KEY and that schema.sql has been run.',
      );
    }

    // ---- background tasks -------------------------------------------------
    if (config.tasksEnabled) {
      try {
        const scheduler = require('../tasks/scheduler');
        scheduler.start(client);
      } catch (error) {
        log.error('could not start the scheduler:', error);
      }
    } else {
      log.info('background tasks are disabled (TASKS_ENABLED=false)');
    }

    // Flip the health endpoint's /ready probe to 200 now that we are logged in.
    try {
      require('../core/health').markReady();
    } catch (error) {
      log.warn('could not mark health as ready:', error.message);
    }

    log.info(`ready - ${Math.round(client.ws.ping)}ms ping | ${config.brand.footer}`);
  },
};
