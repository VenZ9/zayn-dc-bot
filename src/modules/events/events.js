'use strict';

/**
 * Module 9 - Events & Scheduling.
 *
 *   /event create | list | edit | cancel | attendees        (guild events)
 *   /event schedule | scheduled | unschedule               (timed messages)
 *
 * Events live in the `events` table and RSVPs in `event_attendees`; both are
 * already polled by the scheduler for reminders. Timed messages are enqueued
 * into `scheduled_tasks` for the same scheduler to deliver.
 */

const { defineCommand } = require('../../core/command');
const helpers = require('../../lib/helpers');
const embeds = require('../../lib/embeds');
const config = require('../../config');
const { COLORS } = require('../../lib/constants');
const service = require('./event-service');

// ---------------------------------------------------------------------------
// Component handlers
// ---------------------------------------------------------------------------

const components = {
  /** RSVP buttons: `ev:rsvp:<eventId>:<status>`. */
  [service.RSVP_PREFIX.slice(0, -1)]: async (interaction) => {
    const [, , eventId, status] = interaction.customId.split(':');
    const db = require('../../db');

    const event = await db.selectOne('events', {
      where: { id: eventId, guild_id: interaction.guildId },
      optional: true,
    });

    if (!event) {
      return interaction.reply({
        embeds: [embeds.error('Not found', 'That event no longer exists.')],
        ephemeral: true,
      });
    }

    if (event.status !== 'scheduled') {
      return interaction.reply({
        embeds: [embeds.warning('RSVPs closed', 'That event is no longer accepting responses.')],
        ephemeral: true,
      });
    }

    const chosen = service.RSVP[status];
    if (!chosen) {
      return interaction.reply({ embeds: [embeds.error('Unknown response', 'That RSVP is not valid.')], ephemeral: true });
    }

    await service.rsvp(eventId, interaction.guildId, interaction.user.id, status);

    const { groups } = await service.attendees(interaction.guildId, eventId);

    // Refresh the announcement so the counts stay live.
    await interaction.message.edit({
      embeds: [service.render(event, groups)],
      components: [service.controls(event)],
    }).catch(() => {});

    return interaction.reply({
      embeds: [
        embeds.success(
          `Marked as ${chosen.label} ${chosen.emoji}`,
          `You responded to **${helpers.truncate(event.name, 150)}**.`,
        ),
      ],
      ephemeral: true,
    });
  },
};

// ---------------------------------------------------------------------------
// /event
// ---------------------------------------------------------------------------

