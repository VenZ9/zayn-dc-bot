'use strict';

/**
 * The background scheduler.
 *
 * Design goals, in order:
 *
 *   1. **Survive restarts.** Every due item lives in the database, not in
 *      memory. A Koyeb redeploy mid-giveaway must not lose the draw.
 *   2. **Exactly-once per tick.** Items are claimed by flipping their status
 *      before the work runs, so a slow handler cannot be picked up twice.
 *   3. **Never overlap.** A single re-entrancy guard means a slow tick cannot
 *      start a second copy of itself.
 *   4. **Never fatal.** A failing task is logged and retried a bounded number
 *      of times, then parked as `failed` rather than retrying for ever.
 *
 * It runs one interval, not one timer per job. With one bot instance and a
 * handful of servers that is far simpler than a job queue, and the database
 * already gives us the durability.
 */

const config = require('../config');
const logger = require('../lib/logger');
const helpers = require('../lib/helpers');
const embeds = require('../lib/embeds');

const log = logger.child('scheduler');

/** Max attempts before a scheduled task is parked as failed. */
const MAX_ATTEMPTS = 5;

/** Batch size per tick - keeps a backlog from blocking the event loop. */
const BATCH_SIZE = 25;

let timer = null;
let running = false;
let clientRef = null;
let tickCount = 0;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the scheduler.
 * @param {import('discord.js').Client} client
 */
function start(client) {
  if (timer) {
    log.warn('scheduler already running');
    return;
  }

  clientRef = client;
  const intervalMs = config.taskIntervalSeconds * 1000;

  log.info(`scheduler starting - polling every ${config.taskIntervalSeconds}s`);

  // Run once shortly after boot so a restart catches up immediately.
  setTimeout(() => {
    tick().catch((error) => log.error('initial tick failed:', error));
  }, 5_000);

  timer = setInterval(() => {
    tick().catch((error) => log.error('tick failed:', error));
  }, intervalMs);
}

/** Stop the scheduler (used by graceful shutdown). */
function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info('scheduler stopped');
  }
}

/** Is the scheduler running? */
const isRunning = () => timer !== null;

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

/**
 * One polling pass. Runs every registered task in sequence and isolates
 * failures so one broken task cannot stop the others.
 */
