'use strict';

/**
 * Ticket system service.
 *
 * Owns the lifecycle: create channel -> open record -> claim -> close ->
 * transcript. Both the commands and the button handlers call in here, so the
 * rules are enforced once.
 *
 * Concurrency notes:
 *   - ticket numbers are derived from the highest existing number, and the
 *     unique index on (guild_id, ticket_number) is the real guard - a race
 *     loses the insert rather than duplicating a number
 *   - a unique index on tickets.channel_id makes a duplicate open impossible
 *   - closing claims the row first, so a button and a command cannot both close
 */

const {
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const logger = require('../../lib/logger');
const helpers = require('../../lib/helpers');
const embeds = require('../../lib/embeds');
const config = require('../../config');
const { COLORS } = require('../../lib/constants');

const log = logger.child('tickets');

/** Priority levels and their presentation. */
const PRIORITIES = Object.freeze({
  low: { id: 'low', label: 'Low', emoji: '🟢', color: COLORS.success },
  normal: { id: 'normal', label: 'Normal', emoji: '🔵', color: COLORS.brand },
  high: { id: 'high', label: 'High', emoji: '🟠', color: COLORS.warning },
  urgent: { id: 'urgent', label: 'Urgent', emoji: '🔴', color: COLORS.danger },
});

// ---------------------------------------------------------------------------
// Numbering
// ---------------------------------------------------------------------------

/**
 * Allocate the next ticket number for a guild.
 *
 * Derived from the highest number in use, not from a row count, so deleting a
 * ticket never causes a number to be reused.
 */
async function nextTicketNumber(guildId) {
  const db = require('../../db');
  const latest = await db.select('tickets', {
    columns: 'ticket_number',
    where: { guild_id: guildId },
    order: { column: 'ticket_number', ascending: false },
    limit: 1,
    optional: true,
    fallback: [],
  });

  return (latest[0]?.ticket_number ?? 0) + 1;
}

/** The most recent panel for a guild, used to inherit settings. */
async function latestPanel(guildId) {
  const db = require('../../db');
  const rows = await db.select('ticket_panels', {
    where: { guild_id: guildId },
    order: { column: 'created_at', ascending: false },
    limit: 1,
    optional: true,
    fallback: [],
  });
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/**
 * Open a ticket for a member.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember} opener
 * @param {object} [options]
 * @param {string} [options.subject]
 * @param {object} [options.panel]     ticket_panels row when opened from a panel
 * @param {string} [options.priority]
 * @returns {Promise<{ ok: boolean, error?: string, ticket?: object, channel?: object }>}
 */
async function open(guild, opener, options = {}) {
  const db = require('../../db');
  const { subject = null, priority = 'normal' } = options;

  const panel = options.panel ?? await latestPanel(guild.id);

  // ---- already open? -----------------------------------------------------
  const existing = await db.selectOne('tickets', {
    where: { guild_id: guild.id, opener_id: opener.id, status: 'open' },
    optional: true,
  });

  if (existing) {
    const existingChannel = guild.channels.cache.get(existing.channel_id);
    if (existingChannel) {
      return {
        ok: false,
        error: `You already have a ticket open: <#${existing.channel_id}> (#${existing.ticket_number}).`,
      };
    }
    // The channel is gone but the record still says open - close it so the
    // member is not locked out of opening a new one.
    await db.update('tickets', { id: existing.id }, {
      status: 'closed',
      closed_at: new Date().toISOString(),
      close_reason: 'Channel was deleted',
    }).catch(() => {});
  }

  // ---- where should the channel live? ------------------------------------
  const parentId = panel?.category_id ?? null;
  const parent = parentId ? guild.channels.cache.get(parentId) : null;

  const supportRoles = Array.isArray(panel?.support_roles)
    ? panel.support_roles.filter((roleId) => guild.roles.cache.has(roleId))
    : [];

  // ---- permission overwrites ---------------------------------------------
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: opener.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
    {
      id: guild.members.me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ManageMessages,
      ],
    },
  ];

  for (const roleId of supportRoles) {
    overwrites.push({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }

  // ---- create the channel ------------------------------------------------
  const number = await nextTicketNumber(guild.id);
  const safeName = (opener.user.username ?? 'user')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 20) || 'user';

  let channel;
  try {
    channel = await guild.channels.create({
      name: `ticket-${String(number).padStart(4, '0')}-${safeName}`,
      type: ChannelType.GuildText,
      parent: parent?.id ?? null,
      topic: `Ticket #${number} • opened by ${opener.user.tag ?? opener.user.username} • ${subject || 'no subject'}`.slice(0, 1024),
      permissionOverwrites: overwrites,
      reason: `Ticket opened by ${opener.user.tag ?? opener.id}`,
    });
  } catch (error) {
    log.error('ticket channel creation failed:', error);
    return { ok: false, error: `I could not create the ticket channel: ${error.message}` };
  }

  // ---- record ------------------------------------------------------------
  let ticket;
  try {
    ticket = await db.insert('tickets', {
      guild_id: guild.id,
      ticket_number: number,
      channel_id: channel.id,
      opener_id: opener.id,
      opener_tag: opener.user.tag ?? opener.user.username,
      subject,
      status: 'open',
      priority: PRIORITIES[priority] ? priority : 'normal',
      panel_id: panel?.id ?? null,
      added_users: [],
      last_activity: new Date().toISOString(),
    });
  } catch (error) {
    log.error('ticket record insert failed:', error);
    // Never leave an orphan channel behind.
    await channel.delete('Ticket record could not be saved').catch(() => {});
    return { ok: false, error: 'The ticket could not be recorded. Please try again.' };
  }

  // ---- opening message ---------------------------------------------------
  const meta = PRIORITIES[ticket.priority] ?? PRIORITIES.normal;

  const embed = embeds.embed({
    color: meta.color,
    title: `🎫 Ticket #${number}`,
    description: [
      `Thanks for reaching out, <@${opener.id}>.`,
      '',
      subject ? `**Subject:** ${helpers.truncate(subject, 700)}` : null,
      panel?.description ? helpers.truncate(panel.description, 400) : null,
      '',
      'A member of staff will be with you shortly. You can add more detail below.',
    ].filter(Boolean).join('\n'),
  });

  embed.addFields(
    { name: 'Opened by', value: `<@${opener.id}>`, inline: true },
    { name: 'Priority', value: `${meta.emoji} ${meta.label}`, inline: true },
    { name: 'Status', value: '🟢 Open', inline: true },
  );

  embed.setFooter({ text: `Ticket #${number} • ${config.brandFooterText}` });

  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tk:close:${ticket.id}`).setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`tk:claim:${ticket.id}`).setLabel('Claim').setEmoji('✋').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`tk:transcript:${ticket.id}`).setLabel('Transcript').setEmoji('📄').setStyle(ButtonStyle.Secondary),
  );

  const mentions = [`<@${opener.id}>`, ...supportRoles.map((roleId) => `<@&${roleId}>`)].join(' ');

  await channel.send({
    content: mentions,
    embeds: [embed],
    components: [controls],
    allowedMentions: { users: [opener.id], roles: supportRoles },
  }).catch((error) => log.warn('ticket opening message failed:', error.message));

  return { ok: true, ticket, channel };
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

/**
 * Close a ticket and generate its transcript.
 *
 * @param {import('discord.js').Client} client
 * @param {string} ticketId
 * @param {object} [options]
 * @param {import('discord.js').User} [options.closedBy]
 * @param {string} [options.reason]
 * @param {boolean} [options.deleteChannel]
 */
async function close(client, ticketId, options = {}) {
  const db = require('../../db');
  const { closedBy = null, reason = 'No reason provided', deleteChannel = false } = options;

  const ticket = await db.selectOne('tickets', { where: { id: ticketId }, optional: true });
  if (!ticket) return { ok: false, error: 'That ticket no longer exists.' };
  if (ticket.status !== 'open') return { ok: false, error: 'That ticket is already closed.' };

  // ---- claim the row so a second caller cannot close it as well ----------
  const claimed = await db.update(
    'tickets',
    { id: ticketId, status: 'open' },
    {
      status: 'closed',
      closed_by: closedBy?.id ?? null,
      closed_at: new Date().toISOString(),
      close_reason: helpers.truncate(reason, 500),
    },
  ).catch(() => []);

  if (!Array.isArray(claimed) || claimed.length === 0) {
    return { ok: false, error: 'That ticket was just closed by someone else.' };
  }

  const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
  if (!channel) {
    return { ok: true, ticket, transcript: null, note: 'The channel no longer exists.' };
  }

  // ---- transcript --------------------------------------------------------
  const transcript = await buildTranscript(channel, ticket);

  // Store it on the record so the Transcript button can re-send it later.
  await db.update('tickets', { id: ticketId }, {
    transcript: transcript.text.slice(0, 200_000),
  }).catch(() => {});

  // ---- closing notice ----------------------------------------------------
  const embed = embeds.embed({
    color: COLORS.danger,
    title: '🔒 Ticket closed',
    description: `Closed by ${closedBy ? `<@${closedBy.id}>` : 'the system'}.`,
  });
  embed.addFields(
    { name: 'Reason', value: helpers.truncate(reason, 500), inline: false },
    { name: 'Messages', value: String(transcript.messageCount), inline: true },
  );
  embed.setFooter({ text: `Ticket #${ticket.ticket_number} • ${config.brandFooterText}` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`tk:transcript:${ticketId}`)
      .setLabel('Transcript')
      .setEmoji('📄')
      .setStyle(ButtonStyle.Secondary),
  );

  await channel.send({ embeds: [embed], components: [row] }).catch(() => {});

  // ---- optionally remove the channel -------------------------------------
  if (deleteChannel) {
    await helpers.sleep(3000);
    await channel.delete(`Ticket closed by ${closedBy?.tag ?? 'system'}`).catch(() => {});
    await db.update('tickets', { id: ticketId }, { status: 'deleted' }).catch(() => {});
  }

  return { ok: true, ticket, transcript };
}

