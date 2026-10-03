'use strict';

/**
 * Shared constants.
 *
 * Keeping colours, rarity tiers and the module list in one file means the
 * branding stays consistent everywhere and `/help` cannot drift out of sync
 * with the modules that actually exist.
 */

const config = require('../config');

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/** Palette used across every embed. Deliberately small and consistent. */
const COLORS = Object.freeze({
  brand: 0x5865f2,     // blurple - default accent
  success: 0x57f287,   // green  - successful action
  warning: 0xfee75c,   // yellow - needs attention
  danger: 0xed4245,    // red    - destructive / error
  info: 0x5865f2,      // same as brand
  neutral: 0x2b2d31,   // grey   - quiet informational
  muted: 0x99aab5,     // light grey
  purple: 0x9b59b6,
  gold: 0xf1c40f,
  pink: 0xeb459e,
});

// ---------------------------------------------------------------------------
// Rarity (used by badges and collectibles)
// ---------------------------------------------------------------------------

const RARITIES = Object.freeze({
  common: { id: 'common', label: 'Common', color: 0x99aab5, weight: 60 },
  uncommon: { id: 'uncommon', label: 'Uncommon', color: 0x57f287, weight: 24 },
  rare: { id: 'rare', label: 'Rare', color: 0x3498db, weight: 10 },
  epic: { id: 'epic', label: 'Epic', color: 0x9b59b6, weight: 4 },
  legendary: { id: 'legendary', label: 'Legendary', color: 0xf1c40f, weight: 1.5 },
  mythic: { id: 'mythic', label: 'Mythic', color: 0xeb459e, weight: 0.5 },
});

/** Rarity ids in ascending order of prestige. */
const RARITY_ORDER = Object.freeze(['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic']);

/** Build the badge catalogue from the rarity table, so they cannot diverge. */
const BADGES = Object.freeze({
  developer: { id: 'developer', label: 'Developer', emoji: '🛠️', description: 'Helped build the bot.' },
  staff: { id: 'staff', label: 'Staff', emoji: '🛡️', description: 'Part of the server staff.' },
  booster: { id: 'booster', label: 'Booster', emoji: '🚀', description: 'Currently boosting the server.' },
  early: { id: 'early', label: 'Early Supporter', emoji: '🌱', description: 'Was here from the start.' },
  verified: { id: 'verified', label: 'Verified', emoji: '✅', description: 'Verified member.' },
  active: { id: 'active', label: 'Active', emoji: '🔥', description: 'Very active in the server.' },
  helper: { id: 'helper', label: 'Helper', emoji: '🤝', description: 'Frequently helps others.' },
  veteran: { id: 'veteran', label: 'Veteran', emoji: '🎖️', description: 'A long-standing member.' },
  birthday: { id: 'birthday', label: 'Birthday', emoji: '🎂', description: 'Has set a birthday.' },
  premium: { id: 'premium', label: 'Premium', emoji: '💎', description: 'Premium supporter.' },
  partner: { id: 'partner', label: 'Partner', emoji: '🌟', description: 'Server partner.' },
  event_winner: { id: 'event_winner', label: 'Event Winner', emoji: '🏆', description: 'Won a server event.' },
});

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

/**
 * The 13 feature modules, in the order they appear in /help.
 * `id` is used for permission namespaces (`moderation.ban`) and for grouping.
 */
const MODULES = Object.freeze([
  { id: 'moderation', name: 'Moderation', emoji: '🛡️', description: 'Bans, kicks, mutes, warnings and channel control.' },
  { id: 'server', name: 'Server Management', emoji: '⚙️', description: 'Server, user, role and channel information.' },
  { id: 'tickets', name: 'Ticket System', emoji: '🎫', description: 'Support tickets with panels, claiming and transcripts.' },
  { id: 'analytics', name: 'Server Analytics', emoji: '📊', description: 'Message, member and channel statistics.' },
  { id: 'welcome', name: 'Welcome & Goodbye', emoji: '👋', description: 'Greeting messages, autorole and DM welcomes.' },
  { id: 'roles', name: 'Roles & Permissions', emoji: '🎭', description: 'Role management, reaction roles and role menus.' },
  { id: 'giveaways', name: 'Giveaways', emoji: '🎁', description: 'Giveaway hosting with requirements and rerolls.' },
  { id: 'levels', name: 'Leveling & XP', emoji: '📈', description: 'XP, ranks, leaderboards and level rewards.' },
  { id: 'events', name: 'Events & Scheduling', emoji: '📅', description: 'Events, scheduled messages, reminders and polls.' },
  { id: 'custom', name: 'Custom Commands', emoji: '📝', description: 'Your own commands and autoresponders.' },
  { id: 'logs', name: 'Logging & Audit', emoji: '🧾', description: 'Event logging and staff audit trail.' },
  { id: 'config', name: 'Bot Configuration', emoji: '🔧', description: 'Prefix, language, timezone and backups.' },
  { id: 'profile', name: 'User Profiles', emoji: '👤', description: 'Bios, badges, birthdays and reputation.' },
]);

/** Fast lookup by module id. */
const MODULE_MAP = Object.freeze(
  Object.fromEntries(MODULES.map((module) => [module.id, module])),
);

// ---------------------------------------------------------------------------
// XP / levelling
// ---------------------------------------------------------------------------

/**
 * Total XP needed to reach a level. Quadratic so early levels are quick and
 * later ones take real effort. Matches the formula used in leveling.js.
 */
function xpForLevel(level) {
  if (level <= 0) return 0;
  return 5 * level * level + 50 * level + 100;
}

/** XP needed to go from `level` to `level + 1`. */
function xpForNextLevel(level) {
  return xpForLevel(level + 1) - xpForLevel(level);
}

/** Highest level whose requirement is met by `totalXp`. */
function levelFromXp(totalXp) {
  let level = 0;
  while (level < 1000 && xpForLevel(level + 1) <= totalXp) level += 1;
  return level;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Discord limits we hit regularly. */
const LIMITS = Object.freeze({
  embedTitle: 256,
  embedDescription: 4096,
  embedFieldName: 256,
  embedFieldValue: 1024,
  embedFields: 25,
  embedFooter: 2048,
  embedAuthor: 256,
  messageContent: 2000,
  selectOptions: 25,
  buttonsPerRow: 5,
  actionRows: 5,
  modalInput: 4000,
  modalLabel: 45,
  nickname: 32,
  topic: 1024,
  reason: 512,
  auditReason: 512,
});

/** Default embed accent. */
const DEFAULT_COLOR = COLORS.brand;

module.exports = {
  COLORS,
  RARITIES,
  RARITY_ORDER,
  BADGES,
  MODULES,
  MODULE_MAP,
  LIMITS,
  DEFAULT_COLOR,
  xpForLevel,
  xpForNextLevel,
  levelFromXp,
  brand: config.brand,
};
