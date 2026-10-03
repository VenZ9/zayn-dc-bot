'use strict';

/**
 * Module 4 - Server Analytics.
 *
 *   /analytics overview | messages | members | channels | growth | voice |
 *              activity | export
 *
 * Reads only; the counters are written by the events in src/events and the
 * `bump_analytics` Postgres function.
 */

const { AttachmentBuilder } = require('discord.js');
const { defineCommand } = require('../../core/command');
const helpers = require('../../lib/helpers');
const embeds = require('../../lib/embeds');
const config = require('../../config');
const { COLORS } = require('../../lib/constants');
const service = require('./analytics-service');

/** Resolve the number of days to report on, clamped to a sane range. */
function resolveDays(ctx, fallback = 7) {
  const raw = ctx.get('days');
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return helpers.clamp(parsed, 1, 90);
}

const analytics = defineCommand({
  name: 'analytics',
  description: 'Server statistics and activity insights',
  module: 'analytics',
  node: 'analytics.view',
  aliases: ['stats', 'serverstats'],
  cooldown: 5,
  subcommands: [
    {
      name: 'overview',
      description: 'A summary of server activity',
      args: [
        { name: 'days', type: 'integer', required: false, description: 'Period to summarise (1-90, default 7)', min: 1, max: 90 },
      ],
    },
    {
      name: 'messages',
      description: 'Message volume over time',
      args: [
        { name: 'days', type: 'integer', required: false, description: 'Period to report (1-90, default 14)', min: 1, max: 90 },
      ],
    },
    {
      name: 'members',
      description: 'Most active members',
      args: [
        { name: 'limit', type: 'integer', required: false, description: 'How many to show (1-25, default 10)', min: 1, max: 25 },
      ],
    },
    {
      name: 'channels',
      description: 'Busiest channels',
      args: [
        { name: 'limit', type: 'integer', required: false, description: 'How many to show (1-25, default 10)', min: 1, max: 25 },
      ],
    },
    {
      name: 'growth',
      description: 'Member growth over time',
      args: [
        { name: 'days', type: 'integer', required: false, description: 'Period to report (1-90, default 14)', min: 1, max: 90 },
      ],
    },
    {
      name: 'voice',
      description: 'Most voice activity',
      args: [
        { name: 'limit', type: 'integer', required: false, description: 'How many to show (1-25, default 10)', min: 1, max: 25 },
      ],
    },
    {
      name: 'activity',
      description: 'Activity breakdown by hour of day',
    },
    {
      name: 'export',
      description: 'Export the raw analytics as a CSV file',
      args: [
        { name: 'days', type: 'integer', required: false, description: 'Days of history (1-90, default 30)', min: 1, max: 90 },
      ],
    },
  ],

  async run(ctx) {
    const sub = ctx.subcommand?.name ?? 'overview';

    const check = ctx.hasPermission(sub === 'export' ? 'analytics.export' : 'analytics.view');
    if (!check.ok) return ctx.deny(check.reason);

    switch (sub) {
      case 'overview': return runOverview(ctx);
      case 'messages': return runMessages(ctx);
      case 'members': return runMembers(ctx);
      case 'channels': return runChannels(ctx);
      case 'growth': return runGrowth(ctx);
      case 'voice': return runVoice(ctx);
      case 'activity': return runActivity(ctx);
      case 'export': return runExport(ctx);
      default: return ctx.error('Unknown option', `\`${sub}\` is not available.`);
    }
  },
});

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

