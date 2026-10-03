'use strict';

/**
 * Server analytics service.
 *
 * Reads the rollup tables written by the messageCreate / guildMember events:
 *   analytics_counters  - lifetime totals, one row per guild
 *   analytics_daily     - per-day message / join / leave / voice counts
 *   analytics_channels  - per-channel message counts
 *   analytics_members   - per-member activity
 *   member_snapshots    - daily member counts, for growth charts
 *
 * Everything here is read-only; the counters are incremented by the events and
 * the `bump_analytics` Postgres function.
 */

const helpers = require('../../lib/helpers');
const logger = require('../../lib/logger');

const log = logger.child('analytics');

/** Lifetime counters for a guild. Returns zeroes when no row exists yet. */
async function counters(guildId) {
  const db = require('../../db');
  const row = await db.selectOne('analytics_counters', {
    where: { guild_id: guildId },
    optional: true,
  });

  return {
    messages: Number(row?.total_messages ?? 0),
    joins: Number(row?.total_joins ?? 0),
    leaves: Number(row?.total_leaves ?? 0),
    commands: Number(row?.total_commands ?? 0),
    voiceSeconds: Number(row?.total_voice_seconds ?? 0),
    modActions: Number(row?.total_mod_actions ?? 0),
    updatedAt: row?.updated_at ?? null,
  };
}

/** Daily rows for the last `days` days, oldest first. */
async function daily(guildId, days = 7) {
  const db = require('../../db');
  const since = helpers.today(helpers.addDays(new Date(), -(Math.max(1, days) - 1)));

  const rows = await db.select('analytics_daily', {
    where: { guild_id: guildId },
    order: { column: 'day', ascending: true },
    limit: 400,
    optional: true,
    fallback: [],
  });

  const filtered = rows.filter((row) => String(row.day) >= since);
  return filtered.length > 0 ? filtered : rows.slice(-Math.max(1, days));
}

/** Totals for the last `days` days. */
async function periodTotals(guildId, days = 7) {
  const rows = await daily(guildId, days);

  return rows.reduce((accumulator, row) => ({
    days: accumulator.days + 1,
    messages: accumulator.messages + Number(row.messages ?? 0),
    joins: accumulator.joins + Number(row.joins ?? 0),
    leaves: accumulator.leaves + Number(row.leaves ?? 0),
    commands: accumulator.commands + Number(row.commands ?? 0),
    voiceSeconds: accumulator.voiceSeconds + Number(row.voice_seconds ?? 0),
  }), { days: 0, messages: 0, joins: 0, leaves: 0, commands: 0, voiceSeconds: 0 });
}

/** Top channels by message count. */
async function topChannels(guildId, limit = 10) {
  const db = require('../../db');
  return db.select('analytics_channels', {
    where: { guild_id: guildId },
    order: { column: 'messages', ascending: false },
    limit,
    optional: true,
    fallback: [],
  });
}

/** Most active members by messages. */
async function topMembers(guildId, limit = 10) {
  const db = require('../../db');
  return db.select('analytics_members', {
    where: { guild_id: guildId },
    order: { column: 'messages', ascending: false },
    limit,
    optional: true,
    fallback: [],
  });
}

/** Most active members by voice time. */
async function topVoice(guildId, limit = 10) {
  const db = require('../../db');
  return db.select('analytics_members', {
    where: { guild_id: guildId },
    order: { column: 'voice_seconds', ascending: false },
    limit,
    optional: true,
    fallback: [],
  });
}

/** How many members have recorded activity. */
async function trackedMembers(guildId) {
  const db = require('../../db');
  const rows = await db.select('analytics_members', {
    columns: 'user_id',
    where: { guild_id: guildId },
    limit: 10000,
    optional: true,
    fallback: [],
  });
  return rows.length;
}

/**
 * Member-count snapshots over the last `days` days, oldest first.
 * Falls back to the live member count when no snapshots exist.
 */
async function growth(guildId, days = 14, guild = null) {
  const db = require('../../db');
  const since = helpers.today(helpers.addDays(new Date(), -(Math.max(1, days) - 1)));

  const rows = await db.select('member_snapshots', {
    where: { guild_id: guildId },
    order: { column: 'day', ascending: true },
    limit: 400,
    optional: true,
    fallback: [],
  });

  const filtered = rows.filter((row) => String(row.day) >= since);
  if (filtered.length === 0 && guild) {
    return [{ day: helpers.today(), member_count: guild.memberCount, synthetic: true }];
  }
  return filtered;
}

/**
 * Build a Unicode sparkline from a numeric series.
 * @param {number[]} values
 */
function sparkline(values, width = 24) {
  if (!values || values.length === 0) return '';

  let series = values.map((value) => Number(value) || 0);

  // Collapse to at most `width` points by averaging buckets.
  if (series.length > width) {
    const bucketSize = Math.ceil(series.length / width);
    const buckets = [];
    for (let index = 0; index < series.length; index += bucketSize) {
      const slice = series.slice(index, index + bucketSize);
      buckets.push(slice.reduce((sum, value) => sum + value, 0) / slice.length);
    }
    series = buckets;
  }

  const blocks = '▁▂▃▄▅▆▇█';
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min;

  return series.map((value) => {
    const ratio = range === 0 ? 0.5 : (value - min) / range;
    const level = Math.min(blocks.length - 1, Math.max(0, Math.round(ratio * (blocks.length - 1))));
    return blocks[level];
  }).join('');
}

/** A simple horizontal bar for `value` against `max`. */
function bar(value, max, width = 16) {
  if (!Number.isFinite(max) || max <= 0) return '▏';
  const filledCount = Math.max(1, Math.round((Number(value) / max) * width));
  return '█'.repeat(Math.min(width, filledCount));
}

/** Everything the overview embed needs, in one call. */
async function overview(guild, days = 7) {
  const [allTime, period, channels, members, snapshots, dailyRows] = await Promise.all([
    counters(guild.id),
    periodTotals(guild.id, days),
    topChannels(guild.id, 5),
    topMembers(guild.id, 5),
    growth(guild.id, 14, guild),
    daily(guild.id, 14),
  ]);

  return {
    allTime,
    period,
    channels,
    members,
    growth: snapshots,
    messageSeries: dailyRows.map((row) => Number(row.messages ?? 0)),
    joinSeries: dailyRows.map((row) => Number(row.joins ?? 0)),
    memberCount: guild.memberCount,
    tracked: await trackedMembers(guild.id),
  };
}

/** Build a CSV of the daily series plus lifetime totals. */
async function exportCsv(guildId, days = 30) {
  const rows = await daily(guildId, days);
  const allTime = await counters(guildId);

  const lines = [
    `Analytics export - guild ${guildId}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    'Lifetime totals',
    'messages,joins,leaves,commands,voice_seconds,mod_actions',
    [
      allTime.messages, allTime.joins, allTime.leaves,
      allTime.commands, allTime.voiceSeconds, allTime.modActions,
    ].join(','),
    '',
    'Daily',
    'day,messages,joins,leaves,commands,voice_seconds,unique_members',
    ...rows.map((row) => [
      row.day,
      row.messages ?? 0,
      row.joins ?? 0,
      row.leaves ?? 0,
      row.commands ?? 0,
      row.voice_seconds ?? 0,
      row.unique_members ?? 0,
    ].join(',')),
  ];

  log.debug(`exported ${rows.length} daily rows for ${guildId}`);
  return lines.join('\n');
}

module.exports = {
  counters,
  daily,
  periodTotals,
  topChannels,
  topMembers,
  topVoice,
  trackedMembers,
  growth,
  overview,
  exportCsv,
  sparkline,
  bar,
};
