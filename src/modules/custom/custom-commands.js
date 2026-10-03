'use strict';

/**
 * Module 10a - Custom Commands.
 *
 *   /customcmd add | edit | remove | list | show | test
 *
 * Triggers are stored in `custom_commands`. The custom engine — called by the
 * message handler — answers them, so this command only manages the rules.
 */

const { defineCommand } = require('../../core/command');
const helpers = require('../../lib/helpers');
const embeds = require('../../lib/embeds');
const config = require('../../config');
const { COLORS } = require('../../lib/constants');
const service = require('./custom-command-service');

const customcmd = defineCommand({
  name: 'customcmd',
  description: 'Create your own commands with template responses',
  module: 'custom',
  node: 'custom.add',
  aliases: ['cc', 'customcommand', 'tag'],
  cooldown: 3,
  subcommands: [
    {
      name: 'add',
      description: 'Create a custom command',
      args: [
        { name: 'trigger', type: 'string', required: true, description: 'The word that fires it, e.g. rules', maxLength: 32 },
        { name: 'response', type: 'string', required: true, description: 'The reply. Use \\n for line breaks', maxLength: 2000 },
        { name: 'embed', type: 'boolean', required: false, description: 'Send the reply as an embed' },
      ],
    },
    {
      name: 'edit',
      description: 'Change an existing custom command',
      args: [
        { name: 'trigger', type: 'string', required: true, description: 'The trigger to edit', maxLength: 32 },
        { name: 'response', type: 'string', required: true, description: 'The new reply', maxLength: 2000 },
      ],
    },
    {
      name: 'remove',
      description: 'Delete a custom command',
      args: [
        { name: 'trigger', type: 'string', required: true, description: 'The trigger to delete', maxLength: 32 },
      ],
    },
    { name: 'list', description: 'List this server\'s custom commands' },
    {
      name: 'show',
      description: 'Show a custom command and its response',
      args: [
        { name: 'trigger', type: 'string', required: true, description: 'The trigger to inspect', maxLength: 32 },
      ],
    },
    {
      name: 'test',
      description: 'Preview a custom command exactly as it would be sent',
      args: [
        { name: 'trigger', type: 'string', required: true, description: 'The trigger to preview', maxLength: 32 },
        { name: 'args', type: 'string', required: false, description: 'Arguments to substitute', maxLength: 300 },
      ],
    },
  ],

  async run(ctx) {
    const sub = ctx.subcommand?.name ?? 'list';

    const nodeMap = {
      add: 'custom.add',
      edit: 'custom.edit',
      remove: 'custom.delete',
      list: 'custom.list',
      show: 'custom.info',
      test: 'custom.info',
    };

    const check = ctx.hasPermission(nodeMap[sub] ?? 'custom.list');
    if (!check.ok) return ctx.deny(check.reason);

    switch (sub) {
      case 'add': return runAdd(ctx);
      case 'edit': return runEdit(ctx);
      case 'remove': return runRemove(ctx);
      case 'list': return runList(ctx);
      case 'show': return runShow(ctx);
      case 'test': return runTest(ctx);
      default: return ctx.error('Unknown option', `\`${sub}\` is not available.`);
    }
  },
});

// ---------------------------------------------------------------------------
// add / edit
// ---------------------------------------------------------------------------

async function runAdd(ctx) {
  const trigger = ctx.get('trigger');
  const response = ctx.get('response');

  if (!trigger) return ctx.error('No trigger given', 'What word should fire this command?');
  if (!response) return ctx.error('No response given', 'What should I reply with?');

  const key = service.normaliseName(trigger);
  const validation = service.validateName(key);
  if (validation) return ctx.error('Invalid trigger', validation);

  // Refuse to shadow a real command.
  const registry = ctx.client?.commands;
  if (registry && typeof registry.has === 'function' && registry.has(key)) {
    return ctx.error('Trigger already in use', `\`${key}\` is a built-in command. Pick a different trigger.`);
  }

  const existing = await service.match(ctx.guildId, key);
  if (existing) {
    return ctx.error(
      'Trigger already exists',
      `\`${key}\` is already defined. Use \`/customcmd edit\` to change it, or remove it first.`,
    );
  }

  const result = await service.save(ctx.guildId, key, response, {
    embed: ctx.get('embed') === true,
    createdBy: ctx.userId,
  });

  if (!result.ok) return ctx.error('Could not create it', result.error);

  const preview = service.buildResponse(response, {
    userId: ctx.userId,
    username: ctx.user.tag ?? ctx.user.username,
    guildName: ctx.guild.name,
    channelId: ctx.channelId,
    memberCount: ctx.guild.memberCount,
    args: '',
  });

  return ctx.reply({
    embeds: [
      embeds.success(
        'Custom command created',
        [
          `Trigger: \`${key}\``,
          `Call it with \`${ctx.prefix}${key}\``,
          '',
          '**Preview**',
          helpers.truncate(preview, 800),
        ].join('\n'),
      ),
    ],
    ephemeral: true,
  });
}

