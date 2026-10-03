'use strict';

/**
 * Discord client construction.
 *
 * Intents are listed explicitly and matched against what the code actually
 * reads, because requesting privileges you do not use is a good way to fail
 * verification:
 *
 *   Guilds                    - base, required for everything
 *   GuildMembers              - PRIVILEGED, join/leave logs, autorole, member info
 *   GuildModeration           - PRIVILEGED, ban add/remove logging
 *   GuildMessages             - PRIVILEGED, prefix commands + XP + autoresponders
 *   MessageContent            - PRIVILEGED, required to read prefix command text
 *   GuildMessageReactions     - reaction roles
 *   GuildVoiceStates          - voice session tracking and voice logs
 *   GuildInvites              - invite create/delete tracking and /invites
 *   GuildEmojisAndStickers    - emoji update logging
 *   GuildScheduledEvents      - scheduled event logging
 *   GuildWebhooks             - webhook update logging (used by /logs server)
 *
 * MessageContent, GuildMembers and GuildModeration (plus PresenceUpdate if you
 * add it) must be switched ON in the Developer Portal - see the README.
 */

const { Client, GatewayIntentBits, Partials, Options } = require('discord.js');
const logger = require('../lib/logger');

const log = logger.child('client');

/** The intents this bot needs, each with the reason it is requested. */
const REQUIRED_INTENTS = [
  { intent: GatewayIntentBits.Guilds, reason: 'Core guild, channel and command handling' },
  { intent: GatewayIntentBits.GuildMembers, reason: 'Join/leave logging, autorole, member lookups', privileged: true },
  { intent: GatewayIntentBits.GuildModeration, reason: 'Ban add/remove logging', privileged: true },
  { intent: GatewayIntentBits.GuildMessages, reason: 'Prefix commands, XP, autoresponders', privileged: true },
  { intent: GatewayIntentBits.MessageContent, reason: 'Reading prefix command text', privileged: true },
  { intent: GatewayIntentBits.GuildMessageReactions, reason: 'Reaction roles' },
  { intent: GatewayIntentBits.GuildVoiceStates, reason: 'Voice time tracking and voice logs' },
  { intent: GatewayIntentBits.GuildInvites, reason: 'Invite tracking and /invites' },
  { intent: GatewayIntentBits.GuildEmojisAndStickers, reason: 'Emoji and sticker update logging' },
  { intent: GatewayIntentBits.GuildScheduledEvents, reason: 'Scheduled event logging' },
  { intent: GatewayIntentBits.GuildWebhooks, reason: 'Webhook update logging' },
];

/**
 * Create the client.
 * @param {{ onWarn?: (message: string) => void }} [options]
 */
function createClient(options = {}) {
  const { onWarn } = options;

  const client = new Client({
    intents: REQUIRED_INTENTS.map((entry) => entry.intent),
    partials: [
      Partials.Channel,   // DM channels for the prefix guard
      Partials.Message,   // uncached messages for reaction roles
      Partials.Reaction,  // reaction events on old messages
      Partials.GuildMember, // members who joined while offline
      Partials.User,      // users not in cache
    ],
    // Keep the default cache behaviour, but cap message caching so a busy
    // server cannot grow the heap without bound.
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 100,
      PresenceManager: 0,
      GuildMemberManager: {
        maxSize: 500,
        keepOverLimit: (member) => member.id === member.client.user?.id,
      },
      ReactionManager: 50,
      ThreadManager: 50,
    }),
    // A private bot does not need presence fan-out for offline members.
    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 900, lifetime: 3600 },
      users: { interval: 3600, filter: () => (user) => user.bot && user.id !== user.client.user?.id },
    },
    rest: {
      // Retry politely on 429 rather than dropping user-visible responses.
      retries: 3,
      timeout: 15_000,
    },
    allowedMentions: { parse: ['users', 'roles'], repliedUser: true },
  });

  // Surface library warnings (deprecations, rate limit notices) once.
  client.on('warn', (message) => {
    log.warn(message);
    onWarn?.(message);
  });

  client.on('error', (error) => log.error('client error:', error));
  client.on('shardError', (error) => log.error('shard error:', error));
  client.on('invalidated', () => log.error('session invalidated - a new login will be required'));

  return client;
}

/**
 * Verify the granted intents match what the code expects.
 * Discord reports missing privileged intents as a close code 4014 on login.
 *
 * @param {import('discord.js').Client} client
 */
function describeIntentStatus(client) {
  const granted = client.options.intents;
  return REQUIRED_INTENTS.map((entry) => ({
    name: GatewayIntentBits[entry.intent] ?? String(entry.intent),
    reason: entry.reason,
    privileged: entry.privileged === true,
    granted: typeof granted?.has === 'function' ? granted.has(entry.intent) : null,
  }));
}

module.exports = {
  createClient,
  describeIntentStatus,
  REQUIRED_INTENTS,
};
