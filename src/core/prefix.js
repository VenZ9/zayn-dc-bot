'use strict';

/**
 * Prefix command runner.
 *
 * Turns a plain message into the same Context a slash command would produce, so
 * handlers are shared. Responsibilities:
 *
 *   1. ignore bots, DMs, webhooks and system messages
 *   2. match the guild's prefix (with an optional mention fallback)
 *   3. resolve the command by name or alias
 *   4. resolve mention / ID / name tokens into guild entities
 *   5. run the shared pipeline
 *   6. optionally remove the trigger message
 *
 * It also reaches into a few non-command behaviours that only make sense on
 * messageCreate (autoresponders, custom commands, XP). Those are invoked
 * separately by the messageCreate event so this file stays about commands.
 */

const logger = require('../lib/logger');
const embeds = require('../lib/embeds');
const helpers = require('../lib/helpers');
const config = require('../config');
const context = require('./context');
const handler = require('./handler');
const { parseArgs } = require('./command');

const log = logger.child('prefix');

// ---------------------------------------------------------------------------
// Entry guard
// ---------------------------------------------------------------------------

/**
 * Should this message be considered for prefix parsing at all?
 * @param {import('discord.js').Message} message
 */
function shouldHandle(message) {
  if (!message || !message.content) return false;
  if (!message.guild) return false;                       // DMs unsupported
  if (message.author?.bot || message.webhookId) return false;
  if (message.system) return false;
  return true;
}

/**
 * Strip the prefix from a message.
 *
 * Accepts the configured prefix, or a direct bot mention in its place - so both
 * `.ping` and `@Bot ping` work. A mention prefix keeps its space, a text prefix
 * does not.
 *
 * @param {string} content
 * @param {string} prefix
 * @param {string} botId
 * @returns {{ matched: boolean, body: string, viaMention: boolean }}
 */
