'use strict';

/**
 * Embed builders.
 *
 * Every embed the bot sends goes through this file, which is what makes the
 * branding consistent: the footer is applied in one place, so callers cannot
 * forget it. `applyBranding` is exported too, so hand-built embeds can opt in.
 */

const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const { COLORS, LIMITS } = require('./constants');

// ---------------------------------------------------------------------------
// Branding
// ---------------------------------------------------------------------------

/**
 * Apply the configured branding to an embed.
 *
 * Footer text defaults to "Built by ZAYN | ZAYN'S DC - whos.zayn_".
 * An explicit footer is preserved unless `keepFooter` is false.
 *
 * @param {EmbedBuilder} embed
 * @param {{ keepFooter?: boolean }} [options]
 */
function applyBranding(embed, options = {}) {
  const { keepFooter = false } = options;

  if (!keepFooter || !embed.data.footer?.text) {
    embed.setFooter({ text: config.brandFooterText });
  }

  return embed;
}

/** Trim a string to a Discord limit, adding an ellipsis when cut. */
function clip(text, max) {
  if (typeof text !== 'string') return text;
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

// ---------------------------------------------------------------------------
// Base builders
// ---------------------------------------------------------------------------

/**
 * Create a branded embed.
 * @param {{ color?: number, title?: string, description?: string, keepFooter?: boolean }} [options]
 */
function embed(options = {}) {
  const { color = COLORS.brand, title, description, keepFooter = false } = options;
  const built = new EmbedBuilder().setColor(color);
  if (title) built.setTitle(clip(title, LIMITS.embedTitle));
  if (description) built.setDescription(clip(description, LIMITS.embedDescription));
  return applyBranding(built, { keepFooter });
}

/** Green embed for a successful action. */
function success(title, description) {
  return embed({ color: COLORS.success, title, description });
}

/** Red embed for a failure or blocked action. */
function error(title, description) {
  return embed({ color: COLORS.danger, title, description });
}

/** Yellow embed for something that needs attention. */
function warning(title, description) {
  return embed({ color: COLORS.warning, title, description });
}

/** Blurple informational embed. */
function info(title, description) {
  return embed({ color: COLORS.info, title, description });
}

/** Quiet grey embed for neutral details. */
function neutral(title, description) {
  return embed({ color: COLORS.neutral, title, description });
}

// ---------------------------------------------------------------------------
// Higher level helpers
// ---------------------------------------------------------------------------

/**
 * A key/value detail embed - the shape used by /userinfo, /serverinfo, etc.
 *
 * @param {string} title
 * @param {Array<[string, string|number|null|undefined]>} fields
 * @param {{ color?: number, thumbnail?: string, description?: string }} [options]
 */
function details(title, fields, options = {}) {
  const { color = COLORS.brand, thumbnail, description } = options;
  const built = embed({ color, title, description });

  for (const [name, value] of fields) {
    if (value === null || value === undefined || value === '') continue;
    built.addFields({
      name: clip(String(name), LIMITS.embedFieldName),
      value: clip(String(value), LIMITS.embedFieldValue),
      inline: true,
    });
  }

  if (thumbnail) built.setThumbnail(thumbnail);
  return built;
}

/**
 * Standard "here is what went wrong" embed.
 * @param {string} message
 * @param {{ title?: string, hint?: string }} [options]
 */
function failure(message, options = {}) {
  const { title = 'Something went wrong', hint } = options;
  const lines = [message];
  if (hint) lines.push('', `> ${hint}`);
  return error(title, lines.join('\n'));
}

/** Description-only embed, used by paginated lists. */
function page(title, description, { color = COLORS.brand } = {}) {
  return embed({ color, title, description });
}

/** Divider used inside embed descriptions to separate sections. */
const DIVIDER = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

module.exports = {
  embed,
  success,
  error,
  warning,
  info,
  neutral,
  details,
  failure,
  page,
  applyBranding,
  clip,
  DIVIDER,
};
