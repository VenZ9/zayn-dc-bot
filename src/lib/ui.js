'use strict';

/**
 * UI primitives shared by every module.
 *
 * Includes the confirmation prompt, buttons, select menus, pagination and the
 * modal helper. Keeping them here means destructive actions look and behave
 * identically wherever they appear.
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  UserSelectMenuBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const { LIMITS, COLORS } = require('./constants');
const embeds = require('./embeds');

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

/**
 * Build a single button.
 * @param {{ id?: string, label: string, style?: ButtonStyle, emoji?: string, disabled?: boolean, url?: string }} options
 */
function button(options) {
  const {
    id, label, style = ButtonStyle.Secondary, emoji, disabled = false, url,
  } = options;

  const built = new ButtonBuilder().setLabel(label);
  if (url) built.setURL(url);
  else if (id) built.setCustomId(id);
  if (style !== undefined) built.setStyle(style);
  if (emoji) built.setEmoji(emoji);
  if (disabled) built.setDisabled(true);
  return built;
}

/** Convenience: a green confirm button. */
const confirmButton = (id, label = 'Confirm') => button({ id, label, style: ButtonStyle.Success });
/** Convenience: a red cancel button. */
const cancelButton = (id, label = 'Cancel') => button({ id, label, style: ButtonStyle.Danger });

/** Wrap buttons into an action row (max 5 per row). */
function row(...components) {
  return new ActionRowBuilder().addComponents(...components.flat().slice(0, LIMITS.buttonsPerRow));
}

/** Split many buttons into as many rows as needed (max 5 rows). */
function buttonRows(buttons) {
  const rows = [];
  for (let i = 0; i < buttons.length && rows.length < LIMITS.actionRows; i += LIMITS.buttonsPerRow) {
    rows.push(row(buttons.slice(i, i + LIMITS.buttonsPerRow)));
  }
  return rows;
}

/** A disabled button that just shows the outcome, e.g. "✅ Confirmed". */
const statusButton = (label, style = ButtonStyle.Secondary, emoji) =>
  button({ label, style, emoji, disabled: true, id: 'status' });

// ---------------------------------------------------------------------------
// Confirmation prompt
// ---------------------------------------------------------------------------

/**
 * Ask for confirmation of a destructive action.
 *
 * Resolves `true` when the user presses Confirm, `false` on Cancel, and
 * `false` on timeout. Only the invoking user may press the buttons, and only
 * in the channel where the prompt was sent.
 *
 * @param {import('../core/context')} ctx
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.body
 * @param {string} [options.confirmLabel]
 * @param {string} [options.cancelLabel]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.color]
 * @returns {Promise<boolean>}
 */
async function confirm(ctx, options) {
  const {
    title = 'Are you sure?',
    body = 'This action cannot be undone.',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    timeoutMs = 30_000,
    color = COLORS.warning,
  } = options;

  const confirmId = `confirm:yes:${ctx.user.id}:${Date.now()}`;
  const cancelId = `confirm:no:${ctx.user.id}:${Date.now()}`;

  const prompt = embeds.embed({ color, title, description: body });
  const components = [
    row(
      button({ id: confirmId, label: confirmLabel, style: ButtonStyle.Danger }),
      button({ id: cancelId, label: cancelLabel, style: ButtonStyle.Secondary }),
    ),
  ];

  const message = await ctx.reply({ embeds: [prompt], components, ephemeral: false });

  try {
    const interaction = await message.awaitMessageComponent({
      time: timeoutMs,
      filter: (candidate) => {
        if (candidate.user.id !== ctx.user.id) {
          candidate.reply({ content: 'Only the person who ran the command can answer this.', ephemeral: true }).catch(() => {});
          return false;
        }
        return candidate.customId === confirmId || candidate.customId === cancelId;
      },
    });

    const accepted = interaction.customId === confirmId;

    // Replace the prompt with the outcome so the buttons cannot be pressed
    // again - this is what prevents a double-confirm on a destructive action.
    await interaction.update({
      embeds: [
        embeds.embed({
          color: accepted ? COLORS.success : COLORS.neutral,
          title: accepted ? `${title} - confirmed` : `${title} - cancelled`,
          description: accepted ? body : 'No changes were made.',
        }),
      ],
      components: [],
    }).catch(() => {});

    return accepted;
  } catch {
    // Timed out - strip the buttons so it cannot be used later.
    await message.edit({ components: [] }).catch(() => {});
    return false;
  }
}

