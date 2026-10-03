'use strict';

/**
 * Module 7 - Giveaways.
 *
 *   /giveaway start | end | reroll | cancel | list | edit | requirements | pause
 *
 * The entry button is handled here under the `gw:` prefix. Giveaways are also
 * closed automatically by the scheduler via `giveaway-service.due()`.
 */

const { PermissionFlagsBits } = require('discord.js');
const { defineCommand } = require('../../core/command');
const helpers = require('../../lib/helpers');
const embeds = require('../../lib/embeds');
const ui = require('../../lib/ui');
const config = require('../../config');
const { COLORS } = require('../../lib/constants');
const service = require('./giveaway-service');

// ---------------------------------------------------------------------------
// Component handlers
// ---------------------------------------------------------------------------

const components = {
  /** Entry button. */
  [`${service.ENTER_PREFIX.slice(0, -1)}`]: async (interaction) => {
    // customId is `gw:enter:<giveawayId>`; the router matches on the `gw:enter`
    // prefix, so the id is the last segment.
    const giveawayId = interaction.customId.split(':')[2];
    const db = require('../../db');

    const giveaway = await db.selectOne('giveaways', { where: { id: giveawayId }, optional: true });
    if (!giveaway) {
      return interaction.reply({
        embeds: [embeds.error('Not found', 'That giveaway no longer exists.')],
        ephemeral: true,
      });
    }

    if (giveaway.status !== 'running') {
      return interaction.reply({
        embeds: [embeds.warning('Entries closed', 'This giveaway is no longer accepting entries.')],
        ephemeral: true,
      });
    }

    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) {
      return interaction.reply({
        embeds: [embeds.error('Not a member', 'I could not resolve your membership.')],
        ephemeral: true,
      });
    }

    const result = await service.enter(giveawayId, member, giveaway);

    if (!result.ok) {
      return interaction.reply({
        embeds: [embeds.error('You cannot enter', result.reason)],
        ephemeral: true,
      });
    }

    const total = await service.entryCount(giveawayId);

    if (!result.created) {
      return interaction.reply({
        embeds: [
          embeds.info(
            'Already entered',
            `You are already in this giveaway. Good luck!\n**${helpers.formatNumber(total)}** entr${total === 1 ? 'y' : 'ies'} so far.`,
          ),
        ],
        ephemeral: true,
      });
    }

    return interaction.reply({
      embeds: [
        embeds.success(
          'You are in! 🎉',
          [
            `You entered the giveaway for **${helpers.truncate(giveaway.prize, 150)}**.`,
            result.bonus ? `Including **${result.bonus}** bonus entr${result.bonus === 1 ? 'y' : 'ies'} from your roles.` : null,
            `**${helpers.formatNumber(total)}** entr${total === 1 ? 'y' : 'ies'} so far.`,
          ].filter(Boolean).join('\n'),
        ),
      ],
      ephemeral: true,
    });
  },
};

// ---------------------------------------------------------------------------
// /giveaway
// ---------------------------------------------------------------------------

