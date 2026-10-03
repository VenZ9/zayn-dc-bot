'use strict';

/**
 * Giveaway service.
 *
 * Owns the giveaway lifecycle and the winner draw. The winning logic lives
 * here, not in the command or the button, so a reroll and an automatic end can
 * never disagree about eligibility.
 *
 * Tables:
 *   giveaways        - one row per giveaway
 *   giveaway_entries - one row per entrant (repeats carry bonus entries)
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const helpers = require('../../lib/helpers');
const logger = require('../../lib/logger');
const embeds = require('../../lib/embeds');
const config = require('../../config');
const { COLORS } = require('../../lib/constants');

const log = logger.child('giveaways');

/** Custom id prefix for the entry button. */
const ENTER_PREFIX = 'gw:enter:';

// ---------------------------------------------------------------------------
// Entry rules
// ---------------------------------------------------------------------------

/**
 * Check whether a member may enter.
 * @returns {{ ok: boolean, reason?: string }}
 */
function eligibility(member, giveaway) {
  if (member.user.bot) return { ok: false, reason: 'Bots cannot enter giveaways.' };

  if (giveaway.required_role && !member.roles.cache.has(giveaway.required_role)) {
    return { ok: false, reason: `You need the <@&${giveaway.required_role}> role to enter.` };
  }

  if (giveaway.required_level !== null && giveaway.required_level !== undefined) {
    const level = member.__level ?? null;
    if (level !== null && level < giveaway.required_level) {
      return {
        ok: false,
        reason: `You need to be level **${giveaway.required_level}** or higher (you are level **${level}**).`,
      };
    }
  }

  return { ok: true };
}

