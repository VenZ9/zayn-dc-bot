'use strict';

/**
 * Logging-oriented gateway events.
 *
 * Each handler is a thin wrapper: everything it does is delegate to the logging
 * service, which decides whether the guild has that event enabled and where to
 * send it. That keeps this file short and means adding an event type only
 * touches the logging module.
 */

const { Events } = require('discord.js');
const logger = require('../lib/logger');

const log = logger.child('events');

/** Build an event handler that forwards to a logging service method. */
function forward(eventName, method, { args = 'auto' } = {}) {
  return {
    name: eventName,
    async execute(client, ...received) {
      try {
        const logging = require('../modules/logs/logger');
        if (typeof logging[method] !== 'function') return;
        await logging[method](...received);
      } catch (error) {
        log.error(`${method} failed:`, error);
      }
    },
    meta: { method, args },
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const messageDelete = forward(Events.MessageDelete, 'onMessageDelete');
const messageUpdate = forward(Events.MessageUpdate, 'onMessageUpdate');
const messageDeleteBulk = forward(Events.MessageBulkDelete, 'onMessageBulkDelete');

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

const channelCreate = forward(Events.ChannelCreate, 'onChannelCreate');
const channelDelete = forward(Events.ChannelDelete, 'onChannelDelete');
const channelUpdate = forward(Events.ChannelUpdate, 'onChannelUpdate');

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

const roleCreate = forward(Events.GuildRoleCreate, 'onRoleCreate');
const roleDelete = forward(Events.GuildRoleDelete, 'onRoleDelete');
const roleUpdate = forward(Events.GuildRoleUpdate, 'onRoleUpdate');

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

const banAdd = forward(Events.GuildBanAdd, 'onBanAdd');
const banRemove = forward(Events.GuildBanRemove, 'onBanRemove');

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const guildUpdate = forward(Events.GuildUpdate, 'onGuildUpdate');
const emojiUpdate = forward(Events.GuildEmojisUpdate, 'onEmojiUpdate');

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

const inviteCreate = forward(Events.InviteCreate, 'onInviteCreate');
const inviteDelete = forward(Events.InviteDelete, 'onInviteDelete');

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

const voiceStateUpdate = {
  name: Events.VoiceStateUpdate,
  async execute(client, before, after) {
    // The voice tracker owns session bookkeeping (voice XP, analytics), while
    // the logger owns the user-facing embed. Both must run.
    try {
      const tracker = require('../modules/logs/voice-tracker');
      await tracker.onVoiceStateUpdate(before, after);
    } catch (error) {
      log.error('voice tracking failed:', error);
    }

    try {
      const logging = require('../modules/logs/logger');
      await logging.onVoiceStateUpdate(before, after);
    } catch (error) {
      log.error('voice logging failed:', error);
    }
  },
};

// ---------------------------------------------------------------------------
// Scheduled events
// ---------------------------------------------------------------------------

const scheduledEventCreate = forward(Events.GuildScheduledEventCreate, 'onScheduledEventCreate');
const scheduledEventDelete = forward(Events.GuildScheduledEventDelete, 'onScheduledEventDelete');
const scheduledEventUpdate = forward(Events.GuildScheduledEventUpdate, 'onScheduledEventUpdate');

// ---------------------------------------------------------------------------
// Reactions (reaction roles live here, not in the logging module)
// ---------------------------------------------------------------------------

const messageReactionAdd = {
  name: Events.MessageReactionAdd,
  async execute(client, reaction, user) {
    try {
      const reactionRoles = require('../modules/roles/reaction-roles');
      await reactionRoles.onReaction(reaction, user, 'add');
    } catch (error) {
      log.error('reaction role add failed:', error);
    }
  },
};

const messageReactionRemove = {
  name: Events.MessageReactionRemove,
  async execute(client, reaction, user) {
    try {
      const reactionRoles = require('../modules/roles/reaction-roles');
      await reactionRoles.onReaction(reaction, user, 'remove');
    } catch (error) {
      log.error('reaction role remove failed:', error);
    }
  },
};

const reactionRemoveAll = {
  name: Events.MessageReactionRemoveAll,
  async execute(client, message, reactions) {
    try {
      const reactionRoles = require('../modules/roles/reaction-roles');
      await reactionRoles.onReactionRemoveAll(message);
    } catch (error) {
      log.debug('reaction clear failed:', error.message);
    }
    void reactions;
  },
};

// ---------------------------------------------------------------------------
// Interaction failures
// ---------------------------------------------------------------------------

const interactionError = {
  name: Events.InteractionCreate,
  once: true,
  async execute() {
    // Placeholder so the loader has something to attach; the real handling is
    // in interactionCreate.js. Kept out of the list below.
  },
  hidden: true,
};

module.exports = [
  messageDelete,
  messageUpdate,
  messageDeleteBulk,
  channelCreate,
  channelDelete,
  channelUpdate,
  roleCreate,
  roleDelete,
  roleUpdate,
  banAdd,
  banRemove,
  guildUpdate,
  emojiUpdate,
  inviteCreate,
  inviteDelete,
  voiceStateUpdate,
  scheduledEventCreate,
  scheduledEventDelete,
  scheduledEventUpdate,
  messageReactionAdd,
  messageReactionRemove,
  reactionRemoveAll,
  interactionError,
].filter((handler) => !handler.hidden);
