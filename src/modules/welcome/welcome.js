'use strict';

/**
 * Module 5 - Welcome & Goodbye.
 *
 *   /welcome view | setup | message | test | toggle | dm | image | autorole
 *
 * Configuration lives in guild_config, so the join/leave events read the same
 * fields this command writes.
 */

const { PermissionFlagsBits } = require('discord.js');
const { defineCommand } = require('../../core/command');
const helpers = require('../../lib/helpers');
const embeds = require('../../lib/embeds');
const config = require('../../config');
const { COLORS } = require('../../lib/constants');
const service = require('./welcome-service');

/** Resolve an argument to a channel, accepting a slash object or a prefix token. */
function asChannel(ctx, name) {
  const raw = ctx.get(name);
  if (!raw) return null;
  if (typeof raw === 'object' && raw.id) return raw;

  const id = helpers.extractId(String(raw));
  if (!id) return null;
  return ctx.guild.channels.cache.get(id) ?? null;
}

/** Resolve an argument to a role, accepting a slash object or a prefix token. */
function asRole(ctx, name) {
  const raw = ctx.get(name);
  if (!raw) return null;
  if (typeof raw === 'object' && raw.id) return raw;

  const id = helpers.extractId(String(raw));
  if (id) return ctx.guild.roles.cache.get(id) ?? null;

  const lowered = String(raw).toLowerCase().replace(/^@/, '');
  return ctx.guild.roles.cache.find((role) => role.name.toLowerCase() === lowered) ?? null;
}

const welcome = defineCommand({
  name: 'welcome',
  description: 'Welcome and goodbye messages, autorole and DMs',
  module: 'welcome',
  node: 'welcome.view',
  aliases: ['greet', 'goodbye'],
  cooldown: 3,
  subcommands: [
    { name: 'view', description: 'Show the current welcome configuration' },
    {
      name: 'setup',
      description: 'Set the channel greeting messages are sent to',
      args: [
        { name: 'channel', type: 'channel', required: true, description: 'Where to send greetings' },
        {
          name: 'type',
          type: 'string',
          required: false,
          description: 'Which message to configure (default: welcome)',
          choices: [
            { name: 'Welcome', value: 'welcome' },
            { name: 'Goodbye', value: 'goodbye' },
          ],
        },
      ],
    },
    {
      name: 'message',
      description: 'Set the greeting text, using {user} {server} {count} placeholders',
      args: [
        { name: 'text', type: 'string', required: true, description: 'The message. Use \\n for a line break', maxLength: 1500 },
        {
          name: 'type',
          type: 'string',
          required: false,
          description: 'Which message to edit (default: welcome)',
          choices: [
            { name: 'Welcome', value: 'welcome' },
            { name: 'Goodbye', value: 'goodbye' },
          ],
        },
      ],
    },
    {
      name: 'test',
      description: 'Preview a greeting message',
      args: [
        {
          name: 'type',
          type: 'string',
          required: false,
          description: 'Which message to preview (default: welcome)',
          choices: [
            { name: 'Welcome', value: 'welcome' },
            { name: 'Goodbye', value: 'goodbye' },
          ],
        },
      ],
    },
    {
      name: 'toggle',
      description: 'Turn greetings on or off',
      args: [
        {
          name: 'type',
          type: 'string',
          required: true,
          description: 'Which message to toggle',
          choices: [
            { name: 'Welcome', value: 'welcome' },
            { name: 'Goodbye', value: 'goodbye' },
          ],
        },
        { name: 'enabled', type: 'boolean', required: false, description: 'On or off (default: toggle)' },
      ],
    },
    {
      name: 'dm',
      description: 'Send a welcome DM to new members',
      args: [
        { name: 'enabled', type: 'boolean', required: true, description: 'On or off' },
      ],
    },
    {
      name: 'image',
      description: 'Set the banner image shown on the welcome message',
      args: [
        { name: 'url', type: 'string', required: false, description: 'Image URL, or omit to clear it', maxLength: 500 },
      ],
    },
    {
      name: 'autorole',
      description: 'Give new members a role automatically',
      args: [
        { name: 'role', type: 'role', required: false, description: 'The role, or omit to disable autorole' },
      ],
    },
  ],

  async run(ctx) {
    const sub = ctx.subcommand?.name ?? 'view';

    switch (sub) {
      case 'view': return requirePerm(ctx, 'welcome.view', () => runView(ctx));
      case 'setup': return requirePerm(ctx, 'welcome.channel', () => runSetup(ctx));
      case 'message': return requirePerm(ctx, 'welcome.message', () => runMessage(ctx));
      case 'test': return requirePerm(ctx, 'welcome.test', () => runTest(ctx));
      case 'toggle': return requirePerm(ctx, 'welcome.toggle', () => runToggle(ctx));
      case 'dm': return requirePerm(ctx, 'welcome.dm', () => runDm(ctx));
      case 'image': return requirePerm(ctx, 'welcome.image', () => runImage(ctx));
      case 'autorole': return requirePerm(ctx, 'welcome.autorole', () => runAutorole(ctx));
      default: return ctx.error('Unknown option', `\`${sub}\` is not available.`);
    }
  },
});

