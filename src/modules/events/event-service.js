'use strict';

/**
 * Events & scheduling service.
 *
 * Two related things share this file:
 *   1. Guild events, stored in `events` with RSVPs in `event_attendees`. The
 *      scheduler already polls `events` for due reminders, so all this service
 *      has to do is write correct rows.
 *   2. Timed messages, stored in `scheduled_tasks` with kind 'message'. The
 *      scheduler's `runScheduledTasks` drains them, so `scheduleMessage` only
 *      needs to enqueue a row of the right shape.
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const helpers = require('../../lib/helpers');
const logger = require('../../lib/logger');
const embeds = require('../../lib/embeds');
const config = require('../../config');
const { COLORS } = require('../../lib/constants');

const log = logger.child('events');

/** RSVP states and their presentation. */
const RSVP = Object.freeze({
  going: { id: 'going', label: 'Going', emoji: '✅', color: COLORS.success },
  maybe: { id: 'maybe', label: 'Maybe', emoji: '🤔', color: COLORS.warning },
  declined: { id: 'declined', label: 'Cannot attend', emoji: '❌', color: COLORS.danger },
});

/** Custom id prefix for the RSVP buttons. */
const RSVP_PREFIX = 'ev:rsvp:';

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Create a guild event.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} options
 * @returns {Promise<{ ok: boolean, error?: string, event?: object }>}
 */
async function create(guild, options) {
  const db = require('../../db');
  const {
    name,
    description = null,
    channelId = null,
    location = null,
    startAt,
    durationSeconds = 3600,
    hostId,
    remindBefore = 900,
    maxAttendees = null,
  } = options;

  const start = new Date(startAt);
  const end = durationSeconds ? new Date(start.getTime() + durationSeconds * 1000) : null;

  const event = await db.insert('events', {
    guild_id: guild.id,
    name: String(name).slice(0, 200),
    description: description ? String(description).slice(0, 2000) : null,
    channel_id: channelId,
    host_id: hostId,
    starts_at: start.toISOString(),
    ends_at: end ? end.toISOString() : null,
    location: location ? String(location).slice(0, 200) : null,
    max_attendees: maxAttendees,
    remind_before: remindBefore,
    status: 'scheduled',
  }).catch((error) => {
    log.error('event insert failed:', error);
    return null;
  });

  if (!event) return { ok: false, error: 'The event could not be saved.' };
  return { ok: true, event };
}

/** Fetch a single event by id. */
async function get(guildId, eventId) {
  const db = require('../../db');
  return db.selectOne('events', { where: { guild_id: guildId, id: eventId }, optional: true });
}

/** Upcoming (not cancelled, not finished) events, soonest first. */
async function upcoming(guildId, limit = 10) {
  const db = require('../../db');
  const rows = await db.select('events', {
    where: { guild_id: guildId },
    order: { column: 'starts_at', ascending: true },
    limit: 200,
    optional: true,
    fallback: [],
  });

  const now = Date.now();
  return rows
    .filter((row) => row.status === 'scheduled' && new Date(row.starts_at).getTime() > now)
    .slice(0, limit);
}

/** Every event, newest first. */
async function list(guildId, limit = 25) {
  const db = require('../../db');
  return db.select('events', {
    where: { guild_id: guildId },
    order: { column: 'starts_at', ascending: false },
    limit,
    optional: true,
    fallback: [],
  });
}

/** Edit an event's fields. */
async function edit(guildId, eventId, patch) {
  const db = require('../../db');
  const event = await get(guildId, eventId);
  if (!event) return { ok: false, error: 'That event no longer exists.' };

  const update = {};
  if (patch.name) update.name = String(patch.name).slice(0, 200);
  if (patch.description !== undefined) update.description = patch.description ? String(patch.description).slice(0, 2000) : null;
  if (patch.location !== undefined) update.location = patch.location ? String(patch.location).slice(0, 200) : null;

  if (patch.startAt) {
    const start = new Date(patch.startAt);
    update.starts_at = start.toISOString();
    const duration = patch.durationSeconds
      ?? (event.ends_at ? (new Date(event.ends_at) - new Date(event.starts_at)) / 1000 : 3600);
    update.ends_at = new Date(start.getTime() + duration * 1000).toISOString();
    // A moved event deserves a fresh reminder.
    update.reminder_sent = false;
  } else if (patch.durationSeconds) {
    const start = new Date(event.starts_at);
    update.ends_at = new Date(start.getTime() + patch.durationSeconds * 1000).toISOString();
  }

  if (patch.remindBefore !== undefined) update.remind_before = patch.remindBefore;

  if (Object.keys(update).length === 0) return { ok: false, error: 'Nothing to change.' };

  const rows = await db.update('events', { guild_id: guildId, id: eventId }, update);
  return { ok: true, event: rows[0] ?? { ...event, ...update } };
}