const event = defineCommand({
  name: 'event',
  description: 'Create and manage events and timed messages',
  module: 'events',
  node: 'events.create',
  aliases: ['events', 'schedule'],
  cooldown: 3,
  components,
  subcommands: [
    {
      name: 'create',
      description: 'Create an event',
      args: [
        { name: 'name', type: 'string', required: true, description: 'Event name', maxLength: 200 },
        { name: 'starts_in', type: 'string', required: true, description: 'How soon it starts, e.g. 2h, 1d', maxLength: 20 },
        { name: 'duration', type: 'string', required: false, description: 'How long it lasts, e.g. 1h (default 1h)', maxLength: 20 },
        { name: 'channel', type: 'channel', required: false, description: 'Where to announce it' },
        { name: 'description', type: 'string', required: false, description: 'Details', maxLength: 1200 },
        { name: 'location', type: 'string', required: false, description: 'A location, for in-person or external events', maxLength: 200 },
        { name: 'remind_before', type: 'string', required: false, description: 'Reminder lead time, e.g. 15m (default 15m)', maxLength: 20 },
      ],
    },
    { name: 'list', description: 'Show upcoming events' },
    {
      name: 'edit',
      description: 'Edit an event',
      args: [
        { name: 'event_id', type: 'string', required: true, description: 'The event ID', maxLength: 40 },
        { name: 'name', type: 'string', required: false, description: 'New name', maxLength: 200 },
        { name: 'description', type: 'string', required: false, description: 'New description', maxLength: 1200 },
        { name: 'starts_in', type: 'string', required: false, description: 'New start, e.g. 30m', maxLength: 20 },
        { name: 'duration', type: 'string', required: false, description: 'New duration, e.g. 2h', maxLength: 20 },
        { name: 'location', type: 'string', required: false, description: 'New location', maxLength: 200 },
      ],
    },
    {
      name: 'cancel',
      description: 'Cancel an event',
      args: [{ name: 'event_id', type: 'string', required: true, description: 'The event ID', maxLength: 40 }],
    },
    {
      name: 'attendees',
      description: 'List who has responded to an event',
      args: [{ name: 'event_id', type: 'string', required: true, description: 'The event ID', maxLength: 40 }],
    },
    {
      name: 'schedule',
      description: 'Post a message at a later time',
      args: [
        { name: 'when', type: 'string', required: true, description: 'How soon to post, e.g. 30m, 2h, 1d', maxLength: 20 },
        { name: 'content', type: 'string', required: true, description: 'The message to post', maxLength: 1500 },
        { name: 'channel', type: 'channel', required: false, description: 'Where to post (default: here)' },
        { name: 'repeat', type: 'string', required: false, description: 'Repeat every, e.g. 1d, 12h (default: once)', maxLength: 20 },
      ],
    },
    { name: 'scheduled', description: 'List pending timed messages' },
    {
      name: 'unschedule',
      description: 'Cancel a timed message',
      args: [{ name: 'message_id', type: 'string', required: true, description: 'The scheduled message ID', maxLength: 40 }],
    },
  ],

  async run(ctx) {
    const sub = ctx.subcommand?.name ?? null;
    if (!sub) {
      return ctx.reply({
        embeds: [
          embeds.info(
            'Events & scheduling',
            [
              `\`${ctx.prefix}event create <name> <starts_in> [duration] [channel]\``,
              `\`${ctx.prefix}event list\``,
              `\`${ctx.prefix}event edit <event_id> [starts_in] [name]\``,
              `\`${ctx.prefix}event cancel <event_id>\``,
              `\`${ctx.prefix}event attendees <event_id>\``,
              `\`${ctx.prefix}event schedule <when> <content> [repeat]\``,
              `\`${ctx.prefix}event scheduled\``,
              `\`${ctx.prefix}event unschedule <message_id>\``,
            ].join('\n'),
          ),
        ],
      });
    }

    const node = (sub === 'schedule' || sub === 'scheduled' || sub === 'unschedule')
      ? 'events.remind'
      : 'events.create';

    const check = ctx.hasPermission(node);
    if (!check.ok) return ctx.deny(check.reason);

    switch (sub) {
      case 'create': return runCreate(ctx);
      case 'list': return runList(ctx);
      case 'edit': return runEdit(ctx);
      case 'cancel': return runCancel(ctx);
      case 'attendees': return runAttendees(ctx);
      case 'schedule': return runSchedule(ctx);
      case 'scheduled': return runScheduled(ctx);
      case 'unschedule': return runUnschedule(ctx);
      default: return ctx.error('Unknown option', `\`${sub}\` is not available.`);
    }
  },
});

/** Resolve a channel argument. */
function asChannel(ctx, name) {
  const raw = ctx.get(name);
  if (!raw) return null;
  if (typeof raw === 'object' && raw.id) return raw;
  const id = helpers.extractId(String(raw));
  return id ? (ctx.guild.channels.cache.get(id) ?? null) : null;
}

/** Extract a snowflake-ish id argument, or the raw trimmed string. */
function idArg(ctx, name) {
  const raw = String(ctx.get(name) ?? '').trim();
  return helpers.extractId(raw) ?? raw;
}

// ---------------------------------------------------------------------------
// create / list / edit / cancel / attendees
// ---------------------------------------------------------------------------

