'use strict';

/**
 * Module 12 - Bot Configuration.
 *
 *   /config view | prefix | language | timezone | modlog | muterole | djrole | reset | backup
 *   /help
 *   /setup
 *
 * Everything writes through db.getGuildConfig / db.setGuildConfig, which keeps
 * the guild_config cache in step.
 */

const { defineCommand } = require('../../core/command');
const helpers = require('../../lib/helpers');
const embeds = require('../../lib/embeds');
const ui = require('../../lib/ui');
const config = require('../../config');
const { COLORS, MODULES } = require('../../lib/constants');

/** Settings that /config reset restores. */
const RESET_PATCH = Object.freeze({
  prefix: config.defaultPrefix,
  prefix_enabled: true,
  prefix_delete_message: false,
  language: 'en',
  timezone: 'UTC',
  mod_log_channel: null,
  modlog_enabled: true,
  mute_role_id: null,
  dj_role_id: null,
  levels_enabled: true,
  levels_base_xp: 15,
  levels_min_xp: 5,
  levels_max_xp: 25,
  levels_cooldown_secs: 60,
});

/** A short, human summary of the most important settings. */
function summarise(cfg) {
  return [
    `**Prefix:** \`${cfg.prefix ?? config.defaultPrefix}\` ${cfg.prefix_enabled === false ? '*(disabled)*' : ''}`,
    `**Language:** ${cfg.language ?? 'en'}`,
    `**Timezone:** ${cfg.timezone ?? 'UTC'}`,
    `**Mod log:** ${cfg.mod_log_channel ? `<#${cfg.mod_log_channel}>` : '*not set*'}`,
    `**Mute role:** ${cfg.mute_role_id ? `<@&${cfg.mute_role_id}>` : '*not set*'}`,
    `**DJ role:** ${cfg.dj_role_id ? `<@&${cfg.dj_role_id}>` : '*not set*'}`,
    `**Leveling:** ${cfg.levels_enabled === false ? 'off' : `on (${cfg.levels_min_xp ?? 5}-${cfg.levels_max_xp ?? 25} XP)`}`,
    `**Welcome:** ${cfg.welcome_enabled ? `on ${cfg.welcome_channel ? `→ <#${cfg.welcome_channel}>` : ''}` : 'off'}`,
    `**Goodbye:** ${cfg.goodbye_enabled ? `on ${cfg.goodbye_channel ? `→ <#${cfg.goodbye_channel}>` : ''}` : 'off'}`,
    `**Autorole:** ${cfg.autorole_id ? `<@&${cfg.autorole_id}>` : '*not set*'}`,
  ].join('\n');
}

const configCommand = defineCommand({
  name: 'config',
  description: 'View and change this server\'s bot settings',
  module: 'config',
  node: 'config.view',
  aliases: ['settings', 'conf'],
  cooldown: 3,
  subcommands: [
    { name: 'view', description: 'Show the current settings' },
    {
      name: 'prefix',
      description: 'Change the command prefix',
      args: [
        { name: 'prefix', type: 'string', required: true, description: 'The new prefix (1-5 characters)', maxLength: 5 },
        { name: 'delete_commands', type: 'boolean', required: false, description: 'Delete the triggering message too' },
      ],
    },
    {
      name: 'language',
      description: 'Set the bot language',
      args: [
        {
          name: 'language',
          type: 'string',
          required: true,
          description: 'Which language',
          choices: [
            { name: 'English', value: 'en' },
            { name: 'Español', value: 'es' },
            { name: 'Français', value: 'fr' },
            { name: 'Deutsch', value: 'de' },
            { name: 'Português', value: 'pt' },
          ],
        },
      ],
    },
    {
      name: 'timezone',
      description: 'Set this server\'s timezone, used for timestamps',
      args: [
        { name: 'timezone', type: 'string', required: true, description: 'IANA timezone, e.g. Europe/London', maxLength: 60 },
      ],
    },
    {
      name: 'modlog',
      description: 'Set the moderation log channel',
      args: [
        { name: 'channel', type: 'channel', required: false, description: 'The channel, or leave empty to disable' },
      ],
    },
    {
      name: 'muterole',
      description: 'Set the role used for mutes',
      args: [
        { name: 'role', type: 'role', required: false, description: 'The mute role, or empty to clear' },
      ],
    },
    {
      name: 'djrole',
      description: 'Set the DJ role for music commands',
      args: [
        { name: 'role', type: 'role', required: false, description: 'The DJ role, or empty to clear' },
      ],
    },
    { name: 'reset', description: 'Reset every setting to its default' },
    { name: 'backup', description: 'Export your settings as JSON' },
  ],

  async run(ctx) {
    const sub = ctx.subcommand?.name ?? 'view';

    const nodeMap = {
      prefix: 'config.prefix',
      language: 'config.language',
      timezone: 'config.timezone',
      modlog: 'config.modlog',
      muterole: 'config.muterole',
      djrole: 'config.djrole',
      reset: 'config.reset',
      backup: 'config.backup',
      view: 'config.view',
    };

    const check = ctx.hasPermission(nodeMap[sub] ?? 'config.view');
    if (!check.ok) return ctx.deny(check.reason);

    switch (sub) {
      case 'view': return runView(ctx);
      case 'prefix': return runPrefix(ctx);
      case 'language': return runLanguage(ctx);
      case 'timezone': return runTimezone(ctx);
      case 'modlog': return runChannelSetting(ctx, 'mod_log_channel', 'Moderation log');
      case 'muterole': return runRoleSetting(ctx, 'mute_role_id', 'Mute role');
      case 'djrole': return runRoleSetting(ctx, 'dj_role_id', 'DJ role');
      case 'reset': return runReset(ctx);
      case 'backup': return runBackup(ctx);
      default: return ctx.error('Unknown option', `\`${sub}\` is not available.`);
    }
  },
});