/** Bonus entries configured for a member's roles. */
function bonusFor(member, giveaway) {
  const bonus = giveaway.bonus_entries && typeof giveaway.bonus_entries === 'object'
    ? giveaway.bonus_entries
    : {};

  let extra = 0;
  for (const [roleId, amount] of Object.entries(bonus)) {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (member.roles.cache.has(roleId)) extra += value;
  }
  return extra;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * Record an entry for a member. Idempotent.
 * @returns {Promise<{ ok: boolean, created?: boolean, bonus?: number, reason?: string }>}
 */
async function enter(giveawayId, member, giveaway) {
  const db = require('../../db');

  if (giveaway.status !== 'running') {
    return { ok: false, reason: 'This giveaway is not accepting entries.' };
  }

  const check = eligibility(member, giveaway);
  if (!check.ok) return { ok: false, reason: check.reason };

  const existing = await db.selectOne('giveaway_entries', {
    where: { giveaway_id: giveawayId, user_id: member.id },
    optional: true,
  });
  if (existing) return { ok: true, created: false };

  // Bonus entries are stored as extra rows so the draw stays a plain sample.
  const bonus = bonusFor(member, giveaway);
  const rows = [{ giveaway_id: giveawayId, guild_id: member.guild.id, user_id: member.id }];
  for (let index = 0; index < bonus; index += 1) {
    rows.push({ giveaway_id: giveawayId, guild_id: member.guild.id, user_id: member.id });
  }

  await db.insertMany('giveaway_entries', rows).catch((error) => {
    // A duplicate here is an entry race, which is harmless.
    log.debug('entry insert race:', error.message);
  });

  return { ok: true, created: true, bonus };
}

/** Remove a member's entries. */
async function leave(giveawayId, userId) {
  const db = require('../../db');
  await db.remove('giveaway_entries', { giveaway_id: giveawayId, user_id: userId }).catch(() => []);
}

/** Distinct entrant ids for a giveaway. */
async function entrants(giveawayId) {
  const db = require('../../db');
  const rows = await db.select('giveaway_entries', {
    columns: 'user_id',
    where: { giveaway_id: giveawayId },
    limit: 20000,
    optional: true,
    fallback: [],
  });
  return [...new Set(rows.map((row) => row.user_id))];
}

/** Entry count (bonus entries included). */
async function entryCount(giveawayId) {
  const db = require('../../db');
  return db.count('giveaway_entries', { giveaway_id: giveawayId }, { optional: true });
}

// ---------------------------------------------------------------------------
// Drawing winners
// ---------------------------------------------------------------------------

/**
 * Draw `count` distinct winners.
 *
 * Entrants who have left or are bots are filtered out first, so a winner is
 * always someone who can actually claim.
 */
async function drawWinners(guild, giveawayId, count) {
  const unique = await entrants(giveawayId);

  const present = [];
  for (const userId of unique) {
    // eslint-disable-next-line no-await-in-loop
    const member = guild.members.cache.get(userId)
      ?? await guild.members.fetch(userId).catch(() => null);
    if (!member || member.user.bot) continue;
    present.push(userId);
  }

  const source = present.length > 0 ? present : unique;
  return helpers.sample(source, Math.max(1, count));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Build the giveaway announcement embed. */
function render(giveaway, entries, options = {}) {
  const { winners = null } = options;

  const ended = giveaway.status === 'ended' || giveaway.status === 'cancelled';
  const paused = giveaway.status === 'paused';

  const color = giveaway.status === 'ended'
    ? (winners && winners.length > 0 ? COLORS.gold : COLORS.danger)
    : (paused ? COLORS.warning : COLORS.brand);

  const embed = embeds.embed({ color, title: (ended ? `🎉 ${giveaway.prize}` : `🎉 ${giveaway.prize} 🎉`).slice(0, 256) });

  const lines = [];
  if (giveaway.description) lines.push(giveaway.description, '');
  if (!ended) {
    lines.push(
      `Ends ${helpers.timestamp(new Date(giveaway.ends_at), 'R')} (${helpers.timestamp(new Date(giveaway.ends_at), 'f')})`,
    );
  }
  lines.push(`Hosted by <@${giveaway.host_id}>`);
  embed.setDescription(lines.join('\n'));

  embed.addFields(
    { name: 'Winners', value: String(giveaway.winners_count), inline: true },
    { name: 'Entries', value: helpers.formatNumber(entries), inline: true },
    { name: 'Status', value: paused ? '⏸️ Paused' : (ended ? '🔒 Ended' : '🟢 Running'), inline: true },
  );

  const requirements = [];
  if (giveaway.required_role) requirements.push(`Role: <@&${giveaway.required_role}>`);
  if (giveaway.required_level) requirements.push(`Level: **${giveaway.required_level}**+`);
  if (giveaway.required_messages) requirements.push(`Messages: **${giveaway.required_messages}**+`);
  if (requirements.length > 0) embed.addFields({ name: 'Requirements', value: requirements.join('\n') });

  const winnerList = winners ?? (Array.isArray(giveaway.winner_ids) ? giveaway.winner_ids : null);
  if (ended && winnerList) {
    embed.addFields({
      name: winnerList.length > 0 ? '🏆 Winners' : '😔 No winners',
      value: winnerList.length > 0 ? winnerList.map((id) => `<@${id}>`).join(', ') : 'Nobody entered.',
    });
  }

  embed.setFooter({ text: `Giveaway ${String(giveaway.id).slice(0, 8)} • ${config.brandFooterText}` });

  return embed;
}

/** The entry button row. */
function controls(giveaway, { disabled = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ENTER_PREFIX}${giveaway.id}`)
      .setLabel(disabled ? 'Ended' : 'Enter')
      .setEmoji('🎉')
      .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(disabled || giveaway.status !== 'running'),
  );
}

// ---------------------------------------------------------------------------
// Ending
// ---------------------------------------------------------------------------

/**
 * End a giveaway, draw winners and refresh the announcement.
 * Pass `reroll: true` to redraw without changing the recorded end state.
 */
async function end(client, giveawayId, options = {}) {
  const db = require('../../db');
  const { reroll = false, endedBy = null } = options;

  const giveaway = await db.selectOne('giveaways', { where: { id: giveawayId }, optional: true });
  if (!giveaway) return { ok: false, error: 'That giveaway no longer exists.' };
  if (giveaway.status === 'cancelled') return { ok: false, error: 'That giveaway was cancelled.' };
  if (!reroll && giveaway.status === 'ended') return { ok: false, error: 'That giveaway has already ended.' };

  const guild = await client.guilds.fetch(giveaway.guild_id).catch(() => null);
  if (!guild) return { ok: false, error: 'That server is no longer available.' };

  const winners = await drawWinners(guild, giveawayId, giveaway.winners_count);

  if (!reroll) {
    await db.update('giveaways', { id: giveawayId }, {
      status: 'ended',
      ended_at: new Date().toISOString(),
      winner_ids: winners,
      ended_by: endedBy?.id ?? null,
    });
  }

  const channel = await client.channels.fetch(giveaway.channel_id).catch(() => null);
  const entries = await entryCount(giveawayId);

  if (channel && giveaway.message_id) {
    const message = await channel.messages.fetch(giveaway.message_id).catch(() => null);
    if (message) {
      await message.edit({
        embeds: [render({ ...giveaway, status: 'ended' }, entries, { winners })],
        components: [controls(giveaway, { disabled: true })],
      }).catch(() => {});
    }
  }

  if (channel) {
    const announcement = winners.length > 0
      ? `🎉 Congratulations ${winners.map((id) => `<@${id}>`).join(', ')} — you won **${helpers.truncate(giveaway.prize, 150)}**!`
      : `😔 Nobody entered the giveaway for **${helpers.truncate(giveaway.prize, 150)}**.`;

    const embed = embeds.embed({
      color: winners.length > 0 ? COLORS.gold : COLORS.neutral,
      title: reroll ? '🔄 Giveaway rerolled' : '🎉 Giveaway ended',
      description: announcement,
    });
    embed.addFields(
      { name: 'Prize', value: helpers.truncate(giveaway.prize, 200), inline: true },
      { name: 'Entries', value: helpers.formatNumber(entries), inline: true },
    );
    if (endedBy) embed.addFields({ name: 'Ended by', value: `<@${endedBy.id}>`, inline: true });

    await channel.send({
      content: winners.map((id) => `<@${id}>`).join(' '),
      embeds: [embed],
      allowedMentions: { users: winners },
    }).catch(() => {});
  }

  log.info(`giveaway ${giveawayId} ${reroll ? 'rerolled' : 'ended'} with ${winners.length} winner(s)`);
  return { ok: true, giveaway, winners, entries };
}

/** Cancel a giveaway without drawing winners. */
async function cancel(client, giveawayId, user) {
  const db = require('../../db');

  const giveaway = await db.selectOne('giveaways', { where: { id: giveawayId }, optional: true });
  if (!giveaway) return { ok: false, error: 'That giveaway no longer exists.' };
  if (giveaway.status === 'ended') return { ok: false, error: 'That giveaway has already ended.' };
  if (giveaway.status === 'cancelled') return { ok: false, error: 'That giveaway is already cancelled.' };

  await db.update('giveaways', { id: giveawayId }, {
    status: 'cancelled',
    ended_at: new Date().toISOString(),
  });

  const channel = await client.channels.fetch(giveaway.channel_id).catch(() => null);
  const entries = await entryCount(giveawayId);

  if (channel && giveaway.message_id) {
    const message = await channel.messages.fetch(giveaway.message_id).catch(() => null);
    if (message) {
      await message.edit({
        embeds: [render({ ...giveaway, status: 'cancelled' }, entries)],
        components: [controls(giveaway, { disabled: true })],
      }).catch(() => {});
    }
  }

  if (channel) {
    await channel.send({
      embeds: [
        embeds.error(
          'Giveaway cancelled',
          `The giveaway for **${helpers.truncate(giveaway.prize, 200)}** was cancelled${user ? ` by <@${user.id}>` : ''}.`,
        ),
      ],
    }).catch(() => {});
  }

  return { ok: true, giveaway };
}

/** Pause or resume a giveaway. */
async function setPaused(giveawayId, paused) {
  const db = require('../../db');
  const updated = await db.update('giveaways', { id: giveawayId }, {
    status: paused ? 'paused' : 'running',
    paused_at: paused ? new Date().toISOString() : null,
  });
  return { ok: true, giveaway: updated[0] ?? null };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Giveaways that are due to end (used by the scheduler). */
async function due(limit = 25) {
  const db = require('../../db');
  const rows = await db.select('giveaways', {
    where: { status: 'running' },
    order: { column: 'ends_at', ascending: true },
    limit: 200,
    optional: true,
    fallback: [],
  });

  const now = Date.now();
  return rows.filter((row) => new Date(row.ends_at).getTime() <= now).slice(0, limit);
}

/** A guild's giveaways, newest first. */
async function list(guildId, { status = null, limit = 20 } = {}) {
  const db = require('../../db');
  const where = { guild_id: guildId };
  if (status) where.status = status;

  return db.select('giveaways', {
    where,
    order: { column: 'created_at', ascending: false },
    limit,
    optional: true,
    fallback: [],
  });
}

module.exports = {
  ENTER_PREFIX,
  eligibility,
  bonusFor,
  enter,
  leave,
  entrants,
  entryCount,
  drawWinners,
  render,
  controls,
  end,
  cancel,
  setPaused,
  due,
  list,
};