async function tick() {
  if (running) {
    log.debug('previous tick still running - skipping');
    return;
  }
  if (!clientRef) return;

  const db = require('../db');
  if (!db.isEnabled()) return;

  running = true;
  tickCount += 1;
  const startedAt = Date.now();

  try {
    const tasks = [
      ['scheduled reminders/messages', runScheduledTasks],
      ['giveaway endings', runGiveawayEndings],
      ['tempban expiry', runTempbanExpiry],
      ['event reminders', runEventReminders],
      ['level reward reconciliation', runLevelRewards],
    ];

    for (const [label, task] of tasks) {
      try {
        await task(clientRef);
      } catch (error) {
        log.error(`${label} failed:`, error);
      }
    }

    log.debug(`tick #${tickCount} done in ${Date.now() - startedAt}ms`);
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------------------
// Task: scheduled reminders and messages
// ---------------------------------------------------------------------------

/**
 * Drain due rows from `scheduled_tasks`.
 *
 * Rows are claimed by moving them to `processing` first. If the process dies
 * mid-handler the row is left in `processing` and re-queued by
 * `requeueStuckTasks` on a later tick, so nothing is silently lost.
 */
async function runScheduledTasks(client) {
  const db = require('../db');

  const due = await db.select('scheduled_tasks', {
    where: { status: 'pending' },
    order: { column: 'run_at', ascending: true },
    limit: BATCH_SIZE,
    optional: true,
    fallback: [],
  });

  const now = Date.now();
  const ready = due.filter((row) => new Date(row.run_at).getTime() <= now);
  if (ready.length === 0) return;

  for (const row of ready) {
    // ---- claim -----------------------------------------------------------
    const claimed = await db.update(
      'scheduled_tasks',
      { id: row.id, status: 'pending' },
      { status: 'processing', attempts: (row.attempts || 0) + 1 },
    ).catch(() => []);

    // Another instance (or an overlapping tick) got it first.
    if (claimed.length === 0) continue;

    try {
      await deliverScheduledTask(client, row);

      if (row.repeat_secs) {
        // Recurring: schedule the next occurrence instead of finishing.
        const nextRun = new Date(now + Number(row.repeat_secs) * 1000);
        await db.update('scheduled_tasks', { id: row.id }, {
          status: 'pending',
          run_at: nextRun.toISOString(),
          processed_at: new Date().toISOString(),
        });
      } else {
        await db.update('scheduled_tasks', { id: row.id }, {
          status: 'done',
          processed_at: new Date().toISOString(),
        });
      }
    } catch (error) {
      const attempts = (row.attempts || 0) + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;

      log.warn(
        `scheduled task ${row.id} (${row.kind}) failed on attempt ${attempts}`
        + `${giveUp ? ' - giving up' : ''}: ${error.message}`,
      );

      await db.update('scheduled_tasks', { id: row.id }, {
        status: giveUp ? 'failed' : 'pending',
        last_error: helpers.truncate(error.message, 500),
        // Back off a little before the retry.
        run_at: giveUp ? row.run_at : new Date(Date.now() + 60_000).toISOString(),
      }).catch(() => {});
    }
  }

  await requeueStuckTasks();
}

/**
 * Re-queue rows stuck in `processing`.
 *
 * A row lands here when the process was killed between claiming and finishing.
 * Anything processing for more than two minutes is assumed abandoned.
 */
async function requeueStuckTasks() {
  const db = require('../db');
  const cutoff = new Date(Date.now() - 120_000).toISOString();

  const stuck = await db.select('scheduled_tasks', {
    where: { status: 'processing' },
    limit: 50,
    optional: true,
    fallback: [],
  });

  const abandoned = stuck.filter((row) => {
    const stamp = row.processed_at || row.created_at;
    return stamp && new Date(stamp).getTime() < new Date(cutoff).getTime();
  });

  for (const row of abandoned) {
    log.warn(`re-queuing abandoned task ${row.id} (${row.kind})`);
    await db.update('scheduled_tasks', { id: row.id }, { status: 'pending' }).catch(() => {});
  }
}

/** Actually send a reminder / scheduled message. */
async function deliverScheduledTask(client, row) {
  const payload = row.payload || {};
  const channelId = row.channel_id || payload.channel_id;

  if (!channelId) throw new Error('scheduled task has no channel');

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`channel ${channelId} is missing or not text based`);
  }

  if (row.kind === 'reminder') {
    const mention = row.user_id ? `<@${row.user_id}>` : '';
    const embed = embeds.embed({
      color: 0x5865f2,
      title: '⏰ Reminder',
      description: payload.message || 'You asked me to remind you.',
    });
    if (payload.url) embed.addFields({ name: 'Link', value: payload.url });
    await channel.send({ content: mention || undefined, embeds: [embed] });
    return;
  }

  if (row.kind === 'message') {
    const embed = embeds.embed({
      color: 0x5865f2,
      title: payload.title || 'Scheduled message',
      description: payload.message || '',
    });
    await channel.send({
      content: payload.mention ? payload.mention : undefined,
      embeds: [embed],
    });
    return;
  }

  if (row.kind === 'event_reminder') {
    const startsAt = payload.starts_at ? new Date(payload.starts_at) : null;
    const embed = embeds.embed({
      color: 0xfee75c,
      title: `📅 ${payload.name || 'Event'} starts soon`,
      description: payload.description || 'The event is about to begin.',
    });
    embed.addFields(
      { name: 'Starts', value: startsAt ? helpers.timestamp(startsAt, 'R') : 'soon', inline: true },
    );
    if (payload.location) embed.addFields({ name: 'Where', value: String(payload.location), inline: true });
    await channel.send({
      content: payload.role_mention ? payload.role_mention : undefined,
      embeds: [embed],
    });
    return;
  }

  throw new Error(`unknown scheduled task kind "${row.kind}"`);
}

// ---------------------------------------------------------------------------
// Task: giveaway endings
// ---------------------------------------------------------------------------