async function runCreate(ctx) {
  const name = ctx.get('name');
  if (!name) return ctx.error('No name given', 'Give the event a name.');

  const seconds = helpers.parseDuration(ctx.get('starts_in'));
  if (!seconds) return ctx.error('Invalid start time', 'Use a value like `30m`, `2h` or `1d`.');

  const startAt = new Date(Date.now() + seconds * 1000);
  if (startAt.getTime() < Date.now() + 60_000) {
    return ctx.error('Too soon', 'An event must start at least a minute from now.');
  }

  const durationSeconds = helpers.parseDuration(ctx.get('duration')) ?? 3600;
  const remindBefore = helpers.parseDuration(ctx.get('remind_before')) ?? 900;

  const result = await service.create(ctx.guild, {
    name,
    description: ctx.get('description') ?? null,
    channelId: asChannel(ctx, 'channel')?.id ?? ctx.channelId,
    location: ctx.get('location') ?? null,
    startAt,
    durationSeconds,
    hostId: ctx.userId,
    remindBefore,
  });

  if (!result.ok) return ctx.error('Could not create the event', result.error);

  const { groups } = await service.attendees(ctx.guildId, result.event.id);
  await service.announce(ctx.guild, result.event, result.event.channel_id);

  return ctx.reply({
    embeds: [
      embeds.success(
        'Event created 🎉',
        [
          `**${helpers.truncate(name, 150)}** starts ${helpers.timestamp(startAt, 'R')}.`,
          `Event ID: \`${result.event.id}\``,
          `A reminder will be posted ${helpers.formatDuration(remindBefore, { units: 1 })} before it starts.`,
        ].join('\n'),
      ),
      service.render(result.event, groups),
    ],
  });
}

async function runList(ctx) {
  const events = await service.upcoming(ctx.guildId, 10);

  if (events.length === 0) {
    return ctx.reply({
      embeds: [embeds.info('No upcoming events', `Use \`${ctx.prefix}event create\` to schedule one.`)],
    });
  }

  const embed = embeds.embed({
    color: COLORS.brand,
    title: `📅 Upcoming events (${events.length})`,
  });

  for (const row of events) {
    const start = new Date(row.starts_at);
    embed.addFields({
      name: helpers.truncate(row.name, 90),
      value: [
        `${helpers.timestamp(start, 'R')} • ${helpers.timestamp(start, 'f')}`,
        `Host: <@${row.host_id}>${row.channel_id ? ` • <#${row.channel_id}>` : ''}`,
        `ID: \`${row.id}\``,
      ].join('\n'),
    });
  }

  embed.setFooter({ text: config.brandFooterText });
  return ctx.reply({ embeds: [embed] });
}

async function runEdit(ctx) {
  const eventId = idArg(ctx, 'event_id');

  const options = {
    name: ctx.get('name') ?? null,
    description: ctx.get('description'),
    location: ctx.get('location') ?? null,
  };

  const startText = ctx.get('starts_in');
  if (startText) {
    const seconds = helpers.parseDuration(startText);
    if (!seconds) return ctx.error('Invalid start time', 'Use a value like `30m`, `2h` or `1d`.');
    options.startAt = new Date(Date.now() + seconds * 1000);
  }

  const durationText = ctx.get('duration');
  if (durationText) {
    const seconds = helpers.parseDuration(durationText);
    if (!seconds) return ctx.error('Invalid duration', 'Use a value like `30m`, `2h` or `1d`.');
    options.durationSeconds = seconds;
  }

  const result = await service.edit(ctx.guildId, eventId, options);
  if (!result.ok) return ctx.error('Could not edit the event', result.error);

  const { groups } = await service.attendees(ctx.guildId, eventId);
  return ctx.reply({ embeds: [service.render(result.event, groups)] });
}

async function runCancel(ctx) {
  const eventId = idArg(ctx, 'event_id');

  const result = await service.cancel(ctx.guildId, eventId);
  if (!result.ok) return ctx.error('Could not cancel the event', result.error);

  return ctx.reply({
    embeds: [embeds.success('Event cancelled', `**${helpers.truncate(result.event.name, 150)}** has been cancelled.`)],
  });
}