/** Cancel an event. */
async function cancel(guildId, eventId) {
  const db = require('../../db');
  const event = await get(guildId, eventId);
  if (!event) return { ok: false, error: 'That event no longer exists.' };
  if (event.status === 'cancelled') return { ok: false, error: 'That event is already cancelled.' };

  await db.update('events', { guild_id: guildId, id: eventId }, { status: 'cancelled' });
  return { ok: true, event };
}

// ---------------------------------------------------------------------------
// RSVPs
// ---------------------------------------------------------------------------

/** Record or update a member's RSVP. */
async function rsvp(eventId, guildId, userId, status) {
  const db = require('../../db');
  if (!RSVP[status]) return { ok: false, error: 'Unknown RSVP state.' };

  await db.upsert('event_attendees', {
    event_id: eventId,
    guild_id: guildId,
    user_id: userId,
    status,
  }, 'event_id,user_id');

  return { ok: true, status };
}

/** RSVP counts and the attendee rows for an event. */
async function attendees(guildId, eventId) {
  const db = require('../../db');
  const rows = await db.select('event_attendees', {
    where: { guild_id: guildId, event_id: eventId },
    limit: 2000,
    optional: true,
    fallback: [],
  });

  const groups = { going: [], maybe: [], declined: [] };
  for (const row of rows) {
    (groups[row.status] ??= []).push(row.user_id);
  }

  return { rows, groups, total: rows.length };
}