const giveaway = defineCommand({
  name: 'giveaway',
  description: 'Host and manage giveaways',
  module: 'giveaways',
  node: 'giveaways.start',
  aliases: ['gw', 'gway'],
  cooldown: 3,
  components,
  subcommands: [
    {
      name: 'start',
      description: 'Start a giveaway',
      args: [
        { name: 'prize', type: 'string', required: true, description: 'What are you giving away?', maxLength: 200 },
        { name: 'duration', type: 'string', required: true, description: 'How long, e.g. 1h, 1d, 30m', maxLength: 20 },
        { name: 'winners', type: 'integer', required: false, description: 'How many winners (default 1)', min: 1, max: 50 },
        { name: 'channel', type: 'channel', required: false, description: 'Where to host it (default: here)' },
        { name: 'description', type: 'string', required: false, description: 'Extra details', maxLength: 1000 },
      ],
    },
    {
      name: 'end',
      description: 'End a giveaway early and draw winners',
      args: [
        { name: 'message_id', type: 'string', required: true, description: 'The message ID of the giveaway', maxLength: 30 },
      ],
    },
    {
      name: 'reroll',
      description: 'Draw new winners for an ended giveaway',
      args: [
        { name: 'message_id', type: 'string', required: true, description: 'The message ID of the giveaway', maxLength: 30 },
      ],
    },
    {
      name: 'cancel',
      description: 'Cancel a giveaway without drawing winners',
      args: [
        { name: 'message_id', type: 'string', required: true, description: 'The message ID of the giveaway', maxLength: 30 },
      ],
    },
    {
      name: 'list',
      description: 'List this server\'s giveaways',
      args: [
        {
          name: 'status',
          type: 'string',
          required: false,
          description: 'Filter by status',
          choices: [
            { name: 'Running', value: 'running' },
            { name: 'Ended', value: 'ended' },
            { name: 'Paused', value: 'paused' },
            { name: 'Cancelled', value: 'cancelled' },
          ],
        },
      ],
    },
    {
      name: 'edit',
      description: 'Edit a running giveaway',
      args: [
        { name: 'message_id', type: 'string', required: true, description: 'The message ID of the giveaway', maxLength: 30 },
        { name: 'prize', type: 'string', required: false, description: 'New prize', maxLength: 200 },
        { name: 'winners', type: 'integer', required: false, description: 'New winner count', min: 1, max: 50 },
        { name: 'duration', type: 'string', required: false, description: 'Extend by, e.g. 1h', maxLength: 20 },
      ],
    },
    {
      name: 'requirements',
      description: 'Set entry requirements on a running giveaway',
      args: [
        { name: 'message_id', type: 'string', required: true, description: 'The message ID of the giveaway', maxLength: 30 },
        { name: 'role', type: 'role', required: false, description: 'Required role' },
        { name: 'level', type: 'integer', required: false, description: 'Required level', min: 0, max: 1000 },
        { name: 'messages', type: 'integer', required: false, description: 'Required message count', min: 0, max: 1000000 },
      ],
    },
    {
      name: 'pause',
      description: 'Pause or resume a giveaway',
      args: [
        { name: 'message_id', type: 'string', required: true, description: 'The message ID of the giveaway', maxLength: 30 },
        { name: 'paused', type: 'boolean', required: true, description: 'True to pause, false to resume' },
      ],
    },
  ],

  async run(ctx) {
    const sub = ctx.subcommand?.name ?? null;
    if (!sub) {
      return ctx.reply({
        embeds: [
          embeds.info(
            'Giveaways',
            [
              `\`${ctx.prefix}giveaway start <prize> <duration> [winners]\``,
              `\`${ctx.prefix}giveaway end <message_id>\``,
              `\`${ctx.prefix}giveaway reroll <message_id>\``,
              `\`${ctx.prefix}giveaway cancel <message_id>\``,
              `\`${ctx.prefix}giveaway list [status]\``,
              `\`${ctx.prefix}giveaway edit <message_id> [prize] [winners] [duration]\``,
              `\`${ctx.prefix}giveaway requirements <message_id> [role] [level] [messages]\``,
              `\`${ctx.prefix}giveaway pause <message_id> <true|false>\``,
            ].join('\n'),
          ),
        ],
      });
    }

    switch (sub) {
      case 'start': return runWithPerm(ctx, 'giveaways.start', () => runStart(ctx));
      case 'end': return runWithPerm(ctx, 'giveaways.end', () => runEnd(ctx));
      case 'reroll': return runWithPerm(ctx, 'giveaways.reroll', () => runReroll(ctx));
      case 'cancel': return runWithPerm(ctx, 'giveaways.cancel', () => runCancel(ctx));
      case 'list': return runWithPerm(ctx, 'giveaways.list', () => runList(ctx));
      case 'edit': return runWithPerm(ctx, 'giveaways.edit', () => runEdit(ctx));
      case 'requirements': return runWithPerm(ctx, 'giveaways.requirements', () => runRequirements(ctx));
      case 'pause': return runWithPerm(ctx, 'giveaways.pause', () => runPause(ctx));
      default: return ctx.error('Unknown option', `\`${sub}\` is not available.`);
    }
  },
});

/** Gate a handler behind a node. */
function runWithPerm(ctx, node, handler) {
  const check = ctx.hasPermission(node);
  if (!check.ok) return ctx.deny(check.reason);
  return handler();
}

/** Resolve an argument to a channel. */
function asChannel(ctx, name) {
  const raw = ctx.get(name);
  if (!raw) return null;
  if (typeof raw === 'object' && raw.id) return raw;
  const id = helpers.extractId(String(raw));
  return id ? (ctx.guild.channels.cache.get(id) ?? null) : null;
}