// ---------------------------------------------------------------------------
// Select menus
// ---------------------------------------------------------------------------

/**
 * String select menu.
 * @param {string} customId
 * @param {Array<{ label: string, value: string, description?: string, emoji?: string, default?: boolean }>} options
 * @param {{ placeholder?: string, max?: number, min?: number }} [config]
 */
function selectMenu(customId, options, config = {}) {
  const { placeholder = 'Choose an option', max = 1, min = 1 } = config;

  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder.slice(0, 150))
    .setMinValues(Math.max(0, min))
    .setMaxValues(Math.min(max, LIMITS.selectOptions, options.length || 1));

  for (const option of options.slice(0, LIMITS.selectOptions)) {
    const builder = new StringSelectMenuOptionBuilder()
      .setLabel(String(option.label).slice(0, 100))
      .setValue(String(option.value));
    if (option.description) builder.setDescription(String(option.description).slice(0, 100));
    if (option.emoji) builder.setEmoji(option.emoji);
    if (option.default) builder.setDefault(true);
    menu.addOptions(builder);
  }

  return new ActionRowBuilder().addComponents(menu);
}

/** Channel picker row. */
function channelSelect(customId, { placeholder = 'Choose a channel', types } = {}) {
  const menu = new ChannelSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder);
  if (types) menu.setChannelTypes(types);
  return new ActionRowBuilder().addComponents(menu);
}

/** Role picker row. */
function roleSelect(customId, { placeholder = 'Choose a role' } = {}) {
  const menu = new RoleSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder);
  return new ActionRowBuilder().addComponents(menu);
}

/** User picker row. */
function userSelect(customId, { placeholder = 'Choose a member' } = {}) {
  const menu = new UserSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder);
  return new ActionRowBuilder().addComponents(menu);
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

/**
 * Build a modal.
 * @param {string} customId
 * @param {string} title
 * @param {Array<{ id: string, label: string, style?: TextInputStyle, required?: boolean, value?: string, placeholder?: string, maxLength?: number, minLength?: number, paragraph?: boolean }>} inputs
 */
function modal(customId, title, inputs = []) {
  const built = new ModalBuilder().setCustomId(customId).setTitle(String(title).slice(0, LIMITS.modalLabel));

  for (const input of inputs.slice(0, 5)) {
    const field = new TextInputBuilder()
      .setCustomId(input.id)
      .setLabel(String(input.label).slice(0, LIMITS.modalLabel))
      .setStyle(input.style ?? (input.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short))
      .setRequired(input.required !== false);

    if (input.value !== undefined && input.value !== null) field.setValue(String(input.value).slice(0, LIMITS.modalInput));
    if (input.placeholder) field.setPlaceholder(String(input.placeholder).slice(0, 100));
    if (input.maxLength) field.setMaxLength(Math.min(input.maxLength, LIMITS.modalInput));
    if (input.minLength) field.setMinLength(Math.min(input.minLength, LIMITS.modalInput));

    built.addComponents(new ActionRowBuilder().addComponents(field));
  }

  return built;
}