// ---------------------------------------------------------------------------
// Transcript building
// ---------------------------------------------------------------------------

/**
 * Build a plain-text transcript of a ticket channel.
 *
 * Text rather than HTML: readable on mobile, survives being re-uploaded and
 * needs no rendering step.
 *
 * @param {import('discord.js').GuildBasedChannel} channel
 * @param {object} ticket
 */
async function buildTranscript(channel, ticket) {
  const collected = [];
  let lastId = null;

  // Safety cap so an enormous ticket cannot exhaust memory.
  const MAX_MESSAGES = 2000;

  while (collected.length < MAX_MESSAGES) {
    const batch = await channel.messages
      .fetch({ limit: 100, before: lastId ?? undefined })
      .catch(() => null);

    if (!batch || batch.size === 0) break;

    collected.push(...batch.values());
    lastId = batch.last()?.id;
    if (batch.size < 100) break;
  }

  const ordered = collected.reverse();
  const lines = [
    `Transcript for ticket #${ticket.ticket_number}`,
    `Server: ${channel.guild?.name ?? 'unknown'}`,
    `Channel: #${channel.name}`,
    `Opened by: ${ticket.opener_tag ?? ticket.opener_id}`,
    `Opened at: ${new Date(ticket.created_at).toISOString()}`,
    `Closed at: ${new Date().toISOString()}`,
    `Messages: ${ordered.length}`,
    '='.repeat(72),
    '',
  ];

  for (const message of ordered) {
    const stamp = new Date(message.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
    const author = message.author?.tag ?? message.author?.username ?? 'unknown';

    lines.push(`[${stamp}] ${author}`);
    if (message.content) lines.push(message.content);

    if (message.attachments?.size > 0) {
      for (const attachment of message.attachments.values()) {
        lines.push(`  [attachment] ${attachment.name} - ${attachment.url}`);
      }
    }

    if (message.embeds?.length > 0) {
      for (const embedded of message.embeds) {
        if (embedded.title) lines.push(`  [embed] ${embedded.title}`);
        if (embedded.description) lines.push(`  [embed] ${helpers.truncate(embedded.description, 500)}`);
      }
    }

    lines.push('');
  }

  const text = lines.join('\n');

  return {
    text,
    messageCount: ordered.length,
    buffer: Buffer.from(text, 'utf8'),
  };
}

// ---------------------------------------------------------------------------
// Participant management
// ---------------------------------------------------------------------------

/** Add a user to a ticket channel. */
async function addUser(ticket, guild, user) {
  const db = require('../../db');
  const channel = guild.channels.cache.get(ticket.channel_id);
  if (!channel) return { ok: false, error: 'The ticket channel no longer exists.' };

  if (user.id === ticket.opener_id) {
    return { ok: false, error: 'That user opened this ticket, so they are already in it.' };
  }

  const added = Array.isArray(ticket.added_users) ? ticket.added_users : [];
  if (added.includes(user.id)) {
    return { ok: false, error: 'That user is already added to this ticket.' };
  }

  const done = await channel.permissionOverwrites.edit(user.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AttachFiles: true,
  }, { reason: 'Added to ticket' }).then(() => true).catch((error) => error);

  if (done !== true) return { ok: false, error: done.message ?? String(done) };

  await db.update('tickets', { id: ticket.id }, { added_users: [...added, user.id] });
  return { ok: true };
}