/** Find giveaways whose time is up and draw them. */
async function runGiveawayEndings(client) {
  const db = require('../db');
  const giveaways = require('../modules/giveaways/giveaway-service');

  const due = await db.select('giveaways', {
    where: { status: 'running' },
    limit: BATCH_SIZE,
    optional: true,
    fallback: [],
  });

  const now = Date.now();
  for (const giveaway of due) {
    if (new Date(giveaway.ends_at).getTime() > now) continue;

    // Claim: only one tick can move running -> ending.
    const claimed = await db.update('giveaways', { id: giveaway.id, status: 'running' }, { status: 'ended' })
      .catch(() => []);
    if (claimed.length === 0) continue;

    try {
      await giveaways.finish(client, giveaway.id);
    } catch (error) {
      log.error(`giveaway ${giveaway.id} could not be finished:`, error);
      // Put it back so a later tick retries.
      await db.update('giveaways', { id: giveaway.id }, { status: 'running' }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Task: tempban expiry
// ---------------------------------------------------------------------------

/** Lift temporary bans whose time has passed. */
async function runTempbanExpiry(client) {
  const db = require('../db');
  const moderation = require('../modules/moderation/moderation-service');

  const expired = await db.select('mod_cases', {
    where: { action: 'tempban', active: true },
    limit: BATCH_SIZE,
    optional: true,
    fallback: [],
  });

  const now = Date.now();
  for (const row of expired) {
    if (!row.expires_at) continue;
    if (new Date(row.expires_at).getTime() > now) continue;

    // Claim before acting so two ticks cannot both unban.
    const claimed = await db.update('mod_cases', { id: row.id, active: true }, { active: false }).catch(() => []);
    if (claimed.length === 0) continue;

    try {
      await moderation.liftTempban(client, row);
    } catch (error) {
      log.error(`tempban ${row.id} could not be lifted:`, error);
      await db.update('mod_cases', { id: row.id }, { active: true }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Task: event reminders
// ---------------------------------------------------------------------------

/** Send the reminder for events whose lead time has arrived. */
async function runEventReminders(client) {
  const db = require('../db');

  const events = await db.select('events', {
    where: { status: 'scheduled', reminder_sent: false },
    limit: BATCH_SIZE,
    optional: true,
    fallback: [],
  });

  const now = Date.now();

  for (const event of events) {
    const startsAt = new Date(event.starts_at).getTime();
    const remindAt = startsAt - (Number(event.remind_before) || 900) * 1000;
    if (now < remindAt) continue;

    const claimed = await db.update(
      'events',
      { id: event.id, reminder_sent: false },
      { reminder_sent: true },
    ).catch(() => []);
    if (claimed.length === 0) continue;

    try {
      const channelId = event.channel_id;
      if (!channelId) continue;
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) continue;

      const embed = embeds.embed({
        color: 0xfee75c,
        title: `📅 ${event.name} starts ${helpers.timestamp(new Date(event.starts_at), 'R')}`,
        description: event.description || 'See you there!',
      });
      embed.addFields({ name: 'Host', value: `<@${event.host_id}>`, inline: true });
      if (event.location) embed.addFields({ name: 'Where', value: String(event.location), inline: true });

      await channel.send({ embeds: [embed] });
    } catch (error) {
      log.warn(`event reminder ${event.id} failed: ${error.message}`);
      await db.update('events', { id: event.id }, { reminder_sent: false }).catch(() => {});
    }
  }

  // Mark events that have already started as done.
  const started = await db.select('events', {
    where: { status: 'scheduled' },
    limit: BATCH_SIZE,
    optional: true,
    fallback: [],
  });

  for (const event of started) {
    if (new Date(event.starts_at).getTime() + 3_600_000 < now) {
      await db.update('events', { id: event.id }, { status: 'done' }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Task: level reward reconciliation
// ---------------------------------------------------------------------------

/**
 * Grants level roles to members who have earned them but do not have the role.
 *
 * This exists because role rewards are also granted at level-up time; a member
 * who was offline, or whose award failed, would otherwise never receive it.
 * Running it on a slow cadence makes the system self-healing.
 */
async function runLevelRewards(client) {
  const db = require('../db');

  // Only reconcile every ~20 ticks to keep the query load low.
  if (tickCount % 20 !== 0) return;

  for (const guild of client.guilds.cache.values()) {
    try {
      const rewards = await db.select('level_rewards', {
        where: { guild_id: guild.id },
        optional: true,
        fallback: [],
      });
      if (rewards.length === 0) continue;

      const members = await guild.members.fetch().catch(() => null);
      if (!members) continue;

      const leveling = require('../modules/levels/leveling');
      for (const member of members.values()) {
        if (member.user.bot) continue;
        await leveling.applyRewards(member, { silent: true }).catch(() => {});
      }
    } catch (error) {
      log.debug(`level reward reconcile failed for ${guild.id}: ${error.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  start,
  stop,
  tick,
  isRunning,
  runScheduledTasks,
  runGiveawayEndings,
  runTempbanExpiry,
  runEventReminders,
  deliverScheduledTask,
  MAX_ATTEMPTS,
};