/** Resolve a channel/role argument to an id, or null. */
function asId(ctx, name) {
  const raw = ctx.get(name);
  if (!raw) return null;
  if (typeof raw === 'object' && raw.id) return raw.id;
  return helpers.extractId(String(raw)) ?? String(raw).trim();
}

// ---------------------------------------------------------------------------

async function runView(ctx) {
  const db = require('../../db');
  const cfg = await db.getGuildConfig(ctx.guildId, { fresh: true });

  const embed = embeds.embed({
    color: COLORS.brand,
    title: '🔧 Server configuration',
    description: summarise(cfg),
  });

  embed.setFooter({ text: `Server ${ctx.guildId} • ${config.brandFooterText}` });
  return ctx.reply({ embeds: [embed] });
}

async function runPrefix(ctx) {
  const db = require('../../db');
  const prefix = String(ctx.get('prefix') ?? '').trim();

  if (!prefix) return ctx.error('No prefix', 'Give a prefix, 1 to 5 characters long.');
  if (prefix.length > 5) return ctx.error('Too long', 'A prefix can be at most 5 characters.');
  if (/\s/.test(prefix)) return ctx.error('Invalid prefix', 'A prefix cannot contain spaces.');

  const deleteCommands = ctx.get('delete_commands');

  const patch = { prefix };
  if (typeof deleteCommands === 'boolean') patch.prefix_delete_message = deleteCommands;

  await db.setGuildConfig(ctx.guildId, patch);

  return ctx.reply({
    embeds: [
      embeds.success(
        'Prefix updated',
        [
          `Commands now start with \`${prefix}\`.`,
          `For example: \`${prefix}help\``,
          typeof deleteCommands === 'boolean'
            ? `Triggering messages will ${deleteCommands ? 'be deleted' : 'be kept'}.`
            : '',
        ].filter(Boolean).join('\n'),
      ),
    ],
  });
}

async function runLanguage(ctx) {
  const db = require('../../db');
  const language = ctx.get('language');

  await db.setGuildConfig(ctx.guildId, { language });

  return ctx.reply({
    embeds: [embeds.success('Language updated', `The bot will now reply in **${language}**.`)],
  });
}

async function runTimezone(ctx) {
  const db = require('../../db');
  const timezone = String(ctx.get('timezone') ?? '').trim();

  if (!helpers.isValidTimezone(timezone)) {
    return ctx.error('Unknown timezone', 'Use an IANA name such as `Europe/London` or `America/New_York`.');
  }

  await db.setGuildConfig(ctx.guildId, { timezone });

  const now = helpers.timestamp(new Date(), 'f');
  return ctx.reply({
    embeds: [embeds.success('Timezone updated', `Your local time is now **${timezone}**.\nIt is currently ${now}.`)],
  });
}

