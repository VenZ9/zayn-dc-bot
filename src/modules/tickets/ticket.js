'use strict';

/**
 * Module 3 - Ticket System.
 *
 *   /ticket setup category|staff
 *   /ticket panel | open | close | add | remove | rename | claim |
 *           transcript | priority | list | stats
 *
 * The button handlers live at the bottom of this file and are declared on the
 * command as `components`, so the router finds them by the `tk:` prefix.
 */

const {
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
} = require('discord.js');

const { defineCommand } = require('../../core/command');
const helpers = require('../../lib/helpers');
const embeds = require('../../lib/embeds');
const config = require('../../config');
const { COLORS } = require('../../lib/constants');
const service = require('./ticket-service');

/** Custom id prefix for every component in this module. */
const ID = 'tk';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Resolve an argument that should be a channel (slash object or prefix token). */
function asChannel(ctx, name) {
  const raw = ctx.get(name);
  if (!raw) return null;
  if (typeof raw === 'object' && raw.id) return raw;

  const id = helpers.extractId(String(raw));
  if (!id) return null;
  return ctx.guild.channels.cache.get(id) ?? null;
}

/** Resolve an argument that should be a role. */
function asRole(ctx, name) {
  const raw = ctx.get(name);
  if (!raw) return null;
  if (typeof raw === 'object' && raw.id) return raw;

  const id = helpers.extractId(String(raw));
  if (id) return ctx.guild.roles.cache.get(id) ?? null;

  const lowered = String(raw).toLowerCase().replace(/^@/, '');
  return ctx.guild.roles.cache.find((role) => role.name.toLowerCase() === lowered) ?? null;
}

/** Resolve an argument that should be a user. */
async function asUser(ctx, name) {
  const raw = ctx.get(name);
  if (!raw) return null;
  if (typeof raw === 'object' && raw.id) return raw.user ?? raw;

  const id = helpers.extractId(String(raw));
  if (!id) return null;
  return ctx.client.users.fetch(id).catch(() => null);
}

/** Is the invoking member staff (or the bot admin / owner)? */
function isStaff(ctx) {
  if (ctx.isAdmin()) return true;
  const member = ctx.member;
  if (!member) return false;
  return member.permissions.has(PermissionFlagsBits.ManageChannels);
}

/**
 * Reject ticket subcommands used outside a ticket channel.
 * @returns {Promise<object|null>} the ticket row, or null after replying
 */
async function requireTicketChannel(ctx) {
  const ticket = await service.findByChannel(ctx.channelId);
  if (!ticket) {
    await ctx.error(
      'Not a ticket channel',
      'Run this inside a ticket channel, or use `/ticket open` to start one.',
    );
    return null;
  }
  return ticket;
}

// ---------------------------------------------------------------------------
// Component handlers
// ---------------------------------------------------------------------------

