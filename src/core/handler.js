'use strict';

/**
 * Shared command execution pipeline.
 *
 * Both the slash runner and the prefix runner call `runCommand`, so all the
 * cross-cutting concerns live in exactly one place:
 *
 *   1. bot can actually send in this channel
 *   2. caller passes the Discord permission bits
 *   3. caller holds the bot permission node
 *   4. owner/admin-only enforcement
 *   5. per-user cooldown
 *   6. handler execution with a single error funnel
 *
 * If any of these were duplicated per runner they would drift, and a permission
 * check missing from the prefix path is exactly the kind of bug that gets a bot
 * kicked from a server.
 */

const config = require('../config');
const logger = require('../lib/logger');
const embeds = require('../lib/embeds');
const permissions = require('../lib/permissions');
const helpers = require('../lib/helpers');

const log = logger.child('handler');

// ---------------------------------------------------------------------------
// Cooldowns
// ---------------------------------------------------------------------------

/**
 * In-memory cooldown store, keyed `${commandName}:${userId}`.
 *
 * Deliberately not persisted: a restart clearing cooldowns is harmless, and
 * avoiding a database round trip on every command keeps the hot path fast.
 */
const cooldowns = new Map();

/**
 * @returns {{ limited: boolean, remainingMs: number }}
 */
function checkCooldown(commandName, userId, seconds) {
  if (!seconds || seconds <= 0) return { limited: false, remainingMs: 0 };

  const key = `${commandName}:${userId}`;
  const now = Date.now();
  const expiresAt = cooldowns.get(key);

  if (expiresAt && expiresAt > now) {
    return { limited: true, remainingMs: expiresAt - now };
  }

  cooldowns.set(key, now + seconds * 1000);
  return { limited: false, remainingMs: 0 };
}

/** Drop expired entries so the map cannot grow without bound. */
function sweepCooldowns() {
  const now = Date.now();
  for (const [key, expiresAt] of cooldowns) {
    if (expiresAt <= now) cooldowns.delete(key);
  }
}

// Periodically shed expired keys. unref so it never holds the process open.
const cooldownSweeper = setInterval(sweepCooldowns, 300_000);
if (typeof cooldownSweeper.unref === 'function') cooldownSweeper.unref();

/** Exposed for tests. */
function clearCooldowns() {
  cooldowns.clear();
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Run a command with every pre-flight check applied.
 *
 * @param {import('./context').Context} ctx
 * @param {object} command
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function runCommand(ctx, command) {
  const startedAt = Date.now();

  // ---- 1. can the bot respond here? -------------------------------------
  const canSend = ctx.canSend();
  if (!canSend.ok) {
    await ctx.reply({ embeds: [embeds.error('Cannot respond here', canSend.reason)] }).catch(() => {});
    return { ok: false, reason: 'cannot_send' };
  }

  // ---- 2 & 3. authorisation ---------------------------------------------
  const authorisation = permissions.check({
    member: ctx.member,
    guildConfig: ctx.guildConfig,
    node: command.node,
    userPerms: command.userPerms,
    guildOnly: command.guildOnly,
  });

  if (!authorisation.ok) {
    await ctx.deny(authorisation.reason);
    await logDenial(ctx, command, authorisation);
    return { ok: false, reason: authorisation.code };
  }

  // ---- 4. owner / admin only --------------------------------------------
  if (command.ownerOnly && !ctx.isAdmin()) {
    await ctx.deny('This command is restricted to the bot owner.');
    return { ok: false, reason: 'owner_only' };
  }

  if (command.adminOnly && !ctx.isAdmin()) {
    await ctx.deny('This command is restricted to server administrators.');
    return { ok: false, reason: 'admin_only' };
  }

  // ---- 5. cooldown -------------------------------------------------------
  const cooldown = checkCooldown(command.name, ctx.userId, command.cooldown);
  if (cooldown.limited) {
    const remaining = Math.ceil(cooldown.remainingMs / 1000);
    await ctx.reply({
      embeds: [embeds.warning('Slow down', `You can use this again in **${remaining}s**.`)],
      ephemeral: true,
    }).catch(() => {});
    return { ok: false, reason: 'cooldown' };
  }

  // ---- 6. execute --------------------------------------------------------
  try {
    await command.run(ctx);
  } catch (error) {
    await ctx.fail(error).catch(() => {});
    return { ok: false, reason: 'threw' };
  }

  log.debug(
    `${ctx.kind} ${command.name} ok in ${Date.now() - startedAt}ms `
    + `(guild=${ctx.guildId ?? 'dm'} user=${ctx.userId})`,
  );

  return { ok: true };
}

/** Record a denied attempt, so staff can see who is probing what. */
async function logDenial(ctx, command, authorisation) {
  log.debug(
    `denied ${command.name} for ${ctx.userId} in ${ctx.guildId ?? 'dm'}: ${authorisation.reason}`,
  );

  // Only worth persisting when there is a guild and a real node requirement.
  if (!ctx.guildId || !config.hasDatabase) return;
  if (authorisation.code === 'no_guild') return;

  try {
    const db = require('../db');
    await db.writeAudit({
      guildId: ctx.guildId,
      actorId: ctx.userId,
      actorTag: ctx.user.tag ?? ctx.user.username,
      action: 'command.denied',
      targetType: 'command',
      targetId: command.name,
      details: { reason: authorisation.reason, code: authorisation.code },
      source: ctx.kind,
    });
  } catch {
    // Never let auditing break the denial path.
  }
}

/**
 * Increment the guild's command counter. Fire and forget.
 * @param {string} guildId
 */
async function recordUsage(guildId) {
  if (!guildId || !config.hasDatabase) return;
  try {
    const db = require('../db');
    await db.rpc('bump_analytics', {
      p_guild_id: guildId,
      p_day: helpers.today(),
      p_commands: 1,
    }, { optional: true });
  } catch {
    // Analytics must never break a command.
  }
}

module.exports = {
  runCommand,
  checkCooldown,
  clearCooldowns,
  sweepCooldowns,
  recordUsage,
};