/** A member's own RSVP state for an event. */
async function myRsvp(guildId, eventId, userId) {
  const db = require('../../db');
  return db.selectOne('event_attendees', {
    where: { guild_id: guildId, event_id: eventId, user_id: userId },
    optional: true,
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The event announcement embed. */
function render(event, groups = null) {
  const start = new Date(event.starts_at);
  const end = event.ends_at ? new Date(event.ends_at) : null;

  const cancelled = event.status === 'cancelled';
  const done = event.status === 'done';

  const embed = embeds.embed({
    color: cancelled ? COLORS.danger : (done ? COLORS.neutral : COLORS.brand),
    title: `📅 ${helpers.truncate(event.name, 200)}`,
    description: event.description ? helpers.truncate(event.description, 2000) : null,
  });

  embed.addFields(
    { name: 'Starts', value: `${helpers.timestamp(start, 'R')}\n${helpers.timestamp(start, 'f')}`, inline: true },
    {
      name: 'Status',
      value: cancelled ? '❌ Cancelled' : (done ? '⚫ Finished' : '🟢 Scheduled'),
      inline: true,
    },
  );

  if (end) {
    embed.addFields({
      name: 'Ends',
      value: `${helpers.timestamp(end, 't')} • ${helpers.formatDuration(Math.round((end - start) / 1000), { units: 1 })}`,
      inline: true,
    });
  }

  if (event.channel_id) {
    embed.addFields({ name: 'Channel', value: `<#${event.channel_id}>`, inline: true });
  }
  if (event.location) {
    embed.addFields({ name: 'Location', value: helpers.truncate(event.location, 200), inline: true });
  }

  embed.addFields({ name: 'Host', value: `<@${event.host_id}>`, inline: true });

  if (event.remind_before) {
    embed.addFields({
      name: 'Reminder',
      value: `${helpers.formatDuration(event.remind_before, { units: 1 })} before`,
      inline: true,
    });
  }

  if (groups) {
    embed.addFields(
      { name: '✅ Going', value: helpers.formatNumber(groups.going.length), inline: true },
      { name: '🤔 Maybe', value: helpers.formatNumber(groups.maybe.length), inline: true },
      { name: '❌ Not attending', value: helpers.formatNumber(groups.declined.length), inline: true },
    );
  }

  embed.setFooter({ text: `Event ${String(event.id).slice(0, 8)} • ${config.brandFooterText}` });
  return embed;
}

/** The RSVP button row. */
function controls(event) {
  const disabled = event.status !== 'scheduled';

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RSVP_PREFIX}${event.id}:going`)
      .setLabel('Going')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${RSVP_PREFIX}${event.id}:maybe`)
      .setLabel('Maybe')
      .setEmoji('🤔')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${RSVP_PREFIX}${event.id}:declined`)
      .setLabel('Cannot attend')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

/**
 * Post an event announcement to a channel and remember the message.
 * @returns {Promise<object|null>} the sent message
 */
async function announce(guild, event, channelId) {
  const db = require('../../db');

  const channel = guild.channels.cache.get(channelId)
    ?? await guild.channels.fetch(channelId).catch(() => null);

  if (!channel || !channel.isTextBased()) return null;

  const sent = await channel.send({
    content: `<@${event.host_id}>`,
    embeds: [render(event, { going: [], maybe: [], declined: [] })],
    components: [controls(event)],
    allowedMentions: { users: [event.host_id] },
  }).catch((error) => {
    log.warn('event announcement failed:', error.message);
    return null;
  });

  if (sent) {
    // The events table has no message_id column, so the event id in the
    // custom id is all the button needs.
    void db;
  }

  return sent;
}

// ---------------------------------------------------------------------------
// Timed messages (scheduled_tasks)
// ---------------------------------------------------------------------------

/**
 * Enqueue a timed message for the scheduler.
 *
 * @param {object} options
 * @param {string} options.guildId
 * @param {string} options.channelId
 * @param {string} options.content
 * @param {Date}   options.sendAt
 * @param {string} [options.createdBy]
 * @param {number} [options.repeatSeconds] null for a one-shot
 */
async function scheduleMessage(options) {
  const db = require('../../db');

  const row = await db.insert('scheduled_tasks', {
    guild_id: options.guildId,
    channel_id: options.channelId,
    user_id: options.createdBy ?? null,
    kind: 'message',
    payload: { message: String(options.content).slice(0, 2000) },
    run_at: new Date(options.sendAt).toISOString(),
    repeat_secs: options.repeatSeconds ?? null,
    status: 'pending',
  }).catch((error) => {
    log.error('scheduled task insert failed:', error);
    return null;
  });

  if (!row) return { ok: false, error: 'The message could not be scheduled.' };
  return { ok: true, task: row };
}

/** A guild's pending timed messages. */
async function pendingMessages(guildId, limit = 25) {
  const db = require('../../db');
  return db.select('scheduled_tasks', {
    where: { guild_id: guildId, kind: 'message', status: 'pending' },
    order: { column: 'run_at', ascending: true },
    limit,
    optional: true,
    fallback: [],
  });
}

/** Cancel a pending timed message by id, or by unique id prefix. */
async function cancelMessage(guildId, idOrPrefix) {
  const db = require('../../db');
  const raw = String(idOrPrefix).trim();

  const exact = await db.selectOne('scheduled_tasks', {
    where: { guild_id: guildId, kind: 'message', id: raw },
    optional: true,
  });

  if (exact) {
    await db.update('scheduled_tasks', { id: exact.id }, { status: 'cancelled' });
    return { ok: true, task: exact };
  }

  // Fall back to a prefix match so a short id still works.
  const pending = await pendingMessages(guildId, 200);
  const match = pending.find((row) => String(row.id).startsWith(raw));

  if (!match) return { ok: false, error: 'No pending message matches that ID.' };

  await db.update('scheduled_tasks', { id: match.id }, { status: 'cancelled' });
  return { ok: true, task: match };
}

module.exports = {
  RSVP,
  RSVP_PREFIX,
  create,
  get,
  upcoming,
  list,
  edit,
  cancel,
  rsvp,
  attendees,
  myRsvp,
  render,
  controls,
  announce,
  scheduleMessage,
  pendingMessages,
  cancelMessage,
};