const components = {
  /** Panel button - open a ticket for whoever pressed it. */
  [`${ID}:create`]: async (interaction) => {
    await interaction.deferReply({ ephemeral: true });

    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) {
      return interaction.editReply({
        embeds: [embeds.error('Not a member', 'I could not resolve your membership in this server.')],
      });
    }

    const result = await service.open(interaction.guild, member, {});

    if (!result.ok) {
      return interaction.editReply({
        embeds: [embeds.error('Could not open a ticket', result.error)],
      });
    }

    return interaction.editReply({
      embeds: [embeds.success('Ticket opened', `Your ticket is at <#${result.channel.id}>.`)],
    });
  },

  /** Close button inside a ticket channel. */
  [`${ID}:close`]: async (interaction) => {
    const ticketId = interaction.customId.split(':')[2];
    const ticket = await service.findById(ticketId);

    if (!ticket) {
      return interaction.reply({
        embeds: [embeds.error('Not found', 'That ticket no longer exists.')],
        ephemeral: true,
      });
    }

    const staff = interaction.member?.permissions?.has(PermissionFlagsBits.ManageChannels);
    const isOpener = ticket.opener_id === interaction.user.id;
    if (!isOpener && !staff) {
      return interaction.reply({
        embeds: [embeds.error('Not allowed', 'Only the ticket opener or staff can close this ticket.')],
        ephemeral: true,
      });
    }

    await interaction.reply({
      embeds: [embeds.warning('Closing…', 'Saving the transcript now.')],
      ephemeral: true,
    });

    await service.close(interaction.client, ticketId, {
      closedBy: interaction.user,
      reason: `Closed via button by ${interaction.user.tag ?? interaction.user.username}`,
    });
  },

  /** Claim button. */
  [`${ID}:claim`]: async (interaction) => {
    const ticketId = interaction.customId.split(':')[2];

    const staff = interaction.member?.permissions?.has(PermissionFlagsBits.ManageChannels);
    if (!staff) {
      return interaction.reply({
        embeds: [embeds.error('Not allowed', 'Only staff can claim tickets.')],
        ephemeral: true,
      });
    }

    const result = await service.claim(ticketId, interaction.user);
    if (!result.ok) {
      return interaction.reply({
        embeds: [embeds.error('Could not claim', result.error)],
        ephemeral: true,
      });
    }

    await interaction.reply({
      embeds: [embeds.success('Ticket claimed', `<@${interaction.user.id}> is handling this ticket.`)],
    });
  },

  /** Transcript button - delivers the file privately. */
  [`${ID}:transcript`]: async (interaction) => {
    const ticketId = interaction.customId.split(':')[2];

    await interaction.deferReply({ ephemeral: true });

    const ticket = await service.findById(ticketId);
    if (!ticket) {
      return interaction.editReply({ embeds: [embeds.error('Not found', 'That ticket no longer exists.')] });
    }

    const staff = interaction.member?.permissions?.has(PermissionFlagsBits.ManageChannels);
    if (!staff && ticket.opener_id !== interaction.user.id) {
      return interaction.editReply({
        embeds: [embeds.error('Not allowed', 'Only the opener or staff can read this transcript.')],
      });
    }

    let text = ticket.transcript;

    if (!text) {
      const channel = await interaction.client.channels.fetch(ticket.channel_id).catch(() => null);
      if (!channel) {
        return interaction.editReply({
          embeds: [embeds.error('No transcript', 'The channel is gone and no transcript was saved.')],
        });
      }

      const built = await service.buildTranscript(channel, ticket);
      text = built.text;
      await require('../../db')
        .update('tickets', { id: ticketId }, { transcript: text.slice(0, 200_000) })
        .catch(() => {});
    }

    const file = new AttachmentBuilder(Buffer.from(text, 'utf8'), {
      name: `ticket-${ticket.ticket_number}-transcript.txt`,
    });

    return interaction.editReply({
      embeds: [embeds.success('Transcript', `Ticket **#${ticket.ticket_number}**`)],
      files: [file],
    });
  },
};

// ---------------------------------------------------------------------------
// /ticket
// ---------------------------------------------------------------------------