async function runEdit(ctx) {
  const trigger = ctx.get('trigger');
  const response = ctx.get('response');
  if (!response) return ctx.error('No response given', 'Provide the new reply.');

  const key = service.normaliseName(trigger);
  const existing = await service.match(ctx.guildId, key);

  if (!existing) {
    return ctx.error('Trigger not found', `\`${key}\` is not defined. Use \`/customcmd add\` to create it.`);
  }

  const result = await service.save(ctx.guildId, key, response, {
    embed: existing.embed === true,
    createdBy: existing.created_by ?? ctx.userId,
  });

  if (!result.ok) return ctx.error('Could not update it', result.error);

  return ctx.reply({
    embeds: [embeds.success('Custom command updated', `\`${key}\` now replies differently.`)],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

async function runRemove(ctx) {
  const key = service.normaliseName(ctx.get('trigger'));

  const existing = await service.match(ctx.guildId, key);
  if (!existing) return ctx.error('Trigger not found', `\`${key}\` is not defined.`);

  const confirmed = await ctx.confirm({
    title: `Delete \`${key}\`?`,
    body: 'This custom command will stop responding.',
    confirmLabel: 'Delete it',
  });
  if (!confirmed) return;

  await service.remove(ctx.guildId, key);

  return ctx.reply({
    embeds: [embeds.success('Custom command deleted', `\`${key}\` no longer exists.`)],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// list / show / test
// ---------------------------------------------------------------------------

async function runList(ctx) {
  const rows = await service.list(ctx.guildId);

  if (rows.length === 0) {
    return ctx.reply({
      embeds: [
        embeds.info(
          'No custom commands yet',
          `Create one with \`/customcmd add\`.\n\nAvailable variables:\n${service.VARIABLES.join(' ')}`,
        ),
      ],
    });
  }

  const lines = helpers.chunk(
    rows.map((row) => `\`${ctx.prefix}${row.name}\`${row.embed ? ' *(embed)*' : ''} — ${String(row.response).replace(/\n/g, ' ').slice(0, 80)}`),
    3800,
  );

  const embed = embeds.embed({
    color: COLORS.brand,
    title: `💬 Custom commands (${rows.length})`,
    description: lines[0],
  });

  if (lines.length > 1) embed.addFields({ name: 'More', value: lines[1] });

  embed.setFooter({ text: `Variables: ${service.VARIABLES.join(' ')} • ${config.brandFooterText}` });
  return ctx.reply({ embeds: [embed] });
}

async function runShow(ctx) {
  const key = service.normaliseName(ctx.get('trigger'));
  const row = await service.match(ctx.guildId, key);

  if (!row) return ctx.error('Trigger not found', `\`${key}\` is not defined.`);

  const embed = embeds.embed({
    color: COLORS.brand,
    title: `\`${ctx.prefix}${row.name}\``,
    description: helpers.truncate(String(row.response).replace(/\\n/g, '\n'), 2000),
  });

  embed.addFields(
    { name: 'Embed', value: row.embed ? 'Yes' : 'No', inline: true },
    { name: 'Enabled', value: row.enabled === false ? 'No' : 'Yes', inline: true },
    { name: 'Uses', value: helpers.formatNumber(row.uses ?? 0), inline: true },
    { name: 'Cooldown', value: `${helpers.formatNumber(row.cooldown ?? 0)}s`, inline: true },
  );

  if (row.created_by) {
    embed.addFields({ name: 'Created by', value: `<@${row.created_by}>`, inline: true });
  }

  return ctx.reply({ embeds: [embed] });
}

async function runTest(ctx) {
  const key = service.normaliseName(ctx.get('trigger'));
  const row = await service.match(ctx.guildId, key);

  if (!row) return ctx.error('Trigger not found', `\`${key}\` is not defined.`);

  const response = service.buildResponse(row.response, {
    userId: ctx.userId,
    username: ctx.user.tag ?? ctx.user.username,
    guildName: ctx.guild.name,
    channelId: ctx.channelId,
    memberCount: ctx.guild.memberCount,
    args: ctx.get('args') ?? '',
  });

  if (row.embed) {
    return ctx.reply({
      embeds: [
        embeds.embed({ color: COLORS.brand, description: helpers.truncate(response, 4000) })
          .setFooter({ text: `Preview of ${ctx.prefix}${key} • ${config.brandFooterText}` }),
      ],
      ephemeral: true,
    });
  }

  return ctx.reply({
    content: helpers.truncate(response, 2000),
    embeds: [embeds.info('Preview', `This is how \`${ctx.prefix}${key}\` will respond.`)],
    ephemeral: true,
  });
}

module.exports = customcmd;
