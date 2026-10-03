'use strict';

/**
 * Member lifecycle: join, leave, update.
 *
 * Kept in one file because the three share the welcome/goodbye configuration
 * lookup and the analytics counters.
 */

const { Events } = require('discord.js');
const logger = require('../lib/logger');
const helpers = require('../lib/helpers');

const log = logger.child('members');

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

const guildMemberAdd = {
  name: Events.GuildMemberAdd,
  async execute(client, member) {
    const guildId = member.guild.id;

    // ---- analytics -------------------------------------------------------
    try {
      const db = require('../db');
      await db.rpc('bump_analytics', {
        p_guild_id: guildId,
        p_day: helpers.today(),
        p_joins: 1,
      }, { optional: true });
    } catch (error) {
      log.debug('join counter failed:', error.message);
    }

    // ---- autorole --------------------------------------------------------
    try {
      const welcome = require('../modules/welcome/welcome-service');
      await welcome.onMemberJoin(member);
    } catch (error) {
      log.error('welcome/onMemberJoin failed:', error);
    }

    // ---- member snapshot for retention ------------------------------------
    try {
      const db = require('../db');
      await db.upsert('member_snapshots', {
        guild_id: guildId,
        day: helpers.today(),
        member_count: member.guild.memberCount,
      }, 'guild_id,day');
    } catch (error) {
      log.debug('snapshot upsert failed:', error.message);
    }

    // ---- invite attribution ----------------------------------------------
    try {
      const invites = require('../modules/server/invite-tracker');
      await invites.onMemberAdd(member);
    } catch (error) {
      log.debug('invite tracking failed:', error.message);
    }

    // ---- logging ---------------------------------------------------------
    try {
      const logging = require('../modules/logs/logger');
      await logging.onMemberAdd(member);
    } catch (error) {
      log.error('member join logging failed:', error);
    }
  },
};

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

const guildMemberRemove = {
  name: Events.GuildMemberRemove,
  async execute(client, member) {
    const guildId = member.guild.id;

    try {
      const db = require('../db');
      await db.rpc('bump_analytics', {
        p_guild_id: guildId,
        p_day: helpers.today(),
        p_leaves: 1,
      }, { optional: true });
    } catch (error) {
      log.debug('leave counter failed:', error.message);
    }

    // Any open voice session for the departing member must be closed, or it
    // would accumulate for ever.
    try {
      const voice = require('../modules/logs/voice-tracker');
      await voice.closeForUser(guildId, member.id);
    } catch (error) {
      log.debug('voice session close failed:', error.message);
    }

    try {
      const welcome = require('../modules/welcome/welcome-service');
      await welcome.onMemberLeave(member);
    } catch (error) {
      log.error('welcome/onMemberLeave failed:', error);
    }

    try {
      const logging = require('../modules/logs/logger');
      await logging.onMemberRemove(member);
    } catch (error) {
      log.error('member leave logging failed:', error);
    }
  },
};

// ---------------------------------------------------------------------------
// Update (nickname, roles, boost status)
// ---------------------------------------------------------------------------

const guildMemberUpdate = {
  name: Events.GuildMemberUpdate,
  async execute(client, before, after) {
    try {
      const logging = require('../modules/logs/logger');
      await logging.onMemberUpdate(before, after);
    } catch (error) {
      log.error('member update logging failed:', error);
    }

    // Boosting someone should grant the booster badge.
    if (!before.premiumSince && after.premiumSince) {
      try {
        const profiles = require('../modules/profile/profile-store');
        await profiles.addBadge(after.id, 'booster');
      } catch (error) {
        log.debug('booster badge failed:', error.message);
      }
    }

    // A level check on role change keeps progression consistent after a reset.
    if (before.roles.cache.size !== after.roles.cache.size) {
      try {
        const leveling = require('../modules/levels/leveling');
        await leveling.syncRewards(after);
      } catch (error) {
        log.debug('level reward sync failed:', error.message);
      }
    }
  },
};

module.exports = [guildMemberAdd, guildMemberRemove, guildMemberUpdate];