const ticket = defineCommand({
  name: 'ticket',
  description: 'Support ticket system',
  module: 'tickets',
  node: 'tickets.open',
  aliases: ['tickets', 'support'],
  cooldown: 2,
  components,
  subcommands: [
    {
      name: 'setup',
      description: 'Configure the ticket system: category and staff roles',
      args: [
        { name: 'category', type: 'channel', required: false, description: 'Category to create tickets in' },
        { name: 'role', type: 'role', required: false, description: 'A staff role to add or remove' },
        {
          name: 'action',
          type: 'string',
          required: false,
          description: 'Whether to add or remove the staff role (default: add)',
          choices: [
            { name: 'Add', value: 'add' },
            { name: 'Remove', value: 'remove' },
          ],
        },
      ],
    },
    {
      name: 'panel',
      description: 'Post a ticket panel with an Open Ticket button',
      args: [
        { name: 'channel', type: 'channel', required: false, description: 'Where to post (defaults to here)' },
        { name: 'title', type: 'string', required: false, description: 'Panel title', maxLength: 200 },
        { name: 'description', type: 'string', required: false, description: 'Panel description', maxLength: 1500 },
        { name: 'button', type: 'string', required: false, description: 'Button label', maxLength: 60 },
      ],
    },
    {
      name: 'open',
      description: 'Open a new ticket',
      args: [
        { name: 'subject', type: 'string', required: false, description: 'What do you need help with?', maxLength: 300 },
      ],
    },
    { name: 'close', description: 'Close the current ticket' },
    { name: 'add', description: 'Add a member to this ticket', args: [{ name: 'user', type: 'user', required: true, description: 'Who to add' }] },
    { name: 'remove', description: 'Remove a member from this ticket', args: [{ name: 'user', type: 'user', required: true, description: 'Who to remove' }] },
    { name: 'rename', description: 'Rename this ticket channel', args: [{ name: 'name', type: 'string', required: true, description: 'The new name', maxLength: 80 }] },
    { name: 'claim', description: 'Claim this ticket as yours' },
    { name: 'transcript', description: 'Generate a transcript of this ticket' },
    {
      name: 'priority',
      description: 'Set the priority of this ticket',
      args: [
        {
          name: 'level',
          type: 'string',
          required: true,
          description: 'Priority level',
          choices: [
            { name: '🟢 Low', value: 'low' },
            { name: '🔵 Normal', value: 'normal' },
            { name: '🟠 High', value: 'high' },
            { name: '🔴 Urgent', value: 'urgent' },
          ],
        },
      ],
    },
    { name: 'list', description: 'List open tickets in this server' },
    {
      name: 'stats',
      description: 'Show ticket statistics',
      args: [
        { name: 'transcript', type: 'boolean', required: false, description: 'Include the full ticket list as a CSV file' },
      ],
    },
  ],

  async run(ctx) {
    const sub = ctx.subcommand?.name ?? null;

    if (!sub) {
      return ctx.reply({
        embeds: [
          embeds.info(
            'Ticket system',
            [
              'Use one of the subcommands:',
              `\`${ctx.prefix}ticket panel\` - post a panel with an Open button`,
              `\`${ctx.prefix}ticket open [subject]\` - open a ticket`,
              `\`${ctx.prefix}ticket close\` - close the current ticket`,
              `\`${ctx.prefix}ticket add <user>\` - add someone to the ticket`,
              `\`${ctx.prefix}ticket claim\` - claim the ticket`,
              `\`${ctx.prefix}ticket transcript\` - download a transcript`,
              `\`${ctx.prefix}ticket priority <level>\` - change priority`,
              `\`${ctx.prefix}ticket list\` - open tickets`,
              `\`${ctx.prefix}ticket stats\` - statistics`,
              `\`${ctx.prefix}ticket setup [category] [role] [action]\` - configure the ticket system`,
            ].join('\n'),
          ),
        ],
      });
    }

    if (sub === 'setup') return runSetup(ctx);

    switch (sub) {
      case 'panel': return runPanel(ctx);
      case 'open': return runOpen(ctx);
      case 'close': return runClose(ctx);
      case 'add': return runAdd(ctx);
      case 'remove': return runRemove(ctx);
      case 'rename': return runRename(ctx);
      case 'claim': return runClaim(ctx);
      case 'transcript': return runTranscript(ctx);
      case 'priority': return runPriority(ctx);
      case 'list': return runList(ctx);
      case 'stats': return runStats(ctx);
      default:
        return ctx.error('Unknown subcommand', `\`${sub}\` is not a ticket subcommand.`);
    }
  },
});

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

async function runSetup(ctx) {
  const check = ctx.hasPermission('tickets.setup');
  if (!check.ok) return ctx.deny(check.reason);

  const db = require('../../db');
  const previous = await service.latestPanel(ctx.guildId);

  const categoryArg = asChannel(ctx, 'category');
  const roleArg = asRole(ctx, 'role');

  // The setup subcommand edits whichever of the two settings was supplied.
  if (categoryArg) {
    const category = categoryArg;
    if (category.type !== 4) {
      return ctx.error('Not a category', 'Choose a **category**, not a text channel.');
    }

    if (previous) await db.update('ticket_panels', { id: previous.id }, { category_id: category.id });
    else {
      await db.insert('ticket_panels', {
        guild_id: ctx.guildId,
        channel_id: ctx.channelId,
        title: 'Support',
        description: 'Click the button below to open a ticket.',
        category_id: category.id,
        support_roles: [],
        created_by: ctx.userId,
      });
    }

    return ctx.reply({
      embeds: [embeds.success('Category set', `New tickets will be created in **${category.name}**.`)],
    });
  }

  if (roleArg) {
    const role = roleArg;

    const action = ctx.get('action') || 'add';
    const current = Array.isArray(previous?.support_roles) ? previous.support_roles : [];
    const next = action === 'add'
      ? [...new Set([...current, role.id])]
      : current.filter((id) => id !== role.id);

    if (previous) await db.update('ticket_panels', { id: previous.id }, { support_roles: next });
    else {
      await db.insert('ticket_panels', {
        guild_id: ctx.guildId,
        channel_id: ctx.channelId,
        title: 'Support',
        description: 'Click the button below to open a ticket.',
        support_roles: next,
        created_by: ctx.userId,
      });
    }

    return ctx.reply({
      embeds: [
        embeds.success(
          action === 'add' ? 'Staff role added' : 'Staff role removed',
          `${role.name} ${action === 'add' ? 'can now' : 'can no longer'} see tickets.\n\n`
          + `**Staff roles:** ${next.length > 0 ? next.map((id) => `<@&${id}>`).join(', ') : '*none*'}`,
        ),
      ],
    });
  }

  return ctx.error(
    'Nothing to configure',
    'Give either a `category` (where tickets are created) or a `role` (a staff role to add).',
  );
}

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------

