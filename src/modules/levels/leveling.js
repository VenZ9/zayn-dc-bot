'use strict';

/**
 * Leveling glue.
 *
 * Wires the message, voice and member events to the leveling service: awards
 * XP on a cooldown, applies reward roles on a level-up, and reconciles rewards
 * when a member changes roles.
 */

const logger = require('../../lib/logger');
const xp = require('../../lib/xp');
const { levelFromXp } = require('../../lib/constants');
const service = require('./leveling-service');

const log = logger.child('leveling');

/** The guild's levelling configuration, or null when unavailable. */
async function configFor(guildId) {
  const db = require('../../db');
  return db.getGuildConfig(guildId).catch(() => null);
}

/** Announce a level-up, if a channel is configured and I can post there. */
async function announce(member, level, settings) {
  if (!settings.announceChannel) return;

  const channel = member.guild.channels.cache.get(settings.announceChannel)
    ?? await member.guild.channels.fetch(settings.announceChannel).catch(() => null);

  if (!channel || !channel.isTextBased()) return;

  const embeds = require('../../lib/embeds');
  const { COLORS } = require('../../lib/constants');

  await channel.send({
    content: `<@${member.id}>`,
    embeds: [
      embeds.embed({
        color: COLORS.success,
        description: `🎉 ${member} reached **level ${level}** — *${xp.rankTitle(level)}*!`,
      }),
    ],
    allowedMentions: { users: [member.id] },
  }).catch((error) => log.debug('level-up announce failed:', error.message));
}

/**
 * Award XP for a message, honouring the per-guild cooldown.
 * Called by the messageCreate event.
 *
 * @param {import('discord.js').Message} message
 */
async function awardMessageXp(message) {
  const db = require('../../db');
  if (typeof db.isEnabled === 'function' && !db.isEnabled()) return null;
  if (message.author?.bot) return null;

  const cfg = await configFor(message.guild.id);
  if (!cfg) return null;

  const settings = service.settings(cfg);
  if (!settings.enabled) return null;

  const existing = await service.getUser(message.guild.id, message.author.id);

  // Cooldown: a member earns XP at most once per configured interval.
  if (!xp.isXpEligible(existing?.last_xp_at, settings.cooldown)) return null;

  const amount = service.rollXp(settings);
  const result = await service.addXp(message.guild.id, message.author.id, amount);
  if (!result) return null;

  if (result.levelUp) {
    const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
    if (member) {
      const granted = await service.applyRewards(member, result.level, result.previousLevel, settings)
        .catch(() => []);
      await announce(member, result.level, settings);
      log.debug(`level up ${member.id} -> ${result.level} (+${granted.length} role(s))`);
    }
  }

  return result;
}

/**
 * Award XP earned through voice activity.
 * Called by the voice tracker.
 */
async function awardVoiceXp(guildId, userId, amount) {
  const db = require('../../db');
  if (typeof db.isEnabled === 'function' && !db.isEnabled()) return null;
  if (!amount || amount <= 0) return null;

  const cfg = await configFor(guildId);
  if (!cfg) return null;

  const settings = service.settings(cfg);
  if (!settings.enabled) return null;

  const result = await service.addXp(guildId, userId, amount);
  if (!result || !result.levelUp) return result;

  const guild = await db.selectOne('guild_config', { where: { guild_id: guildId }, optional: true }) && null;
  void guild;

  return result;
}

/**
 * Grant every reward role the member is currently entitled to.
 * Safe to call repeatedly; used after a role change and by the reconciler.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {{ silent?: boolean }} [options]
 */
async function applyRewards(member, options = {}) {
  if (!member?.guild) return [];

  const cfg = await configFor(member.guild.id);
  if (!cfg) return [];

  const settings = service.settings(cfg);
  const row = await service.getUser(member.guild.id, member.id);
  const level = Number(row?.level ?? levelFromXp(Number(row?.total_xp ?? 0)));

  if (level <= 0) return [];

  // previousLevel -1 means "consider every reward up to the current level".
  const granted = await service.applyRewards(member, level, -1, settings).catch(() => []);
  if (!options.silent && granted.length > 0) {
    log.debug(`reconciled ${granted.length} reward(s) for ${member.id}`);
  }
  return granted;
}

/** Alias used by the member-update event. */
async function syncRewards(member) {
  return applyRewards(member, { silent: true });
}

module.exports = {
  awardMessageXp,
  awardVoiceXp,
  applyRewards,
  syncRewards,
  configFor,
};
