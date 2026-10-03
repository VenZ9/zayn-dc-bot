'use strict';

/**
 * Module 10b - Autoresponders.
 *
 *   /autoresponder add | remove | list | toggle | test
 *
 * Replies are sent by the custom engine, which the message handler calls for
 * every message. This command only manages the rules.
 */

const { defineCommand } = require('../../core/command');
const helpers = require('../../lib/helpers');
const embeds = require('../../lib/embeds');
const config = require('../../config');
const { COLORS } = require('../../lib/constants');
const service = require('./autoresponder-service');

const MATCH_CHOICES = [
  { name: 'Contains', value: 'contains' },
  { name: 'Exact', value: 'exact' },
  { name: 'Starts with', value: 'startswith' },
  { name: 'Regex', value: 'regex' },
];

const autoresponder = defineCommand({
  name: 'autoresponder',
  description: 'Reply automatically to phrases',
  module: 'custom',
  node: 'custom.autoresponder',
  aliases: ['autorespond', 'ar'],
  cooldown: 3,
  subcommands: [
    {
      name: 'add',
      description: 'Create an autoresponder',
      args: [
        { name: 'trigger', type: 'string', required: true, description: 'The phrase to react to', maxLength: 200 },
        { name: 'response', type: 'string', required: true, description: 'The reply. Use \\n for line breaks', maxLength: 1500 },
        {
          name: 'match',
          type: 'string',
          required: false,
          description: 'How to match (default: contains)',
          choices: MATCH_CHOICES,
        },
        { name: 'wildcard', type: 'boolean', required: false, description: 'Ignore case and allow * as a wildcard' },
      ],
    },
    {
      name: 'remove',
      description: 'Delete an autoresponder',
      args: [
        { name: 'trigger', type: 'string', required: true, description: 'The phrase the responder reacts to', maxLength: 200 },
      ],
    },
    { name: 'list', description: 'List this server\'s autoresponders' },
    {
      name: 'toggle',
      description: 'Turn an autoresponder on or off',
      args: [
        { name: 'trigger', type: 'string', required: true, description: 'The phrase to toggle', maxLength: 200 },
        { name: 'enabled', type: 'boolean', required: false, description: 'On or off (default: flip it)' },
      ],
    },
    {
      name: 'test',
      description: 'Check whether a phrase would trigger anything',
      args: [
        { name: 'text', type: 'string', required: true, description: 'The message to test', maxLength: 500 },
      ],
    },
  ],

  async run(ctx) {
    const sub = ctx.subcommand?.name ?? 'list';

    const check = ctx.hasPermission('custom.autoresponder');
    if (!check.ok) return ctx.deny(check.reason);

    switch (sub) {
      case 'add': return runAdd(ctx);
      case 'remove': return runRemove(ctx);
      case 'list': return runList(ctx);
      case 'toggle': return runToggle(ctx);
      case 'test': return runTest(ctx);
      default: return ctx.error('Unknown option', `\`${sub}\` is not available.`);
    }
  },
});

// ---------------------------------------------------------------------------

async function runAdd(ctx) {
  const trigger = ctx.get('trigger');
  const response = ctx.get('response');
  if (!trigger) return ctx.error('No trigger given', 'What phrase should I react to?');
  if (!response) return ctx.error('No response given', 'What should I reply?');

  const existing = await service.find(ctx.guildId, trigger);
  if (existing) {
    return ctx.error(
      'Already exists',
      `An autoresponder for \`${helpers.truncate(trigger, 60)}\` already exists. Remove it first.`,
    );
  }

  const result = await service.create(ctx.guildId, trigger, response, {
    matchType: ctx.get('match') || 'contains',
    wildcard: ctx.get('wildcard') === true,
    createdBy: ctx.userId,
  });

  if (!result.ok) return ctx.error('Could not create it', result.error);

  return ctx.reply({
    embeds: [
      embeds.success(
        'Autoresponder created',
        [
          `**Trigger:** \`${helpers.truncate(trigger, 80)}\``,
          `**Match:** ${result.autoresponder.match_type}${result.autoresponder.wildcard ? ' (wildcard)' : ''}`,
          `**Reply:** ${helpers.truncate(String(response).replace(/\\n/g, ' '), 400)}`,
        ].join('\n'),
      ),
    ],
    ephemeral: true,
  });
}

async function runRemove(ctx) {
  const trigger = ctx.get('trigger');
  const existing = await service.find(ctx.guildId, trigger);

  if (!existing) {
    return ctx.error('Not found', `No autoresponder matches \`${helpers.truncate(trigger, 60)}\`.`);
  }

  await service.remove(ctx.guildId, existing.id);

  return ctx.reply({
    embeds: [embeds.success('Autoresponder deleted', `\`${helpers.truncate(trigger, 80)}\` will no longer reply.`)],
    ephemeral: true,
  });
}

async function runList(ctx) {
  const rows = await service.list(ctx.guildId);

  if (rows.length === 0) {
    return ctx.reply({
      embeds: [embeds.info('No autoresponders', `Create one with \`/autoresponder add\`.`)],
    });
  }

  const embed = embeds.embed({ color: COLORS.brand, title: `🔁 Autoresponders (${rows.length})` });

  for (const row of rows.slice(0, 20)) {
    embed.addFields({
      name: `${row.enabled === false ? '🔴' : '🟢'} ${helpers.truncate(row.trigger, 80)}`,
      value: [
        `${helpers.truncate(String(row.response).replace(/\n/g, ' '), 160)}`,
        `Match: \`${row.match_type}\`${row.wildcard ? ' • wildcard' : ''} • Uses: **${helpers.formatNumber(row.uses ?? 0)}**`,
      ].join('\n'),
    });
  }

  embed.setFooter({ text: config.brandFooterText });
  return ctx.reply({ embeds: [embed] });
}

async function runToggle(ctx) {
  const trigger = ctx.get('trigger');
  const existing = await service.find(ctx.guildId, trigger);

  if (!existing) {
    return ctx.error('Not found', `No autoresponder matches \`${helpers.truncate(trigger, 60)}\`.`);
  }

  const explicit = ctx.get('enabled');
  const next = typeof explicit === 'boolean' ? explicit : existing.enabled === false;

  await service.setEnabled(ctx.guildId, existing.id, next);

  return ctx.reply({
    embeds: [
      embeds.success(
        `Autoresponder ${next ? 'enabled' : 'disabled'}`,
        `\`${helpers.truncate(trigger, 80)}\` is now ${next ? 'active' : 'inactive'}.`,
      ),
    ],
    ephemeral: true,
  });
}

async function runTest(ctx) {
  const text = ctx.get('text');
  if (!text) return ctx.error('Nothing to test', 'Give a phrase to test.');

  const rows = await service.list(ctx.guildId);
  const hits = rows.filter((row) => row.enabled !== false && service.matches(row, text));

  if (hits.length === 0) {
    return ctx.reply({
      embeds: [embeds.info('No match', `\`${helpers.truncate(text, 200)}\` would not trigger any autoresponder.`)],
      ephemeral: true,
    });
  }

  const embed = embeds.embed({
    color: COLORS.success,
    title: `✅ ${hits.length} match${hits.length === 1 ? '' : 'es'}`,
    description: hits.slice(0, 5).map((row) => `**${helpers.truncate(row.trigger, 60)}** → ${helpers.truncate(String(row.response).replace(/\n/g, ' '), 120)}`).join('\n'),
  });

  return ctx.reply({ embeds: [embed], ephemeral: true });
}

module.exports = autoresponder;