async function runOverview(ctx) {
  const days = resolveDays(ctx, 7);
  const data = await service.overview(ctx.guild, days);

  const embed = embeds.embed({
    color: COLORS.brand,
    title: `📊 ${ctx.guild.name} — overview`,
    description: `Reporting the last **${days}** day${days === 1 ? '' : 's'}.`,
  });

  embed.addFields(
    {
      name: '👥 Members',
      value: [
        `Total: **${helpers.formatNumber(data.memberCount)}**`,
        `Joined: **+${helpers.formatNumber(data.period.joins)}**`,
        `Left: **-${helpers.formatNumber(data.period.leaves)}**`,
      ].join('\n'),
      inline: true,
    },
    {
      name: `💬 Messages (${days}d)`,
      value: [
        `Period: **${helpers.formatNumber(data.period.messages)}**`,
        `All time: **${helpers.formatNumber(data.allTime.messages)}**`,
        `Per day: **${helpers.formatNumber(Math.round(data.period.messages / Math.max(1, data.period.days)))}**`,
      ].join('\n'),
      inline: true,
    },
    {
      name: '🎙️ Voice',
      value: [
        `Period: **${helpers.formatDuration(data.period.voiceSeconds, { units: 1 })}**`,
        `Commands: **${helpers.formatNumber(data.period.commands)}**`,
        `Tracked: **${helpers.formatNumber(data.tracked)}**`,
      ].join('\n'),
      inline: true,
    },
  );

  // Message trend sparkline.
  if (data.messageSeries.some((value) => value > 0)) {
    const spark = service.sparkline(data.messageSeries);
    embed.addFields({
      name: '📈 Message trend (14d)',
      value: `\`${spark}\`\nPeak: **${helpers.formatNumber(Math.max(...data.messageSeries))}** • Total: **${helpers.formatNumber(data.messageSeries.reduce((sum, value) => sum + value, 0))}**`,
    });
  }

  if (data.channels.length > 0) {
    const top = data.channels[0].messages;
    embed.addFields({
      name: '🔥 Busiest channels',
      value: data.channels.map((row) => {
        const mention = ctx.guild.channels.cache.has(row.channel_id)
          ? `<#${row.channel_id}>`
          : `\`${row.channel_id}\``;
        return `${mention} — **${helpers.formatNumber(row.messages)}**\n\`${service.bar(row.messages, top, 14)}\``;
      }).join('\n'),
    });
  }

  embed.setThumbnail(ctx.guild.iconURL({ size: 256 }));
  embed.setFooter({ text: `${ctx.guild.name} • ${config.brandFooterText}` });

  return ctx.reply({ embeds: [embed] });
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

async function runMessages(ctx) {
  const days = resolveDays(ctx, 14);
  const rows = await service.daily(ctx.guildId, days);

  if (rows.length === 0) {
    return ctx.reply({
      embeds: [embeds.info('No message data', 'No messages have been recorded in this period yet.')],
    });
  }

  const values = rows.map((row) => Number(row.messages ?? 0));
  const peak = Math.max(...values);
  const total = values.reduce((sum, value) => sum + value, 0);

  const embed = embeds.embed({
    color: COLORS.brand,
    title: '💬 Message volume',
    description: [
      `**${helpers.formatNumber(total)}** messages across **${rows.length}** day${rows.length === 1 ? '' : 's'}.`,
      `Average **${helpers.formatNumber(Math.round(total / rows.length))}** per day.`,
      '',
      `\`${service.sparkline(values, 30)}\``,
    ].join('\n'),
  });

  embed.addFields({
    name: 'Daily breakdown',
    value: rows.slice(-12).map((row) => {
      const value = Number(row.messages ?? 0);
      return `\`${String(row.day).slice(5)}\` ${service.bar(value, peak, 12)} **${helpers.formatNumber(value)}**`;
    }).join('\n'),
  });

  embed.setFooter({ text: `Peak day: ${helpers.formatNumber(peak)} messages • ${config.brandFooterText}` });

  return ctx.reply({ embeds: [embed] });
}

// ---------------------------------------------------------------------------
// members
// ---------------------------------------------------------------------------

async function runMembers(ctx) {
  const limit = helpers.clamp(Number.parseInt(ctx.get('limit'), 10) || 10, 1, 25);
  const rows = await service.topMembers(ctx.guildId, limit);

  if (rows.length === 0) {
    return ctx.reply({
      embeds: [embeds.info('No activity yet', 'No member activity has been recorded.')],
    });
  }

  const peak = Number(rows[0].messages ?? 0);
  const medals = ['🥇', '🥈', '🥉'];

  const embed = embeds.embed({
    color: COLORS.brand,
    title: '🏆 Most active members',
    description: rows.map((row, index) => {
      const rank = medals[index] ?? `**${index + 1}.**`;
      return [
        `${rank} <@${row.user_id}>`,
        `\`${service.bar(row.messages, peak, 14)}\` **${helpers.formatNumber(row.messages)}** msgs • ${helpers.formatDuration(Number(row.voice_seconds ?? 0), { units: 1 })} voice`,
      ].join('\n');
    }).join('\n\n'),
  });

  return ctx.reply({ embeds: [embed] });
}

// ---------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------

async function runChannels(ctx) {
  const limit = helpers.clamp(Number.parseInt(ctx.get('limit'), 10) || 10, 1, 25);
  const rows = await service.topChannels(ctx.guildId, limit);

  if (rows.length === 0) {
    return ctx.reply({
      embeds: [embeds.info('No channel data', 'No channel activity has been recorded.')],
    });
  }

  const peak = Number(rows[0].messages ?? 0);
  const total = rows.reduce((sum, row) => sum + Number(row.messages ?? 0), 0);

  const embed = embeds.embed({
    color: COLORS.brand,
    title: '📢 Busiest channels',
    description: [
      `Top **${rows.length}** channels account for **${helpers.formatNumber(total)}** messages.`,
      '',
      ...rows.map((row, index) => {
        const name = ctx.guild.channels.cache.has(row.channel_id)
          ? `<#${row.channel_id}>`
          : `\`${row.channel_id}\``;
        const share = total > 0 ? Math.round((Number(row.messages) / total) * 100) : 0;
        return `${index + 1}. ${name} — **${helpers.formatNumber(row.messages)}** (${share}%)\n\`${service.bar(row.messages, peak, 16)}\``;
      }),
    ].join('\n'),
  });

  return ctx.reply({ embeds: [embed] });
}

// ---------------------------------------------------------------------------
// growth
// ---------------------------------------------------------------------------

async function runGrowth(ctx) {
  const days = resolveDays(ctx, 14);
  const rows = await service.growth(ctx.guildId, days, ctx.guild);

  const values = rows.map((row) => Number(row.member_count ?? 0));
  const first = values[0] ?? ctx.guild.memberCount;
  const last = values[values.length - 1] ?? ctx.guild.memberCount;
  const delta = last - first;

  const embed = embeds.embed({
    color: delta >= 0 ? COLORS.success : COLORS.danger,
    title: '📈 Member growth',
    description: [
      `Now: **${helpers.formatNumber(ctx.guild.memberCount)}** members`,
      `${delta >= 0 ? 'Growth' : 'Decline'}: **${delta >= 0 ? '+' : ''}${helpers.formatNumber(delta)}** over the period`,
      '',
      `\`${service.sparkline(values, 30)}\``,
    ].join('\n'),
  });

  if (rows.some((row) => row.synthetic)) {
    embed.addFields({
      name: 'Note',
      value: 'No historical snapshots yet — the chart will fill in as the daily snapshot task runs.',
    });
  } else {
    embed.addFields({
      name: 'Snapshots',
      value: rows.slice(-10).map((row) => `\`${String(row.day).slice(5)}\` **${helpers.formatNumber(row.member_count)}**`).join('\n'),
    });
  }

  return ctx.reply({ embeds: [embed] });
}

// ---------------------------------------------------------------------------
// voice
// ---------------------------------------------------------------------------

async function runVoice(ctx) {
  const limit = helpers.clamp(Number.parseInt(ctx.get('limit'), 10) || 10, 1, 25);
  const rows = await service.topVoice(ctx.guildId, limit);

  const ranked = rows.filter((row) => Number(row.voice_seconds ?? 0) > 0);

  if (ranked.length === 0) {
    return ctx.reply({
      embeds: [embeds.info('No voice data', 'No voice activity has been recorded.')],
    });
  }

  const peak = Number(ranked[0].voice_seconds ?? 0);

  const embed = embeds.embed({
    color: COLORS.brand,
    title: '🎙️ Most voice activity',
    description: ranked.map((row, index) => [
      `**${index + 1}.** <@${row.user_id}>`,
      `\`${service.bar(row.voice_seconds, peak, 14)}\` **${helpers.formatDuration(Number(row.voice_seconds), { units: 2 })}**`,
    ].join('\n')).join('\n\n'),
  });

  return ctx.reply({ embeds: [embed] });
}

// ---------------------------------------------------------------------------
// activity
// ---------------------------------------------------------------------------

async function runActivity(ctx) {
  const db = require('../../db');

  // The daily table carries no hour breakdown, so this reports the weekday
  // distribution instead: which days the server is busiest.
  const rows = await service.daily(ctx.guildId, 90);

  if (rows.length === 0) {
    return ctx.reply({
      embeds: [embeds.info('Not enough data', 'At least a few days of activity are needed for this view.')],
    });
  }

  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const totals = new Array(7).fill(0);

  for (const row of rows) {
    const date = new Date(row.day);
    if (Number.isNaN(date.getTime())) continue;
    totals[date.getUTCDay()] += Number(row.messages ?? 0);
  }

  const peak = Math.max(...totals);

  const embed = embeds.embed({
    color: COLORS.brand,
    title: '📅 Activity by weekday',
    description: [
      `Based on **${rows.length}** days of history.`,
      '',
      ...weekdays.map((name, index) =>
        `\`${name.padEnd(9)}\` ${service.bar(totals[index], peak, 14)} **${helpers.formatNumber(totals[index])}**`),
      '',
      peak > 0 ? `Busiest day: **${weekdays[totals.indexOf(peak)]}**` : 'No messages recorded.',
    ].join('\n'),
  });

  const allTime = await service.counters(ctx.guildId);
  embed.addFields(
    { name: 'Lifetime messages', value: helpers.formatNumber(allTime.messages), inline: true },
    { name: 'Lifetime commands', value: helpers.formatNumber(allTime.commands), inline: true },
    { name: 'Moderation actions', value: helpers.formatNumber(allTime.modActions), inline: true },
  );

  void db;
  return ctx.reply({ embeds: [embed] });
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

async function runExport(ctx) {
  const days = resolveDays(ctx, 30);
  await ctx.defer({ ephemeral: true });

  const csv = await service.exportCsv(ctx.guildId, days);
  const file = new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: 'analytics.csv' });

  return ctx.editReply({
    embeds: [
      embeds.success(
        'Analytics exported',
        `The last **${days}** days are in the attached CSV.`,
      ),
    ],
    files: [file],
  });
}

module.exports = analytics;