async function runChannelSetting(ctx, column, label) {
  const db = require('../../db');
  const channelId = asId(ctx, 'channel');

  await db.setGuildConfig(ctx.guildId, { [column]: channelId });

  return ctx.reply({
    embeds: [
      channelId
        ? embeds.success(`${label} set`, `Now pointing at <#${channelId}>.`)
        : embeds.info(`${label} cleared`, 'That setting is now empty.'),
    ],
  });
}

async function runRoleSetting(ctx, column, label) {
  const db = require('../../db');
  const roleId = asId(ctx, 'role');

  await db.setGuildConfig(ctx.guildId, { [column]: roleId });

  return ctx.reply({
    embeds: [
      roleId
        ? embeds.success(`${label} set`, `Now using <@&${roleId}>.`)
        : embeds.info(`${label} cleared`, 'That setting is now empty.'),
    ],
  });
}

async function runReset(ctx) {
  const db = require('../../db');

  const confirmed = await ctx.confirm({
    title: 'Reset every setting?',
    body: 'This restores the prefix, language, timezone, mod log and leveling settings to their defaults. It cannot be undone.',
    confirmLabel: 'Reset everything',
  });
  if (!confirmed) return;

  await db.setGuildConfig(ctx.guildId, RESET_PATCH);
  db.invalidateGuildConfig(ctx.guildId);

  return ctx.reply({
    embeds: [embeds.success('Settings reset', 'Every setting is back to its default value.')],
  });
}

