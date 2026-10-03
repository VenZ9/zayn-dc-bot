'use strict';

/**
 * Component router.
 *
 * Buttons, select menus and modals are routed by customId prefix. A module
 * declares its handlers alongside its command:
 *
 *   components: {
 *     'gw:enter': async (interaction) => { ... },
 *     'gw:list':  async (interaction) => { ... },
 *   }
 *
 * Matching uses the longest registered prefix, so both `gw` and `gw:enter` can
 * coexist and the more specific one wins. Handlers always receive the
 * interaction plus a Context, and are wrapped so a throw becomes an ephemeral
 * error rather than a silently dead button.
 */

const { MessageFlags } = require('discord.js');
const logger = require('../lib/logger');
const embeds = require('../lib/embeds');
const helpers = require('../lib/helpers');
const context = require('./context');

const log = logger.child('components');

/**
 * Build the router from the loaded command registry.
 *
 * @param {{ list: object[] }} registry
 * @returns {{ handle: (interaction: any) => Promise<boolean>, routes: string[] }}
 */
function buildRouter(registry) {
  /** @type {Map<string, Function>} */
  const routes = new Map();

  for (const command of registry.list) {
    if (!command.components || typeof command.components !== 'object') continue;

    for (const [prefix, handlerFn] of Object.entries(command.components)) {
      if (typeof handlerFn !== 'function') {
        log.warn(`${command.name}: component handler "${prefix}" is not a function - skipped`);
        continue;
      }
      if (routes.has(prefix)) {
        log.warn(`component prefix "${prefix}" already registered - later definition ignored`);
        continue;
      }
      routes.set(prefix, handlerFn);
    }
  }

  // Longest prefix first, so `gw:enter` is preferred over `gw`.
  const ordered = [...routes.entries()].sort((a, b) => b[0].length - a[0].length);

  /**
   * Find the handler whose prefix matches this customId.
   * @param {string} customId
   */
  function match(customId) {
    if (!customId) return null;
    for (const [prefix, handlerFn] of ordered) {
      // Exact match, or the prefix followed by the `:` separator. Requiring the
      // separator stops `gw` from hijacking `gwlist:1`.
      if (customId === prefix || customId.startsWith(`${prefix}:`)) {
        return handlerFn;
      }
    }
    return null;
  }

  /**
   * Dispatch an interaction. Returns true when a handler ran.
   * @param {import('discord.js').Interaction} interaction
   */
  async function handle(interaction) {
    const customId = interaction.customId;
    const handlerFn = match(customId);

    if (!handlerFn) {
      log.debug(`no handler for component "${customId}"`);
      // Always acknowledge so the user does not get "This interaction failed".
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          embeds: [embeds.warning('Expired', 'This control is no longer active. Run the command again.')],
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
      return false;
    }

    // Build a context so handlers get the guild config and reply helpers.
    let guildConfig = {};
    if (interaction.guildId) {
      try {
        const db = require('../db');
        guildConfig = await db.getGuildConfig(interaction.guildId);
      } catch (error) {
        log.warn(`component context config load failed: ${error.message}`);
      }
    }
    const ctx = context.fromComponent(interaction, { guildConfig });

    try {
      await handlerFn(interaction, ctx);
      return true;
    } catch (error) {
      log.error(`component "${customId}" threw:`, error);

      const payload = {
        embeds: [
          embeds.error(
            'Something went wrong',
            'That control could not be completed. The error has been logged.',
          ),
        ],
      };

      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
      } else if (interaction.deferred && !interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
      }

      return true;
    }
  }

  return { handle, routes: [...routes.keys()], match };
}

/**
 * Helper for modules: acknowledge a component interaction safely, whether it is
 * a button, a select menu or a modal submit.
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {{ content?: string, embeds?: any[], ephemeral?: boolean }} payload
 */
async function respond(interaction, payload = {}) {
  const { ephemeral = true, ...rest } = payload;
  const flags = ephemeral ? MessageFlags.Ephemeral : undefined;

  if (interaction.deferred) {
    return interaction.editReply(rest).catch(() => null);
  }
  if (interaction.replied) {
    return interaction.followUp({ ...rest, flags }).catch(() => null);
  }
  return interaction.reply({ ...rest, flags }).catch(() => null);
}

/** Shortcut for an ephemeral error on a component. */
const failComponent = (interaction, message, title = 'Not possible') =>
  respond(interaction, { embeds: [embeds.error(title, message)] });

/** Shortcut for an ephemeral success on a component. */
const okComponent = (interaction, message, title = 'Done') =>
  respond(interaction, { embeds: [embeds.success(title, message)] });

module.exports = {
  buildRouter,
  respond,
  failComponent,
  okComponent,
  truncate: helpers.truncate,
};