/** Run a handler only when the caller holds the node. */
function requirePerm(ctx, node, handler) {
  const check = ctx.hasPermission(node);
  if (!check.ok) return ctx.deny(check.reason);
  return handler();
}

/** Reload the config fresh after a write. */
async function freshConfig(ctx) {
  const db = require('../../db');
  return db.getGuildConfig(ctx.guildId, { fresh: true });
}

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

async function runView(ctx) {
  const guildConfig = await freshConfig(ctx);
  const { settings, channelOf, roleOf } = service.describe(ctx.guild);
  const { welcome: welcomeSettings, goodbye, autorole } = settings;

  const embed = embeds.embed({
    color: COLORS.brand,
    title: '👋 Welcome configuration',
    description: 'Use `/welcome setup`, `/welcome message` and `/welcome toggle` to change these.',
  });

  embed.addFields(
    {
      name: '👋 Welcome',
      value: [
        `Status: ${welcomeSettings.enabled ? '🟢 **on**' : '🔴 **off**'}`,
        `Channel: ${channelOf(welcomeSettings.channel)}`,
        `DM: ${welcomeSettings.dm ? 'on' : 'off'}`,
        `Image: ${welcomeSettings.image ? '✅ set' : '*none*'}`,
        `Message: ${welcomeSettings.message ? helpers.truncate(welcomeSettings.message, 200) : '*default*'}`,
      ].join('\n'),
    },
    {
      name: '👋 Goodbye',
      value: [
        `Status: ${goodbye.enabled ? '🟢 **on**' : '🔴 **off**'}`,
        `Channel: ${channelOf(goodbye.channel)}`,
        `Message: ${goodbye.message ? helpers.truncate(goodbye.message, 200) : '*default*'}`,
      ].join('\n'),
    },
    {
      name: '🎭 Autorole',
      value: roleOf(autorole),
    },
    {
      name: 'Placeholders',
      value: '`{user}` `{user.tag}` `{user.name}` `{user.id}` `{server}` `{count}` `{ordinal}` `{created}`',
    },
  );

  embed.setFooter({ text: `Server ${ctx.guild.name} • ${config.brandFooterText}` });

  return ctx.reply({ embeds: [embed] });
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

async function runSetup(ctx) {
  const channel = asChannel(ctx, 'channel');
  if (!channel) return ctx.error('Channel not found', 'That is not a valid channel.');

  const type = ctx.get('type') || 'welcome';
  const db = require('../../db');

  const patch = type === 'welcome'
    ? { welcome_channel: channel.id, welcome_enabled: true }
    : { goodbye_channel: channel.id, goodbye_enabled: true };

  await db.setGuildConfig(ctx.guildId, patch);

  return ctx.reply({
    embeds: [
      embeds.success(
        `${type === 'welcome' ? 'Welcome' : 'Goodbye'} channel set`,
        `${type === 'welcome' ? 'Greetings' : 'Farewells'} will be posted in <#${channel.id}>.`,
      ),
    ],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// message
// ---------------------------------------------------------------------------

async function runMessage(ctx) {
  const text = ctx.get('text');
  if (!text) return ctx.error('No message given', 'Provide the message text.');

  const type = ctx.get('type') || 'welcome';
  const db = require('../../db');

  const patch = type === 'welcome'
    ? { welcome_message: String(text).slice(0, 2000) }
    : { goodbye_message: String(text).slice(0, 2000) };

  await db.setGuildConfig(ctx.guildId, patch);

  // Show a live preview so the author can see the placeholders resolved.
  const preview = service.render(patch[type === 'welcome' ? 'welcome_message' : 'goodbye_message'], service.memberValues(ctx.member), {
    color: type === 'welcome' ? COLORS.success : COLORS.danger,
  });

  return ctx.reply({
    embeds: [
      embeds.success('Message saved', `The **${type}** message has been updated. Preview below.`),
      ...preview.embeds,
    ],
    ephemeral: false,
  });
}

// ---------------------------------------------------------------------------
// test
// ---------------------------------------------------------------------------

async function runTest(ctx) {
  const type = ctx.get('type') || 'welcome';
  const guildConfig = await freshConfig(ctx);

  const template = type === 'welcome' ? guildConfig.welcome_message : guildConfig.goodbye_message;
  const preview = service.render(template, service.memberValues(ctx.member), {
    defaultText: type === 'welcome'
      ? 'Welcome to **{server}**, {user}! You are member **#{count}**.'
      : '**{user.tag}** has left **{server}**.',
    color: type === 'welcome' ? COLORS.success : COLORS.danger,
    imageUrl: type === 'welcome' ? guildConfig.welcome_image : null,
  });

  const notes = [];
  const channelId = type === 'welcome' ? guildConfig.welcome_channel : guildConfig.goodbye_channel;
  const enabled = type === 'welcome' ? guildConfig.welcome_enabled : guildConfig.goodbye_enabled;

  if (!enabled) notes.push('⚠️ This greeting is currently **off** — run `/welcome toggle` to enable it.');
  if (!channelId) notes.push('⚠️ No channel is set — run `/welcome setup` first.');
  else if (!ctx.guild.channels.cache.has(channelId)) notes.push('⚠️ The configured channel no longer exists.');

  if (notes.length > 0) {
    preview.embeds[0].addFields({ name: 'Heads up', value: notes.join('\n') });
  }

  return ctx.reply({ embeds: preview.embeds });
}

// ---------------------------------------------------------------------------
// toggle
// ---------------------------------------------------------------------------

async function runToggle(ctx) {
  const type = ctx.get('type') || 'welcome';
  const explicit = ctx.get('enabled');
  const guildConfig = await freshConfig(ctx);

  const current = type === 'welcome' ? guildConfig.welcome_enabled : guildConfig.goodbye_enabled;
  const next = typeof explicit === 'boolean' ? explicit : !current;

  const db = require('../../db');
  const patch = type === 'welcome' ? { welcome_enabled: next } : { goodbye_enabled: next };
  await db.setGuildConfig(ctx.guildId, patch);

  return ctx.reply({
    embeds: [
      embeds.success(
        `${type === 'welcome' ? 'Welcome' : 'Goodbye'} message ${next ? 'enabled' : 'disabled'}`,
        next
          ? 'Greetings will be posted as members join or leave.'
          : 'No further messages will be posted.',
      ),
    ],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// dm
// ---------------------------------------------------------------------------

async function runDm(ctx) {
  const enabled = ctx.get('enabled');
  if (typeof enabled !== 'boolean') return ctx.error('No value given', 'Choose `true` or `false`.');

  const db = require('../../db');
  await db.setGuildConfig(ctx.guildId, { welcome_dm: enabled });

  return ctx.reply({
    embeds: [
      embeds.success(
        `Welcome DM ${enabled ? 'enabled' : 'disabled'}`,
        enabled
          ? 'New members will also receive a direct message.'
          : 'New members will not be messaged directly.',
      ),
    ],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// image
// ---------------------------------------------------------------------------

async function runImage(ctx) {
  const raw = ctx.get('url');
  const db = require('../../db');

  if (!raw) {
    await db.setGuildConfig(ctx.guildId, { welcome_image: null });
    return ctx.reply({
      embeds: [embeds.success('Banner cleared', 'The welcome message no longer has a banner image.')],
      ephemeral: true,
    });
  }

  const url = String(raw).trim();
  if (!/^https?:\/\/\S+$/i.test(url)) {
    return ctx.error('Invalid URL', 'Provide a direct `https://` image link.');
  }

  await db.setGuildConfig(ctx.guildId, { welcome_image: url });

  return ctx.reply({
    embeds: [
      embeds.embed({
        color: COLORS.success,
        title: 'Banner updated',
        description: 'This image will appear on every welcome message.',
      }).setImage(url),
    ],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// autorole
// ---------------------------------------------------------------------------

async function runAutorole(ctx) {
  const db = require('../../db');

  if (!ctx.guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return ctx.error('Missing permission', 'I need **Manage Roles** to hand out an autorole.');
  }

  const raw = ctx.get('role');

  if (!raw) {
    await db.setGuildConfig(ctx.guildId, { autorole_id: null });
    return ctx.reply({
      embeds: [embeds.success('Autorole disabled', 'New members will not automatically receive a role.')],
      ephemeral: true,
    });
  }

  const role = asRole(ctx, 'role');
  if (!role) return ctx.error('Role not found', 'I could not find that role.');

  if (!role.editable) {
    return ctx.error(
      'Role is too high',
      `**${role.name}** sits above my highest role, so I cannot assign it. Move my role above it and try again.`,
    );
  }

  if (role.managed) {
    return ctx.error('Managed role', 'That role is managed by an integration and cannot be assigned manually.');
  }

  await db.setGuildConfig(ctx.guildId, { autorole_id: role.id });

  return ctx.reply({
    embeds: [
      embeds.success('Autorole set', `New members will automatically receive <@&${role.id}>.`),
    ],
    ephemeral: true,
  });
}

module.exports = welcome;