async function runBackup(ctx) {
  const db = require('../../db');
  const cfg = await db.getGuildConfig(ctx.guildId, { fresh: true });

  // Never export internal timestamps.
  const { created_at: _c, updated_at: _u, ...exported } = cfg;
  const json = JSON.stringify(exported, null, 2);

  return ctx.reply({
    content: `\`\`\`json\n${helpers.truncate(json, 1900)}\n\`\`\``,
    embeds: [embeds.info('Settings backup', 'Save this JSON to restore your configuration later.')],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------

const help = defineCommand({
  name: 'help',
  description: 'List every command, grouped by module',
  module: 'config',
  node: null,
  aliases: ['h', 'commands'],
  cooldown: 2,
  subcommands: [
    {
      name: 'module',
      description: 'Show the commands in one module',
      args: [
        {
          name: 'name',
          type: 'string',
          required: true,
          description: 'Which module',
          choices: MODULES.map((module) => ({ name: `${module.emoji} ${module.name}`, value: module.id })),
        },
      ],
    },
  ],

  async run(ctx) {
    const sub = ctx.subcommand?.name ?? null;
    if (sub === 'module') return runHelpModule(ctx, ctx.get('name') ?? ctx.get('module'));

    // Build one page per module from the live command registry.
    const registry = ctx.client?.commands;
    const pages = [];

    for (const module of MODULES) {
      const commands = collectCommands(registry, module.id);
      if (commands.length === 0) continue;

      const page = embeds.embed({
        color: COLORS.brand,
        title: `${module.emoji} ${module.name}`,
        description: module.description,
      });

      page.addFields({
        name: `Commands (${commands.length})`,
        value: helpers.truncate(
          commands.map((command) => `\`${ctx.prefix}${command}\``).join(' · '),
          1024,
        ),
      });

      page.setFooter({ text: `${config.brandFooterText} • ${MODULES.findIndex((m) => m.id === module.id) + 1}/${MODULES.length}` });
      pages.push(page);
    }

    const footer = embeds.embed({
      color: COLORS.info,
      title: '📖 About',
      description: [
        `**${config.brand.name ?? 'ZAYN\'S DC BOT'}** — a multi-purpose bot with ${MODULES.length} modules.`,
        '',
        'Commands work both ways: as slash commands (`/ban`) and with the prefix ' +
          `(\`${ctx.prefix}ban\`).`,
        `Use \`/${'help module'}\` to jump to one module.`,
      ].join('\n'),
    });

    if (pages.length === 0) return ctx.reply({ embeds: [footer] });

    return ctx.paginate([footer, ...pages]);
  },
});

/** Commands belonging to a module, sorted by name. */
function collectCommands(registry, moduleId) {
  if (!registry) return [];

  const values = typeof registry.values === 'function'
    ? Array.from(registry.values())
    : Object.values(registry);

  return values
    .filter((command) => command && command.module === moduleId && command.hidden !== true)
    .map((command) => command.name)
    .sort();
}

async function runHelpModule(ctx, moduleId) {
  const module = MODULES.find((entry) => entry.id === moduleId);
  if (!module) return ctx.error('Unknown module', 'That module does not exist.');

  const commands = collectCommands(ctx.client?.commands, moduleId);

  if (commands.length === 0) {
    return ctx.reply({
      embeds: [embeds.info(`${module.emoji} ${module.name}`, `${module.description}\n\nNo commands are loaded for this module.`)],
    });
  }

  const embed = embeds.embed({
    color: COLORS.brand,
    title: `${module.emoji} ${module.name}`,
    description: module.description,
  });

  embed.addFields({
    name: `Commands (${commands.length})`,
    value: commands.map((command) => `\`/${command}\``).join('\n').slice(0, 1024),
  });

  embed.setFooter({ text: config.brandFooterText });
  return ctx.reply({ embeds: [embed] });
}

// ---------------------------------------------------------------------------
// /setup
// ---------------------------------------------------------------------------

const setup = defineCommand({
  name: 'setup',
  description: 'A guided checklist to get the bot configured',
  module: 'config',
  node: 'config.setup',
  aliases: ['quickstart'],
  cooldown: 5,

  async run(ctx) {
    const db = require('../../db');
    const cfg = await db.getGuildConfig(ctx.guildId, { fresh: true });
    const custom = require('../custom/custom-command-service');
    const logsRow = await db.selectOne('logs_config', { where: { guild_id: ctx.guildId }, optional: true });

    const checks = [
      { done: Boolean(cfg.prefix), label: 'Set a command prefix', hint: `\`/config prefix prefix:${config.defaultPrefix}\`` },
      { done: Boolean(cfg.timezone && cfg.timezone !== 'UTC'), label: 'Set the server timezone', hint: '`/config timezone timezone:Europe/London`' },
      { done: Boolean(cfg.mod_log_channel), label: 'Choose a moderation log channel', hint: '`/config modlog channel:#mod-logs`' },
      { done: cfg.welcome_enabled === true, label: 'Turn on welcome messages', hint: '`/welcome setup`' },
      { done: Boolean(cfg.autorole_id), label: 'Set an autorole for new members', hint: '`/welcome autorole role:@Member`' },
      { done: Boolean(logsRow?.enabled), label: 'Enable event logging', hint: '`/logs setup channel:#logs`' },
      { done: (await custom.count(ctx.guildId)) > 0, label: 'Create a custom command', hint: '`/customcmd add trigger:rules response:...`' },
    ];

    const done = checks.filter((check) => check.done).length;
    const percent = Math.round((done / checks.length) * 100);

    const embed = embeds.embed({
      color: done === checks.length ? COLORS.success : COLORS.brand,
      title: '🚀 Server setup checklist',
      description: [
        `${helpers.progressBar(done, checks.length, 12)} **${percent}%** complete`,
        '',
        ...checks.map((check) => `${check.done ? '✅' : '⬜'} ${check.label}${check.done ? '' : `\n   ↳ ${check.hint}`}`),
      ].join('\n'),
    });

    embed.setFooter({ text: config.brandFooterText });

    const row = ui.row(
      ui.button({
        id: 'setup:refresh',
        label: 'Refresh',
        emoji: '🔄',
        style: 'secondary',
      }),
      ui.button({
        id: 'setup:help',
        label: 'All commands',
        emoji: '📖',
        style: 'primary',
      }),
    );

    return ctx.reply({ embeds: [embed], components: [row] });
  },

  components: {
    'setup:refresh': async (interaction) => {
      const [, action] = interaction.customId.split(':');

      if (action === 'help') {
        return interaction.reply({
          embeds: [embeds.info('All commands', 'Run `/help` to browse every module.')],
          ephemeral: true,
        });
      }

      return interaction.reply({
        embeds: [embeds.info('Refreshing', 'Run `/setup` again to see the latest state.')],
        ephemeral: true,
      });
    },
  },
});

module.exports = { config: configCommand, help, setup };