/** Resolve an argument to a role. */
function asRole(ctx, name) {
  const raw = ctx.get(name);
  if (!raw) return null;
  if (typeof raw === 'object' && raw.id) return raw;
  const id = helpers.extractId(String(raw));
  if (id) return ctx.guild.roles.cache.get(id) ?? null;
  const lowered = String(raw).toLowerCase().replace(/^@/, '');
  return ctx.guild.roles.cache.find((role) => role.name.toLowerCase() === lowered) ?? null;
}

/** Find a giveaway by its announcement message id. */
async function byMessage(ctx, messageId) {
  const db = require('../../db');
  const id = helpers.extractId(String(messageId)) ?? String(messageId).trim();
  return db.selectOne('giveaways', { where: { guild_id: ctx.guildId, message_id: id }, optional: true });
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function runStart(ctx) {
  const prize = ctx.get('prize');
  if (!prize) return ctx.error('No prize given', 'What are you giving away?');

  const durationText = ctx.get('duration');
  const seconds = helpers.parseDuration(durationText);
  if (!seconds) {
    return ctx.error('Invalid duration', 'Use a value like `30m`, `2h` or `1d`.');
  }
  if (seconds < 60) {
    return ctx.error('Too short', 'A giveaway must run for at least one minute.');
  }

  const winnersCount = helpers.clamp(Number.parseInt(ctx.get('winners'), 10) || 1, 1, 50);
  const channel = asChannel(ctx, 'channel') ?? ctx.channel;

  if (!channel.isTextBased()) {
    return ctx.error('Invalid channel', 'Choose a text channel for the giveaway.');
  }

  const endsAt = new Date(Date.now() + seconds * 1000);
  const db = require('../../db');

  // Insert first with a null message id, so a send failure leaves no orphan.
  let giveaway = await db.insert('giveaways', {
    guild_id: ctx.guildId,
    channel_id: channel.id,
    host_id: ctx.userId,
    prize: String(prize).slice(0, 200),
    description: ctx.get('description') ?? null,
    winners_count: winnersCount,
    status: 'running',
    ends_at: endsAt.toISOString(),
    bonus_entries: {},
  });

  const entries = await service.entryCount(giveaway.id);
  const embed = service.render(giveaway, entries);
  const row = service.controls(giveaway);

  const message = await channel.send({ embeds: [embed], components: [row] }).catch((error) => {
    ctx.log.error('giveaway announcement failed:', error);
    return null;
  });

  if (!message) {
    await db.update('giveaways', { id: giveaway.id }, { status: 'cancelled' }).catch(() => {});
    return ctx.error('Could not post the giveaway', `I cannot send messages in <#${channel.id}>.`);
  }

  giveaway = await db.update('giveaways', { id: giveaway.id }, { message_id: message.id })
    .then((rows) => rows[0] ?? giveaway).catch(() => giveaway);

  const confirmation = embeds.success(
    'Giveaway started 🎉',
    [
      `Prize: **${helpers.truncate(prize, 150)}**`,
      `Channel: <#${channel.id}>`,
      `Ends: ${helpers.timestamp(endsAt, 'R')}`,
      `Winners: **${winnersCount}**`,
      `Message ID: \`${message.id}\``,
    ].join('\n'),
  );

  return ctx.reply({ embeds: [confirmation], ephemeral: true });
}

// ---------------------------------------------------------------------------
// end / reroll / cancel
// ---------------------------------------------------------------------------

async function runEnd(ctx) {
  const giveawayRow = await byMessage(ctx, ctx.get('message_id'));
  if (!giveawayRow) return ctx.error('Giveaway not found', 'No giveaway matches that message ID in this server.');

  await ctx.defer({ ephemeral: true });
  const result = await service.end(ctx.client, giveawayRow.id, { endedBy: ctx.user });

  if (!result.ok) return ctx.editReply({ embeds: [embeds.error('Could not end it', result.error)] });

  return ctx.editReply({
    embeds: [
      embeds.success(
        'Giveaway ended',
        result.winners.length > 0
          ? `Winners: ${result.winners.map((id) => `<@${id}>`).join(', ')}`
          : 'Nobody entered, so there are no winners.',
      ),
    ],
  });
}

async function runReroll(ctx) {
  const giveawayRow = await byMessage(ctx, ctx.get('message_id'));
  if (!giveawayRow) return ctx.error('Giveaway not found', 'No giveaway matches that message ID in this server.');

  await ctx.defer({ ephemeral: true });
  const result = await service.end(ctx.client, giveawayRow.id, { reroll: true, endedBy: ctx.user });

  if (!result.ok) return ctx.editReply({ embeds: [embeds.error('Could not reroll', result.error)] });

  return ctx.editReply({
    embeds: [
      embeds.success(
        'Giveaway rerolled',
        result.winners.length > 0
          ? `New winners: ${result.winners.map((id) => `<@${id}>`).join(', ')}`
          : 'There were no eligible entrants to draw from.',
      ),
    ],
  });
}

async function runCancel(ctx) {
  const giveawayRow = await byMessage(ctx, ctx.get('message_id'));
  if (!giveawayRow) return ctx.error('Giveaway not found', 'No giveaway matches that message ID in this server.');

  const result = await service.cancel(ctx.client, giveawayRow.id, ctx.user);
  if (!result.ok) return ctx.error('Could not cancel', result.error);

  return ctx.reply({
    embeds: [embeds.success('Giveaway cancelled', `**${helpers.truncate(giveawayRow.prize, 150)}** was cancelled.`)],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function runList(ctx) {
  const status = ctx.get('status') ?? null;
  const rows = await service.list(ctx.guildId, { status, limit: 20 });

  if (rows.length === 0) {
    return ctx.reply({
      embeds: [embeds.info('No giveaways', status ? `There are no **${status}** giveaways.` : 'No giveaways have been hosted yet.')],
    });
  }

  const statusEmoji = { running: '🟢', paused: '⏸️', ended: '🔒', cancelled: '❌' };

  const embed = embeds.embed({
    color: COLORS.brand,
    title: `🎉 Giveaways (${rows.length})`,
  });

  for (const row of rows) {
    const entries = await service.entryCount(row.id);
    const when = row.status === 'running'
      ? `Ends ${helpers.timestamp(new Date(row.ends_at), 'R')}`
      : (row.ended_at ? `Ended ${helpers.timestamp(new Date(row.ended_at), 'R')}` : 'Ended');

    embed.addFields({
      name: `${statusEmoji[row.status] ?? '❔'} ${helpers.truncate(row.prize, 70)}`,
      value: [
        `Host: <@${row.host_id}>`,
        `Entries: **${helpers.formatNumber(entries)}** • Winners: **${row.winners_count}**`,
        when,
        `ID: \`${row.message_id ?? row.id}\``,
      ].join('\n'),
    });
  }

  embed.setFooter({ text: config.brandFooterText });

  return ctx.reply({ embeds: [embed] });
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

async function runEdit(ctx) {
  const giveawayRow = await byMessage(ctx, ctx.get('message_id'));
  if (!giveawayRow) return ctx.error('Giveaway not found', 'No giveaway matches that message ID in this server.');

  if (giveawayRow.status !== 'running' && giveawayRow.status !== 'paused') {
    return ctx.error('Already finished', 'Only running or paused giveaways can be edited.');
  }

  const patch = {};

  const prize = ctx.get('prize');
  if (prize) patch.prize = String(prize).slice(0, 200);

  const winners = Number.parseInt(ctx.get('winners'), 10);
  if (Number.isFinite(winners)) patch.winners_count = helpers.clamp(winners, 1, 50);

  const durationText = ctx.get('duration');
  if (durationText) {
    const extra = helpers.parseDuration(durationText);
    if (!extra) return ctx.error('Invalid duration', 'Use a value like `30m`, `2h` or `1d`.');
    patch.ends_at = new Date(new Date(giveawayRow.ends_at).getTime() + extra * 1000).toISOString();
  }

  if (Object.keys(patch).length === 0) {
    return ctx.error('Nothing to change', 'Give at least one of `prize`, `winners` or `duration`.');
  }

  const db = require('../../db');
  const updated = await db.update('giveaways', { id: giveawayRow.id }, patch);
  const merged = { ...giveawayRow, ...(updated[0] ?? patch) };

  // Refresh the announcement.
  const channel = await ctx.client.channels.fetch(merged.channel_id).catch(() => null);
  const entries = await service.entryCount(merged.id);

  if (channel && merged.message_id) {
    const message = await channel.messages.fetch(merged.message_id).catch(() => null);
    if (message) {
      await message.edit({
        embeds: [service.render(merged, entries)],
        components: [service.controls(merged)],
      }).catch(() => {});
    }
  }

  return ctx.reply({
    embeds: [
      embeds.success('Giveaway updated', [
        patch.prize ? `Prize: **${helpers.truncate(patch.prize, 150)}**` : null,
        patch.winners_count ? `Winners: **${patch.winners_count}**` : null,
        patch.ends_at ? `Now ends ${helpers.timestamp(new Date(patch.ends_at), 'R')}` : null,
      ].filter(Boolean).join('\n')),
    ],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// requirements
// ---------------------------------------------------------------------------

async function runRequirements(ctx) {
  const giveawayRow = await byMessage(ctx, ctx.get('message_id'));
  if (!giveawayRow) return ctx.error('Giveaway not found', 'No giveaway matches that message ID in this server.');

  const patch = {};

  const rawRole = ctx.get('role');
  if (rawRole) {
    const role = asRole(ctx, 'role');
    if (!role) return ctx.error('Role not found', 'I could not find that role.');
    patch.required_role = role.id;
  } else if (rawRole === null && ctx.isPrefix === false) {
    // Explicitly left blank on slash - leave unchanged.
  }

  const level = Number.parseInt(ctx.get('level'), 10);
  if (Number.isFinite(level)) patch.required_level = helpers.clamp(level, 0, 1000);

  const messages = Number.parseInt(ctx.get('messages'), 10);
  if (Number.isFinite(messages)) patch.required_messages = helpers.clamp(messages, 0, 1000000);

  if (Object.keys(patch).length === 0) {
    const current = [];
    if (giveawayRow.required_role) current.push(`Role: <@&${giveawayRow.required_role}>`);
    if (giveawayRow.required_level) current.push(`Level: **${giveawayRow.required_level}**`);
    if (giveawayRow.required_messages) current.push(`Messages: **${giveawayRow.required_messages}**`);

    return ctx.reply({
      embeds: [
        embeds.info(
          'Current requirements',
          current.length > 0 ? current.join('\n') : 'No requirements — anyone can enter.',
        ),
      ],
    });
  }

  const db = require('../../db');
  const updated = await db.update('giveaways', { id: giveawayRow.id }, patch);
  const merged = { ...giveawayRow, ...(updated[0] ?? patch) };

  const channel = await ctx.client.channels.fetch(merged.channel_id).catch(() => null);
  const entries = await service.entryCount(merged.id);

  if (channel && merged.message_id) {
    const message = await channel.messages.fetch(merged.message_id).catch(() => null);
    if (message) {
      await message.edit({
        embeds: [service.render(merged, entries)],
        components: [service.controls(merged)],
      }).catch(() => {});
    }
  }

  return ctx.reply({
    embeds: [embeds.success('Requirements updated', 'The announcement has been refreshed.')],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// pause
// ---------------------------------------------------------------------------

async function runPause(ctx) {
  const giveawayRow = await byMessage(ctx, ctx.get('message_id'));
  if (!giveawayRow) return ctx.error('Giveaway not found', 'No giveaway matches that message ID in this server.');

  const paused = ctx.get('paused');
  if (typeof paused !== 'boolean') return ctx.error('No value given', 'Pass `true` to pause or `false` to resume.');

  const result = await service.setPaused(giveawayRow.id, paused);
  if (!result.ok) return ctx.error('Could not update', 'That giveaway could not be changed.');

  const merged = { ...giveawayRow, ...(result.giveaway ?? {}) };
  const channel = await ctx.client.channels.fetch(merged.channel_id).catch(() => null);
  const entries = await service.entryCount(merged.id);

  if (channel && merged.message_id) {
    const message = await channel.messages.fetch(merged.message_id).catch(() => null);
    if (message) {
      await message.edit({
        embeds: [service.render(merged, entries)],
        components: [service.controls(merged)],
      }).catch(() => {});
    }
  }

  return ctx.reply({
    embeds: [
      embeds.success(
        paused ? 'Giveaway paused' : 'Giveaway resumed',
        paused ? 'Entries are closed until you resume it.' : 'Entries are open again.',
      ),
    ],
    ephemeral: true,
  });
}

module.exports = giveaway;

void ui;
void PermissionFlagsBits;