function stripPrefix(content, prefix, botId) {
  // Mention form: <@123> or <@!123>
  const mentionMatch = content.match(/^<@!?(\d+)>\s*/);
  if (mentionMatch && mentionMatch[1] === botId) {
    return { matched: true, body: content.slice(mentionMatch[0].length).trim(), viaMention: true };
  }

  if (!prefix) return { matched: false, body: content, viaMention: false };

  // Case-insensitive so `.PING` works - people type on mobile.
  if (content.toLowerCase().startsWith(prefix.toLowerCase())) {
    return { matched: true, body: content.slice(prefix.length).trim(), viaMention: false };
  }

  return { matched: false, body: content, viaMention: false };
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a user/member token: mention, ID, username, display name or tag.
 * @param {import('discord.js').Guild} guild
 * @param {string} token
 * @returns {Promise<import('discord.js').GuildMember|null>}
 */
async function resolveMember(guild, token) {
  if (!token) return null;
  const text = String(token).trim();

  const id = helpers.extractId(text);
  if (id) {
    const cached = guild.members.cache.get(id);
    if (cached) return cached;
    return guild.members.fetch(id).catch(() => null);
  }

  const lowered = text.toLowerCase().replace(/^@/, '');

  // Exact username / tag / display name, then a contains match.
  const members = guild.members.cache;
  const exact = members.find((member) =>
    member.user.username.toLowerCase() === lowered
    || member.user.tag?.toLowerCase() === lowered
    || member.displayName.toLowerCase() === lowered);
  if (exact) return exact;

  const partial = members.find((member) =>
    member.user.username.toLowerCase().startsWith(lowered)
    || member.displayName.toLowerCase().startsWith(lowered));
  if (partial) return partial;

  // Last resort: query the API, useful when the member cache is cold.
  try {
    const fetched = await guild.members.fetch({ query: text, limit: 1 });
    return fetched.first() ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a role token: mention, ID or name.
 * @param {import('discord.js').Guild} guild
 * @param {string} token
 */
function resolveRole(guild, token) {
  if (!token) return null;
  const text = String(token).trim();

  const id = helpers.extractId(text);
  if (id) return guild.roles.cache.get(id) ?? null;

  const lowered = text.toLowerCase().replace(/^@/, '');
  return guild.roles.cache.find((role) => role.name.toLowerCase() === lowered)
    ?? guild.roles.cache.find((role) => role.name.toLowerCase().startsWith(lowered))
    ?? null;
}

/**
 * Resolve a channel token: mention, ID or name.
 * @param {import('discord.js').Guild} guild
 * @param {string} token
 */
function resolveChannel(guild, token) {
  if (!token) return null;
  const text = String(token).trim();

  const id = helpers.extractId(text);
  if (id) return guild.channels.cache.get(id) ?? null;

  const lowered = text.toLowerCase().replace(/^#/, '');
  return guild.channels.cache.find((channel) => channel.name?.toLowerCase() === lowered)
    ?? guild.channels.cache.find((channel) => channel.name?.toLowerCase().startsWith(lowered))
    ?? null;
}

/**
 * Walk the parsed arguments and replace entity tokens with real objects.
 *
 * Values that cannot be resolved are set to `null` so handlers can detect the
 * miss and produce a specific error instead of string-comparing.
 *
 * @param {object} command
 * @param {object} parsed result of parseArgs
 * @param {import('discord.js').Guild} guild
 */
async function resolveArgs(command, parsed, guild) {
  const spec = findArgSpec(command, parsed.subcommand);
  const resolved = { ...parsed.args };

  for (const arg of spec) {
    const value = resolved[arg.name];
    if (value === undefined || value === null) continue;

    // Skip anything the parser already turned into a real type.
    if (typeof value !== 'string') continue;

    switch (arg.type) {
      case 'user':
      case 'member': {
        resolved[arg.name] = await resolveMember(guild, value);
        break;
      }
      case 'role': {
        resolved[arg.name] = resolveRole(guild, value);
        break;
      }
      case 'channel': {
        resolved[arg.name] = resolveChannel(guild, value);
        break;
      }
      default:
        break;
    }
  }

  return resolved;
}

/** Find the argument spec for the active subcommand (or the flat list). */
function findArgSpec(command, subcommand) {
  if (!subcommand) return command.args || [];

  if (Array.isArray(command.groups) && subcommand.group) {
    const group = command.groups.find((candidate) => candidate.name === subcommand.group);
    const sub = (group?.subcommands || []).find((candidate) => candidate.name === subcommand.name);
    return sub?.args || [];
  }

  if (Array.isArray(command.subcommands) && subcommand.name) {
    const sub = command.subcommands.find((candidate) => candidate.name === subcommand.name);
    return sub?.args || [];
  }

  return command.args || [];
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Try to run a prefix command from a message.
 *
 * @param {import('discord.js').Message} message
 * @param {{ commands: Map<string, object>, aliases: Map<string, string>, resolve: Function }} registry
 * @returns {Promise<{ handled: boolean, reason?: string }>}
 */
async function handleMessage(message, registry) {
  if (!shouldHandle(message)) return { handled: false, reason: 'ignored' };

  const db = require('../db');
  const prefixInfo = await db.getPrefix(message.guild.id);
  if (!prefixInfo.enabled) return { handled: false, reason: 'prefix_disabled' };

  const stripped = stripPrefix(message.content, prefixInfo.prefix, message.client.user.id);
  if (!stripped.matched || !stripped.body) return { handled: false, reason: 'no_prefix' };

  // ---- resolve command name ----------------------------------------------
  const tokens = splitTokens(stripped.body);
  const name = tokens[0]?.toLowerCase();
  if (!name) return { handled: false, reason: 'no_command' };

  const command = registry.resolve(name);

  // Not a command - leave it for the custom command / autoresponder layer.
  if (!command) return { handled: false, reason: 'unknown', name };

  if (command.prefixEnabled === false) {
    await message.reply({
      embeds: [
        embeds.warning(
          'Slash command only',
          `\`${command.name}\` can only be used as \`/${command.name}\`.`,
        ),
      ],
    }).catch(() => {});
    return { handled: true, reason: 'slash_only' };
  }

  // ---- parse ---------------------------------------------------------------
  const parsed = parseArgs(command, tokens.slice(1));
  const resolvedArgs = await resolveArgs(command, parsed, message.guild);

  const guildConfig = await db.getGuildConfig(message.guild.id).catch(() => ({}));

  const ctx = context.fromMessage(message, command, guildConfig, {
    args: resolvedArgs,
    rawArgs: parsed.rawArgs,
    subcommand: parsed.subcommand,
  });

  // Honour a per-command delete preference as well as the guild setting.
  if (command.deleteTrigger) ctx.autoDeleteTrigger = true;

  // ---- run -----------------------------------------------------------------
  const result = await handler.runCommand(ctx, command);

  if (result.ok) {
    await handler.recordUsage(message.guild.id);
    await ctx.cleanupTrigger();
  }

  return { handled: true, reason: result.ok ? 'ok' : result.reason };
}

/**
 * Split a command body into tokens, keeping quoted groups together so
 * `.custom add "hello world" Hello there` parses sensibly.
 * @param {string} body
 */
function splitTokens(body) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;

  while ((match = pattern.exec(body)) !== null) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined) tokens.push(value);
  }

  return tokens;
}

module.exports = {
  handleMessage,
  shouldHandle,
  stripPrefix,
  splitTokens,
  resolveMember,
  resolveRole,
  resolveChannel,
  resolveArgs,
  findArgSpec,
};