/** Remove a user from a ticket channel. */
async function removeUser(ticket, guild, user) {
  const db = require('../../db');
  const channel = guild.channels.cache.get(ticket.channel_id);
  if (!channel) return { ok: false, error: 'The ticket channel no longer exists.' };

  if (user.id === ticket.opener_id) {
    return { ok: false, error: 'You cannot remove the person who opened the ticket.' };
  }

  const done = await channel.permissionOverwrites
    .delete(user.id, 'Removed from ticket')
    .then(() => true)
    .catch((error) => error);

  if (done !== true) return { ok: false, error: done.message ?? String(done) };

  const added = Array.isArray(ticket.added_users) ? ticket.added_users : [];
  await db.update('tickets', { id: ticket.id }, {
    added_users: added.filter((id) => id !== user.id),
  });

  return { ok: true };
}

/** Claim a ticket for a staff member. */
async function claim(ticketId, user) {
  const db = require('../../db');

  const ticket = await db.selectOne('tickets', { where: { id: ticketId }, optional: true });
  if (!ticket) return { ok: false, error: 'That ticket no longer exists.' };
  if (ticket.status !== 'open') return { ok: false, error: 'That ticket is closed.' };
  if (ticket.claimed_by && ticket.claimed_by !== user.id) {
    return { ok: false, error: `That ticket is already claimed by <@${ticket.claimed_by}>.` };
  }

  const updated = await db.update('tickets', { id: ticketId }, {
    claimed_by: user.id,
    claimed_at: new Date().toISOString(),
  });

  return { ok: true, ticket: updated[0] ?? ticket };
}

