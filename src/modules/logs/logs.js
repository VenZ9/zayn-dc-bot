'use strict';

/**
 * Module 11 - Logging & Audit.
 *
 *   /logs view | setup | channel | toggle | ignore | unignore | test
 *
 * Configuration lives in `logs_config`; the module's own logger service reads
 * it on every event, so writes here call `logsService.invalidate()` to drop the
 * service's cache. `/logs test` posts a sample entry through the bot itself.
 */

const { defineCommand } = require('../../core/command');
const helpers = require('../../lib/helpers');
const embeds = require('../../lib/embeds');
const config = require('../../config');
const { COLORS } = require('../../lib/constants');
const logsService = require('../logs/logger');

const GROUPS = Object.keys(logsService.LOG_EVENTS);

const GROUP_LABELS = Object.freeze({
  messages: '💬 Messages',
  members: '👥 Members',
  channels: '📁 Channels',
  roles: '🎭 Roles',
  voice: '🔊 Voice',
  moderation: '🛡️ Moderation',
  server: '⚙️ Server',
  invites: '📨 Invites',
});

const logs = defineCommand({
  name: 'logs',
  description: 'Choose which events are logged and where',
  module: 'logs',
  node: 'logs.setup',
  aliases: ['logging', 'log'],
  cooldown: 3,
  subcommands: [
    { name: 'view', description: 'Show the current logging configuration' },
    {
      name: 'setup',
      description: 'Turn logging on and send everything to one channel',
      args: [
        { name: 'channel', type: 'channel', required: true, description: 'The channel to log into' },
      ],
    },
    {
      name: 'channel',
      description: 'Send one category of events to its own channel',
      args: [
        {
          name: 'category',
          type: 'string',
          required: true,
          description: 'Which category',
          choices: GROUPS.map((group) => ({ name: GROUP_LABELS[group] ?? group, value: group })),
        },
        { name: 'channel', type: 'channel', required: false, description: 'Channel, or leave empty to disable this category' },
      ],
    },
    {
      name: 'toggle',
      description: 'Turn logging on or off',
      args: [
        { name: 'enabled', type: 'boolean', required: true, description: 'On or off' },
      ],
    },
    {
      name: 'ignore',
      description: 'Ignore a channel, role or member in the logs',
      args: [
        {
          name: 'type',
          type: 'string',
          required: true,
          description: 'What to ignore',
          choices: [
            { name: 'Channel', value: 'channel' },
            { name: 'Role', value: 'role' },
            { name: 'Member', value: 'user' },
          ],
        },
        { name: 'target', type: 'string', required: true, description: 'The channel, role or member', maxLength: 40 },
      ],
    },
    {
      name: 'unignore',
      description: 'Stop ignoring a channel, role or member',
      args: [
        {
          name: 'type',
          type: 'string',
          required: true,
          description: 'What to unignore',
          choices: [
            { name: 'Channel', value: 'channel' },
            { name: 'Role', value: 'role' },
            { name: 'Member', value: 'user' },
          ],
        },
        { name: 'target', type: 'string', required: true, description: 'The channel, role or member', maxLength: 40 },
      ],
    },
    {
      name: 'test',
      description: 'Post a sample log entry to a category',
      args: [
        {
          name: 'category',
          type: 'string',
          required: false,
          description: 'Which category to test',
          choices: GROUPS.map((group) => ({ name: GROUP_LABELS[group] ?? group, value: group })),
        },
      ],
    },
  ],

  async run(ctx) {
    const sub = ctx.subcommand?.name ?? 'view';

    const node = (sub === 'toggle') ? 'logs.toggle'
      : (sub === 'ignore' || sub === 'unignore') ? 'logs.ignore'
        : 'logs.setup';

    const check = ctx.hasPermission(node);
    if (!check.ok) return ctx.deny(check.reason);

    switch (sub) {
      case 'view': return runView(ctx);
      case 'setup': return runSetup(ctx);
      case 'channel': return runChannel(ctx);
      case 'toggle': return runToggle(ctx);
      case 'ignore': return runIgnore(ctx, true);
      case 'unignore': return runIgnore(ctx, false);
      case 'test': return runTest(ctx);
      default: return ctx.error('Unknown option', `\`${sub}\` is not available.`);
    }
  },
});

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
  enabled: false,
  events: {},
  ignored_channels: [],
  ignored_roles: [],
  ignored_users: [],
});

/** Read a guild's logging config from the database. */
async function readConfig(guildId) {
  const db = require('../../db');
  const row = await db.selectOne('logs_config', { where: { guild_id: guildId }, optional: true });
  return { ...DEFAULTS, ...(row ?? {}) };
}

/** Patch a guild's logging config and drop the logger service cache. */
async function writeConfig(guildId, patch) {
  const db = require('../../db');
  await db.upsert('logs_config', { guild_id: guildId, ...patch }, 'guild_id');
  logsService.invalidate(guildId);
  return readConfig(guildId);
}

/** Resolve a channel/role/user argument to a snowflake. */
function target(ctx, name) {
  const raw = ctx.get(name);
  if (!raw) return null;
  if (typeof raw === 'object' && raw.id) return raw.id;
  return helpers.extractId(String(raw)) ?? String(raw).trim();
}

// ---------------------------------------------------------------------------
// view / setup / channel / toggle
// ---------------------------------------------------------------------------