async function runPanel(ctx) {
  const check = ctx.hasPermission('tickets.panel');
  if (!check.ok) return ctx.deny(check.reason);

  if (!ctx.guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return ctx.error('Missing permission', 'I need **Manage Channels** to create ticket channels.');
  }

  const channel = asChannel(ctx, 'channel') ?? ctx.channel;

  const title = ctx.get('title') || 'Support Tickets';
  const description = ctx.get('description')
    || 'Need help? Press the button below and a private channel will be created for you.';
  const buttonLabel = ctx.get('button') || 'Open Ticket';

  const db = require('../../db');
  const previous = await service.latestPanel(ctx.guildId);

  // Staff roles and category carry over from the previous panel, so
  // /ticket setup only has to be run once.
  const supportRoles = Array.isArray(previous?.support_roles) ? previous.support_roles : [];
  const categoryId = previous?.category_id ?? null;

  const embed = embeds.embed({ color: COLORS.brand, title, description });
  embed.addFields({
    name: 'What happens next',
    value: 'A private channel is created that only you and staff can see.',
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ID}:create`)
      .setLabel(buttonLabel.slice(0, 80))
      .setEmoji('🎫')
      .setStyle(ButtonStyle.Primary),
  );

  const message = await channel
    .send({ embeds: [embed], components: [row] })
    .catch((error) => {
      ctx.log.error('panel send failed:', error);
      return null;
    });

  if (!message) {
    return ctx.error('Could not post panel', `I cannot send messages in <#${channel.id}>.`);
  }

  await db.insert('ticket_panels', {
    guild_id: ctx.guildId,
    channel_id: channel.id,
    message_id: message.id,
    title,
    description,
    button_label: buttonLabel,
    category_id: categoryId,
    support_roles: supportRoles,
    created_by: ctx.userId,
  });

  return ctx.reply({
    embeds: [embeds.success('Panel posted', `The ticket panel is live in <#${channel.id}>.`)],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

async function runOpen(ctx) {
  const subject = ctx.get('subject') ?? null;
  const result = await service.open(ctx.guild, ctx.member, { subject });

  if (!result.ok) return ctx.error('Could not open a ticket', result.error);

  return ctx.reply({
    embeds: [embeds.success('Ticket opened', `Your ticket is at <#${result.channel.id}>.`)],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

async function runClose(ctx) {
  const ticketRow = await requireTicketChannel(ctx);
  if (!ticketRow) return;

  const check = ctx.hasPermission('tickets.close');
  if (!check.ok) return ctx.deny(check.reason);

  const member = ctx.member ?? await ctx.guild.members.fetch(ctx.userId).catch(() => null);
  const isOpener = ticketRow.opener_id === ctx.userId;
  const staff = isStaff(ctx) || Boolean(member?.permissions.has(PermissionFlagsBits.ManageChannels));

  if (!isOpener && !staff) {
    return ctx.deny('Only the person who opened this ticket, or staff, can close it.');
  }

  const confirmed = await ctx.confirm({
    title: `Close ticket #${ticketRow.ticket_number}?`,
    body: 'A transcript will be saved to the ticket record.',
    confirmLabel: 'Close ticket',
  });
  if (!confirmed) return;

  const result = await service.close(ctx.client, ticketRow.id, {
    closedBy: ctx.user,
    reason: `Closed by ${ctx.user.tag ?? ctx.user.username}`,
  });

  if (!result.ok) return ctx.error('Could not close', result.error);

  return ctx.reply({
    embeds: [embeds.success('Ticket closed', 'A transcript has been saved to the ticket record.')],
  });
}

// ---------------------------------------------------------------------------
// add / remove
// ---------------------------------------------------------------------------

async function runAdd(ctx) {
  const ticketRow = await requireTicketChannel(ctx);
  if (!ticketRow) return;

  const check = ctx.hasPermission('tickets.add');
  if (!check.ok) return ctx.deny(check.reason);

  const user = await asUser(ctx, 'user');
  if (!user) return ctx.error('User not found', 'I could not find that user.');

  const result = await service.addUser(ticketRow, ctx.guild, user);
  if (!result.ok) return ctx.error('Could not add', result.error);

  return ctx.reply({
    embeds: [embeds.success('Member added', `<@${user.id}> can now see this ticket.`)],
  });
}

async function runRemove(ctx) {
  const ticketRow = await requireTicketChannel(ctx);
  if (!ticketRow) return;

  const check = ctx.hasPermission('tickets.remove');
  if (!check.ok) return ctx.deny(check.reason);

  const user = await asUser(ctx, 'user');
  if (!user) return ctx.error('User not found', 'I could not find that user.');

  const result = await service.removeUser(ticketRow, ctx.guild, user);
  if (!result.ok) return ctx.error('Could not remove', result.error);

  return ctx.reply({
    embeds: [embeds.success('Member removed', `<@${user.id}> can no longer see this ticket.`)],
  });
}

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

async function runRename(ctx) {
  const ticketRow = await requireTicketChannel(ctx);
  if (!ticketRow) return;

  const check = ctx.hasPermission('tickets.rename');
  if (!check.ok) return ctx.deny(check.reason);

  const name = ctx.get('name');
  if (!name) return ctx.error('No name given', 'Provide the new channel name.');

  const result = await service.rename(ticketRow, ctx.guild, name);
  if (!result.ok) return ctx.error('Could not rename', result.error);

  return ctx.reply({
    embeds: [embeds.success('Ticket renamed', `This channel is now **#${result.name}**.`)],
  });
}

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------

async function runClaim(ctx) {
  const ticketRow = await requireTicketChannel(ctx);
  if (!ticketRow) return;

  const check = ctx.hasPermission('tickets.claim');
  if (!check.ok) return ctx.deny(check.reason);

  const result = await service.claim(ticketRow.id, ctx.user);
  if (!result.ok) return ctx.error('Could not claim', result.error);

  return ctx.reply({
    embeds: [embeds.success('Ticket claimed', `<@${ctx.userId}> is handling this ticket.`)],
  });
}

// ---------------------------------------------------------------------------
// transcript
// ---------------------------------------------------------------------------

async function runTranscript(ctx) {
  const ticketRow = await requireTicketChannel(ctx);
  if (!ticketRow) return;

  const check = ctx.hasPermission('tickets.transcript');
  if (!check.ok) return ctx.deny(check.reason);

  await ctx.defer({ ephemeral: true });

  // Reuse the stored transcript when the ticket was already closed.
  let text = ticketRow.transcript;
  let messageCount = null;

  if (!text) {
    const built = await service.buildTranscript(ctx.channel, ticketRow);
    text = built.text;
    messageCount = built.messageCount;
    await require('../../db')
      .update('tickets', { id: ticketRow.id }, { transcript: text.slice(0, 200_000) })
      .catch(() => {});
  }

  const file = new AttachmentBuilder(Buffer.from(text, 'utf8'), {
    name: `ticket-${ticketRow.ticket_number}-transcript.txt`,
  });

  return ctx.editReply({
    embeds: [
      embeds.success(
        'Transcript ready',
        `Ticket **#${ticketRow.ticket_number}**${messageCount ? ` • ${messageCount} messages` : ''}`,
      ),
    ],
    files: [file],
  });
}

// ---------------------------------------------------------------------------
// priority
// ---------------------------------------------------------------------------

async function runPriority(ctx) {
  const ticketRow = await requireTicketChannel(ctx);
  if (!ticketRow) return;

  const check = ctx.hasPermission('tickets.priority');
  if (!check.ok) return ctx.deny(check.reason);

  const level = ctx.get('level');
  if (!level) return ctx.error('No level given', 'Choose `low`, `normal`, `high` or `urgent`.');

  const result = await service.setPriority(ticketRow.id, level);
  if (!result.ok) return ctx.error('Could not set priority', result.error);

  const meta = service.PRIORITIES[level];

  return ctx.reply({
    embeds: [
      embeds.embed({
        color: meta.color,
        title: 'Priority updated',
        description: `Ticket **#${ticketRow.ticket_number}** is now **${meta.emoji} ${meta.label}**.`,
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function runList(ctx) {
  const check = ctx.hasPermission('tickets.list');
  if (!check.ok) return ctx.deny(check.reason);

  const rows = await service.openTickets(ctx.guild);

  if (rows.length === 0) {
    return ctx.reply({
      embeds: [embeds.info('No open tickets', 'There are no open tickets right now.')],
    });
  }

  const perPage = 12;
  const pages = [];
  const totalPages = Math.ceil(rows.length / perPage);

  for (let index = 0; index < rows.length; index += perPage) {
    const slice = rows.slice(index, index + perPage);
    const embed = embeds.embed({ color: COLORS.brand, title: `Open tickets (${rows.length})` });

    for (const row of slice) {
      const meta = service.PRIORITIES[row.priority] ?? service.PRIORITIES.normal;
      const age = helpers.formatDuration(
        Math.round((Date.now() - new Date(row.created_at).getTime()) / 1000),
        { units: 2 },
      );
      const claimed = row.claimed_by ? `<@${row.claimed_by}>` : '*unclaimed*';

      embed.addFields({
        name: `${meta.emoji} #${row.ticket_number} - ${helpers.truncate(row.subject || 'No subject', 60)}`,
        value: [
          `Opener: <@${row.opener_id}>`,
          `Claimed: ${claimed}`,
          `Age: ${age}`,
          row.channel ? `Channel: <#${row.channel_id}>` : '⚠️ *channel missing*',
        ].join(' • '),
      });
    }

    embed.setFooter({
      text: `Page ${Math.floor(index / perPage) + 1} of ${totalPages} • ${config.brandFooterText}`,
    });
    pages.push(embed);
  }

  return ctx.paginate(pages);
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

async function runStats(ctx) {
  const check = ctx.hasPermission('tickets.stats');
  if (!check.ok) return ctx.deny(check.reason);

  const data = await service.stats(ctx.guildId);

  const embed = embeds.embed({ color: COLORS.brand, title: '🎫 Ticket statistics' });

  embed.addFields(
    { name: 'Total', value: helpers.formatNumber(data.total), inline: true },
    { name: 'Open', value: helpers.formatNumber(data.open), inline: true },
    { name: 'Closed', value: helpers.formatNumber(data.closed), inline: true },
  );

  if (data.averageCloseSeconds !== null) {
    embed.addFields({
      name: 'Average time to close',
      value: helpers.formatDuration(data.averageCloseSeconds, { units: 2 }),
      inline: true,
    });
  }

  if (data.topStaff.length > 0) {
    embed.addFields({
      name: 'Most claims',
      value: data.topStaff.map(([id, count]) => `<@${id}>: **${count}**`).join('\n'),
    });
  }

  if (data.topOpeners.length > 0) {
    embed.addFields({
      name: 'Most tickets opened',
      value: data.topOpeners.map(([id, count]) => `<@${id}>: **${count}**`).join('\n'),
    });
  }

  embed.addFields({
    name: 'By priority',
    value: Object.values(service.PRIORITIES)
      .map((meta) => `${meta.emoji} ${meta.label}: **${data.priorities[meta.id] ?? 0}**`)
      .join(' • '),
  });

  if (ctx.get('transcript') === true) {
    const csv = [
      `Ticket report - ${ctx.guild.name}`,
      `Generated: ${new Date().toISOString()}`,
      '',
      'number,status,priority,opener_id,claimed_by,created_at,closed_at,subject',
      ...data.all.map((row) => [
        row.ticket_number,
        row.status,
        row.priority,
        row.opener_id,
        row.claimed_by ?? '',
        row.created_at,
        row.closed_at ?? '',
        `"${String(row.subject ?? '').replace(/"/g, '""')}"`,
      ].join(',')),
    ].join('\n');

    const file = new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: 'tickets.csv' });
    return ctx.reply({ embeds: [embed], files: [file] });
  }

  return ctx.reply({ embeds: [embed] });
}

module.exports = ticket;