async function runAttendees(ctx) {
  const eventId = idArg(ctx, 'event_id');

  const event = await service.get(ctx.guildId, eventId);
  if (!event) return ctx.error('Event not found', 'No event matches that ID.');

  const { groups } = await service.attendees(ctx.guildId, eventId);

  const embed = embeds.embed({
    color: COLORS.brand,
    title: `👥 ${helpers.truncate(event.name, 150)}`,
    description: `${helpers.timestamp(new Date(event.starts_at), 'R')} • ${helpers.timestamp(new Date(event.starts_at), 'f')}`,
  });

  embed.addFields(
    { name: `✅ Going (${groups.going.length})`, value: groups.going.length > 0 ? groups.going.slice(0, 30).map((id) => `<@${id}>`).join(', ') : '*nobody yet*' },
    { name: `🤔 Maybe (${groups.maybe.length})`, value: groups.maybe.length > 0 ? groups.maybe.slice(0, 30).map((id) => `<@${id}>`).join(', ') : '*nobody*' },
    { name: `❌ Not attending (${groups.declined.length})`, value: groups.declined.length > 0 ? groups.declined.slice(0, 30).map((id) => `<@${id}>`).join(', ') : '*nobody*' },
  );

  embed.setFooter({ text: config.brandFooterText });
  return ctx.reply({ embeds: [embed] });
}

// ---------------------------------------------------------------------------
// Timed messages
// ---------------------------------------------------------------------------

async function runSchedule(ctx) {
  const content = ctx.get('content');
  if (!content) return ctx.error('No message', 'What should I post?');

  const seconds = helpers.parseDuration(ctx.get('when'));
  if (!seconds) return ctx.error('Invalid time', 'Use a value like `30m`, `2h` or `1d`.');
  if (seconds < 60) return ctx.error('Too soon', 'Schedule at least a minute ahead.');

  const channel = asChannel(ctx, 'channel') ?? ctx.channel;
  if (!channel.isTextBased()) return ctx.error('Invalid channel', 'Choose a text channel.');

  const repeatText = ctx.get('repeat');
  const repeatSeconds = repeatText ? helpers.parseDuration(repeatText) : null;
  if (repeatText && !repeatSeconds) {
    return ctx.error('Invalid repeat', 'Use a duration like `12h` or `1d`.');
  }

  const sendAt = new Date(Date.now() + seconds * 1000);

  const result = await service.scheduleMessage({
    guildId: ctx.guildId,
    channelId: channel.id,
    content,
    sendAt,
    createdBy: ctx.userId,
    repeatSeconds,
  });

  if (!result.ok) return ctx.error('Could not schedule it', result.error);

  return ctx.reply({
    embeds: [
      embeds.success(
        'Message scheduled',
        [
          `Channel: <#${channel.id}>`,
          `First post: ${helpers.timestamp(sendAt, 'R')} (${helpers.timestamp(sendAt, 'f')})`,
          repeatText ? `Repeats every **${helpers.formatDuration(repeatSeconds, { units: 1 })}**` : 'Posts once',
          `ID: \`${result.task.id}\``,
        ].join('\n'),
      ),
    ],
    ephemeral: true,
  });
}

async function runScheduled(ctx) {
  const rows = await service.pendingMessages(ctx.guildId, 25);

  if (rows.length === 0) {
    return ctx.reply({
      embeds: [embeds.info('Nothing scheduled', `Use \`${ctx.prefix}event schedule\` to queue a message.`)],
    });
  }

  const embed = embeds.embed({ color: COLORS.brand, title: `⏰ Scheduled messages (${rows.length})` });

  for (const row of rows) {
    const payload = row.payload ?? {};
    embed.addFields({
      name: helpers.timestamp(new Date(row.run_at), 'R'),
      value: [
        helpers.truncate(String(payload.message ?? '(no content)'), 180),
        `Channel: <#${row.channel_id}>${row.repeat_secs ? ` • repeats every ${helpers.formatDuration(row.repeat_secs, { units: 1 })}` : ''}`,
        `ID: \`${row.id}\``,
      ].join('\n'),
    });
  }

  embed.setFooter({ text: config.brandFooterText });
  return ctx.reply({ embeds: [embed] });
}

async function runUnschedule(ctx) {
  const result = await service.cancelMessage(ctx.guildId, idArg(ctx, 'message_id'));
  if (!result.ok) return ctx.error('Not found', result.error);

  return ctx.reply({
    embeds: [embeds.success('Scheduled message cancelled', `\`${result.task.id}\` will not be posted.`)],
    ephemeral: true,
  });
}

module.exports = event;
