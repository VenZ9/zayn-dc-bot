'use strict';

/**
 * Slash command runner.
 *
 * Resolves the command, loads the guild config, builds the Context and hands
 * off to the shared pipeline in core/handler.js.
 */

const logger = require('../lib/logger');
const embeds = require('../lib/embeds');
const context = require('./context');
const handler = require('./handler');
const helpers = require('../lib/helpers');

const log = logger.child('slash');

/**
 * Handle a chat input command interaction.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ commands: Map<string, object> }} registry
 */
async function handleChatInput(interaction, registry) {
  const command = registry.commands.get(interaction.commandName);

  if (!command) {
    log.warn(`unknown slash command "${interaction.commandName}" (stale registration?)`);
    const message = {
      embeds: [
        embeds.warning(
          'Command not recognised',
          `\`/${interaction.commandName}\` is not loaded by this bot build.\n`
          + 'If you recently updated, re-run `npm run deploy` to refresh the registrations.',
        ),
      ],
      ephemeral: true,
    };
    if (interaction.deferred || interaction.replied) await interaction.followUp(message).catch(() => {});
    else await interaction.reply(message).catch(() => {});
    return;
  }

  // ---- guild config -------------------------------------------------------
  let guildConfig = {};
  if (interaction.guildId) {
    try {
      const db = require('../db');
      guildConfig = await db.getGuildConfig(interaction.guildId);
    } catch (error) {
      log.warn(`could not load config for ${interaction.guildId}: ${error.message}`);
    }
  }

  const ctx = context.fromInteraction(interaction, command, guildConfig);

  // ---- run ----------------------------------------------------------------
  let result;
  try {
    result = await handler.runCommand(ctx, command);
  } catch (error) {
    // Only reached when something outside the handler threw (config loading,
    // reply plumbing). Still must not leave the user staring at "thinking…".
    log.error(`pipeline failure for /${command.name}:`, error);
    const fallback = {
      embeds: [embeds.error('Command failed', 'The command could not be completed. The error has been logged.')],
      ephemeral: true,
    };
    if (interaction.deferred || interaction.replied) await interaction.followUp(fallback).catch(() => {});
    else await interaction.reply(fallback).catch(() => {});
    return;
  }

  if (result.ok && interaction.guildId) {
    await handler.recordUsage(interaction.guildId);
  }
}

/**
 * Handle autocomplete for a command's options.
 *
 * A command may expose `autocomplete(interaction, focused)` returning an array
 * of `{ name, value }`. Returning an empty array is valid - Discord then shows
 * no suggestions rather than an error.
 *
 * @param {import('discord.js').AutocompleteInteraction} interaction
 * @param {{ commands: Map<string, object> }} registry
 */
async function handleAutocomplete(interaction, registry) {
  const command = registry.commands.get(interaction.commandName);
  if (!command || typeof command.autocomplete !== 'function') {
    await interaction.respond([]).catch(() => {});
    return;
  }

  try {
    const focused = interaction.options.getFocused(true);
    const choices = await command.autocomplete(interaction, focused);
    const safe = (Array.isArray(choices) ? choices : [])
      .slice(0, 25)
      .map((choice) => ({
        // Discord requires a string name <=100 chars and a value matching the
        // option type. Keep both safe.
        name: helpers.truncate(String(choice.name ?? choice.value ?? ''), 100) || '\u200b',
        value: typeof focused.value === 'number'
          ? Number(choice.value) || 0
          : String(choice.value ?? '').slice(0, 100),
      }));
    await interaction.respond(safe).catch(() => {});
  } catch (error) {
    log.warn(`autocomplete for /${interaction.commandName} failed:`, error.message);
    await interaction.respond([]).catch(() => {});
  }
}

module.exports = { handleChatInput, handleAutocomplete };