/** Rename a ticket channel. */
async function rename(ticket, guild, newName) {
  const channel = guild.channels.cache.get(ticket.channel_id);
  if (!channel) return { ok: false, error: 'The ticket channel no longer exists.' };

  const cleaned = String(newName)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);

  if (!cleaned) return { ok: false, error: 'That name has no usable characters.' };

  const done = await channel.setName(cleaned, 'Ticket renamed').then(() => true).catch((error) => error);
  if (done !== true) return { ok: false, error: done.message ?? String(done) };

  return { ok: true, name: cleaned };
}

/** Set a ticket's priority. */
async function setPriority(ticketId, priority) {
  const db = require('../../db');
  if (!PRIORITIES[priority]) return { ok: false, error: 'Unknown priority level.' };

  const updated = await db.update('tickets', { id: ticketId }, { priority });
  return { ok: true, ticket: updated[0] ?? null, priority: PRIORITIES[priority] };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Find the ticket for a channel. */
async function findByChannel(channelId) {
  const db = require('../../db');
  return db.selectOne('tickets', { where: { channel_id: channelId }, optional: true });
}

/** Find a ticket by id. */
async function findById(ticketId) {
  const db = require('../../db');
  return db.selectOne('tickets', { where: { id: ticketId }, optional: true });
}

/** List a guild's tickets. */
async function list(guildId, { status = null, limit = 50 } = {}) {
  const db = require('../../db');
  const where = { guild_id: guildId };
  if (status) where.status = status;

  return db.select('tickets', {
    where,
    order: { column: 'created_at', ascending: false },
    limit,
    optional: true,
    fallback: [],
  });
}

/** Aggregate ticket statistics for /ticket stats. */
async function stats(guildId) {
  const db = require('../../db');
  const all = await db.select('tickets', {
    where: { guild_id: guildId },
    limit: 5000,
    optional: true,
    fallback: [],
  });

  const total = all.length;
  const openCount = all.filter((row) => row.status === 'open').length;
  const closed = all.filter((row) => row.status !== 'open');

  // Average time to close, in seconds.
  let totalCloseSeconds = 0;
  let closeSamples = 0;
  for (const row of closed) {
    if (!row.closed_at) continue;
    totalCloseSeconds += (new Date(row.closed_at).getTime() - new Date(row.created_at).getTime()) / 1000;
    closeSamples += 1;
  }

  // Busiest staff, by claims.
  const claims = {};
  for (const row of all) {
    if (!row.claimed_by) continue;
    claims[row.claimed_by] = (claims[row.claimed_by] || 0) + 1;
  }
  const topStaff = Object.entries(claims).sort((a, b) => b[1] - a[1]).slice(0, 5);

  // Busiest openers.
  const openers = {};
  for (const row of all) {
    openers[row.opener_id] = (openers[row.opener_id] || 0) + 1;
  }
  const topOpeners = Object.entries(openers).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const priorities = {};
  for (const row of all) {
    priorities[row.priority] = (priorities[row.priority] || 0) + 1;
  }

  return {
    total,
    open: openCount,
    closed: closed.length,
    averageCloseSeconds: closeSamples > 0 ? Math.round(totalCloseSeconds / closeSamples) : null,
    topStaff,
    topOpeners,
    priorities,
    all,
  };
}

/** Open tickets for a guild, with channel existence resolved. */
async function openTickets(guild) {
  const rows = await list(guild.id, { status: 'open', limit: 100 });
  return rows.map((row) => ({
    ...row,
    channel: guild.channels.cache.get(row.channel_id) ?? null,
  }));
}

module.exports = {
  PRIORITIES,
  nextTicketNumber,
  latestPanel,
  open,
  close,
  buildTranscript,
  addUser,
  removeUser,
  claim,
  rename,
  setPriority,
  findByChannel,
  findById,
  list,
  stats,
  openTickets,
};