async function runView(ctx) {
  const cfg = await readConfig(ctx.guildId);
  const routed = cfg.events ?? {};

  const embed = embeds.embed({
    color: cfg.enabled ? COLORS.success : COLORS.neutral,
    title: '🧾 Log configuration',
    description: cfg.enabled ? '🟢 Logging is **enabled**.' : '🔴 Logging is **disabled**.',
  });

  for (const group of GROUPS) {
    const channelId = routed[group];
    embed.addFields({
      name: GROUP_LABELS[group] ?? group,
      value: channelId ? `<#${channelId}>` : '*not routed*',
      inline: true,
    });
  }

  const ignored = [];
  if (cfg.ignored_channels?.length) ignored.push(`Channels: ${cfg.ignored_channels.map((id) => `<#${id}>`).join(', ')}`);
  if (cfg.ignored_roles?.length) ignored.push(`Roles: ${cfg.ignored_roles.map((id) => `<@&${id}>`).join(', ')}`);
  if (cfg.ignored_users?.length) ignored.push(`Members: ${cfg.ignored_users.map((id) => `<@${id}>`).join(', ')}`);

  if (ignored.length > 0) {
    embed.addFields({ name: 'Ignored', value: helpers.truncate(ignored.join('\n'), 1024) });
  }

  embed.setFooter({ text: config.brandFooterText });
  return ctx.reply({ embeds: [embed] });
}

async function runSetup(ctx) {
  const channelId = target(ctx, 'channel');
  if (!channelId) return ctx.error('No channel', 'Choose a channel for the logs.');

  const events = Object.fromEntries(GROUPS.map((group) => [group, channelId]));

  await writeConfig(ctx.guildId, { enabled: true, events });

  return ctx.reply({
    embeds: [
      embeds.success(
        'Logging enabled',
        `Every category now logs to <#${channelId}>.\nUse \`/logs channel\` to route a category somewhere else.`,
      ),
    ],
  });
}

async function runChannel(ctx) {
  const group = ctx.get('category');
  if (!group || !GROUPS.includes(group)) {
    return ctx.error('Unknown category', `Pick one of: ${GROUPS.join(', ')}.`);
  }

  const cfg = await readConfig(ctx.guildId);
  const events = { ...(cfg.events ?? {}) };
  const channelId = target(ctx, 'channel');

  if (channelId) {
    events[group] = channelId;
  } else {
    delete events[group];
  }

  await writeConfig(ctx.guildId, { events });

  return ctx.reply({
    embeds: [
      channelId
        ? embeds.success('Category routed', `${GROUP_LABELS[group] ?? group} → <#${channelId}>.`)
        : embeds.info('Category disabled', `${GROUP_LABELS[group] ?? group} will no longer be logged.`),
    ],
  });
}

async function runToggle(ctx) {
  const enabled = ctx.get('enabled') === true;
  const cfg = await writeConfig(ctx.guildId, { enabled });

  return ctx.reply({
    embeds: [
      enabled
        ? embeds.success('Logging enabled', `Events will be posted to ${Object.keys(cfg.events ?? {}).length} category channel(s).`)
        : embeds.warning('Logging disabled', 'No events will be logged until you turn it back on.'),
    ],
  });
}

// ---------------------------------------------------------------------------
// ignore / unignore
// ---------------------------------------------------------------------------

async function runIgnore(ctx, add) {
  const type = ctx.get('type');
  const id = target(ctx, 'target');
  if (!id) return ctx.error('No target', 'Give a channel, role or member.');

  const key = type === 'channel' ? 'ignored_channels'
    : type === 'role' ? 'ignored_roles'
      : 'ignored_users';

  const cfg = await readConfig(ctx.guildId);
  const list = new Set(Array.isArray(cfg[key]) ? cfg[key] : []);

  if (add) list.add(id); else list.delete(id);

  await writeConfig(ctx.guildId, { [key]: Array.from(list) });

  const mention = type === 'channel' ? `<#${id}>` : type === 'role' ? `<@&${id}>` : `<@${id}>`;

  return ctx.reply({
    embeds: [
      embeds.success(
        add ? 'Now ignoring' : 'No longer ignoring',
        `${mention} will ${add ? 'no longer appear' : 'appear'} in the logs.`,
      ),
    ],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// test
// ---------------------------------------------------------------------------

async function runTest(ctx) {
  const group = ctx.get('category') ?? GROUPS[0];
  if (!GROUPS.includes(group)) {
    return ctx.error('Unknown category', `Pick one of: ${GROUPS.join(', ')}.`);
  }

  const cfg = await readConfig(ctx.guildId);
  const channelId = cfg.events?.[group];

  if (!cfg.enabled || !channelId) {
    return ctx.error(
      'Not routed',
      `The **${group}** category has no channel. Run \`/logs channel category:${group} channel:#…\` first.`,
    );
  }

  const channel = ctx.guild.channels.cache.get(channelId)
    ?? await ctx.guild.channels.fetch(channelId).catch(() => null);

  if (!channel || !channel.isTextBased()) {
    return ctx.error('Channel unavailable', 'The configured channel no longer exists. Reconfigure it.');
  }

  const embed = embeds.embed({
    color: COLORS.info,
    title: '🧪 Test log entry',
    description: `This is what a **${group}** event looks like.`,
  });

  embed.addFields(
    { name: 'Category', value: group, inline: true },
    { name: 'Requested by', value: `<@${ctx.userId}>`, inline: true },
  );
  embed.setFooter({ text: config.brandFooterText });
  embed.setTimestamp(new Date());

  const sent = await channel.send({ embeds: [embed] }).catch(() => null);

  if (!sent) return ctx.error('Could not post', 'I could not send to that channel.');

  return ctx.reply({
    embeds: [embeds.success('Test sent', `A sample entry was posted in <#${channelId}>.`)],
    ephemeral: true,
  });
}

module.exports = logs;
