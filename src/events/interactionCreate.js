'use strict';

/**
 * interactionCreate.
 *
 * One listener funnels every interaction type to the right place:
 *   - chat input    -> slash runner
 *   - autocomplete  -> slash runner
 *   - buttons/selects/modals -> component router
 *
 * Centralising this means error handling is identical for all of them.
 */

const logger = require('../lib/logger');
const embeds = require('../lib/embeds');
const slash = require('../core/slash');

const log = logger.child('interaction');

module.exports = {
  name: 'interactionCreate',
  async execute(client, interaction) {
    const registry = client.registry;
    if (!registry) {
      log.error('registry missing on client - cannot route interaction');
      return;
    }

    try {
      if (interaction.isChatInputCommand()) {
        await slash.handleChatInput(interaction, registry);
        return;
      }

      if (interaction.isAutocomplete()) {
        await slash.handleAutocomplete(interaction, registry);
        return;
      }

      // Buttons, string/role/channel/user selects and modal submits all go
      // through the component router.
      if (
        interaction.isButton()
        || interaction.isAnySelectMenu()
        || interaction.isModalSubmit()
        || interaction.isContextMenuCommand()
      ) {
        await registry.router.handle(interaction);
        return;
      }

      log.debug(`unhandled interaction type: ${interaction.type}`);
    } catch (error) {
      log.error(`interaction handling failed (${interaction.type}):`, error);

      // Last-ditch acknowledgement. If the interaction was never answered the
      // user sees "The application did not respond", which looks like the bot
      // is broken.
      if (typeof interaction.isRepliable === 'function' && interaction.isRepliable()
        && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          embeds: [
            embeds.error(
              'Interaction failed',
              'That action could not be completed. The error has been logged.',
            ),
          ],
          ephemeral: true,
        }).catch(() => {});
      }
    }
  },
};