/** Shortcut for a single paragraph input modal (used by /reason, /bio, etc.) */
function textModal(customId, title, { id = 'value', label, value, placeholder, required = true, maxLength = 1000 } = {}) {
  return modal(customId, title, [{ id, label, value, placeholder, required, maxLength, paragraph: true }]);
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * Paginate a list of embeds.
 *
 * Sends a multi-embed message when the pages fit in one message (Discord allows
 * 10 embeds per message), otherwise falls back to button navigation.
 *
 * @param {import('../core/context')} ctx
 * @param {import('discord.js').EmbedBuilder[]} pages
 * @param {{ timeoutMs?: number, title?: string }} [options]
 */
async function paginate(ctx, pages, options = {}) {
  const { timeoutMs = 120_000 } = options;

  if (!pages || pages.length === 0) {
    return ctx.reply({ embeds: [embeds.neutral('Nothing to show', 'There is no data to display.')] });
  }

  if (pages.length === 1) {
    return ctx.reply({ embeds: [pages[0]] });
  }

  // Small enough to send at once - no controls needed.
  if (pages.length <= 10) {
    return ctx.reply({ embeds: pages.slice(0, 10) });
  }

  // Otherwise paginate one embed at a time with Previous / Next.
  let index = 0;
  const ownerId = ctx.user.id;

  const buildComponents = (disabled = false) => [
    row(
      button({ id: `page:first:${ownerId}`, label: '⏮', style: ButtonStyle.Secondary, disabled: disabled || index === 0 }),
      button({ id: `page:prev:${ownerId}`, label: '◀', style: ButtonStyle.Secondary, disabled: disabled || index === 0 }),
      button({ id: `page:indicator:${ownerId}`, label: `${index + 1}/${pages.length}`, style: ButtonStyle.Secondary, disabled: true }),
      button({ id: `page:next:${ownerId}`, label: '▶', style: ButtonStyle.Secondary, disabled: disabled || index === pages.length - 1 }),
      button({ id: `page:last:${ownerId}`, label: '⏭', style: ButtonStyle.Secondary, disabled: disabled || index === pages.length - 1 }),
    ),
  ];

  const message = await ctx.reply({ embeds: [pages[index]], components: buildComponents() });

  const collector = message.createMessageComponentCollector({ time: timeoutMs });

  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: 'Only the person who ran the command can page through this.', ephemeral: true }).catch(() => {});
      return;
    }

    const [, direction] = interaction.customId.split(':');
    if (direction === 'first') index = 0;
    else if (direction === 'prev') index = Math.max(0, index - 1);
    else if (direction === 'next') index = Math.min(pages.length - 1, index + 1);
    else if (direction === 'last') index = pages.length - 1;

    await interaction.update({ embeds: [pages[index]], components: buildComponents() }).catch(() => {});
  });

  collector.on('end', () => {
    message.edit({ components: [] }).catch(() => {});
  });

  return message;
}

/**
 * Render a numbered list into a single embed description.
 * @param {Array<{ name: string, value?: string }>} items
 */
function listEmbed(title, items, { color = COLORS.brand, empty = 'Nothing here yet.' } = {}) {
  if (!items || items.length === 0) {
    return embeds.embed({ color, title, description: empty });
  }

  const lines = items.map((item, position) => {
    const prefix = `**${position + 1}.**`;
    return item.value ? `${prefix} ${item.name}\n> ${item.value}` : `${prefix} ${item.name}`;
  });

  return embeds.embed({ color, title, description: lines.join('\n') });
}

// ---------------------------------------------------------------------------
// Feedback helpers
// ---------------------------------------------------------------------------

/** Collect 1-5 string inputs from a modal, returning null when cancelled. */
async function promptValues(ctx, customId, title, inputs, { timeoutMs = 120_000 } = {}) {
  const interaction = await ctx.showModal(modal(customId, title, inputs));
  if (!interaction) return null;

  try {
    const submitted = await interaction.awaitModalSubmit({ time: timeoutMs });
    return Object.fromEntries(
      inputs.map((input) => [input.id, submitted.fields.getTextInputValue(input.id)?.trim() ?? '']),
    );
  } catch {
    return null;
  }
}

/** Build a "no results" embed consistently. */
const nothingFound = (what = 'results') =>
  embeds.neutral('No results', `No ${what} matched your query.`);

module.exports = {
  // buttons
  button,
  confirmButton,
  cancelButton,
  row,
  buttonRows,
  statusButton,
  ButtonStyle,
  PermissionFlagsBits,

  // prompts
  confirm,
  modal,
  textModal,
  promptValues,

  // menus
  selectMenu,
  channelSelect,
  roleSelect,
  userSelect,

  // lists
  paginate,
  listEmbed,
  nothingFound,

  // re-export for convenience
  embeds,
};
