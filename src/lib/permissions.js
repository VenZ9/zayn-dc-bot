'use strict';

/**
 * Permission system.
 *
 * Two independent gates, both must pass:
 *
 *   1. Discord permissions - does the member actually have the capability?
 *   2. Bot permission nodes - is this member allowed to use this feature?
 *
 * Node 2 matters because plain Discord permissions are too coarse: many servers
 * want a "trial moderator" role that can warn and mute but never ban. Nodes are
 * declared per command as e.g. `moderation.warn`, with wildcards supported.
 *
 * Resolution order for a member's nodes:
 *   - BOT_ADMINS env var            -> ['*']  (bypasses everything)
 *   - guild owner                    -> ['*']
 *   - configured admin roles         -> their node list
 *   - fallback                       -> derived from Discord permissions
 */

const { PermissionFlagsBits } = require('discord.js');
const config = require('../config');

// ---------------------------------------------------------------------------
// Node catalogue
// ---------------------------------------------------------------------------

/**
 * Every node the bot understands, grouped by module.
 * `*` grants everything; `moderation.*` grants the whole module.
 */
const NODES = Object.freeze({
  moderation: [
    'moderation.ban', 'moderation.tempban', 'moderation.unban', 'moderation.kick',
    'moderation.mute', 'moderation.unmute', 'moderation.warn', 'moderation.warnings',
    'moderation.clearwarns', 'moderation.purge', 'moderation.slowmode', 'moderation.lock',
    'moderation.unlock', 'moderation.hide', 'moderation.unhide', 'moderation.nick',
    'moderation.note', 'moderation.case', 'moderation.history', 'moderation.reason',
  ],
  config: [
    'config.view', 'config.prefix', 'config.language', 'config.timezone', 'config.modlog',
    'config.muterole', 'config.djrole', 'config.reset', 'config.backup', 'config.setup',
  ],
  analytics: ['analytics.view', 'analytics.export'],
  tickets: [
    'tickets.setup', 'tickets.panel', 'tickets.open', 'tickets.close', 'tickets.add',
    'tickets.remove', 'tickets.rename', 'tickets.claim', 'tickets.transcript',
    'tickets.priority', 'tickets.list', 'tickets.stats',
  ],
  welcome: [
    'welcome.view', 'welcome.channel', 'welcome.message', 'welcome.test', 'welcome.toggle',
    'welcome.image', 'welcome.autorole', 'welcome.dm',
  ],
  roles: [
    'roles.add', 'roles.remove', 'roles.create', 'roles.delete', 'roles.color', 'roles.rename',
    'roles.all', 'roles.humans', 'roles.bots', 'roles.reactionrole', 'roles.menu', 'roles.permissions',
  ],
  giveaways: [
    'giveaways.start', 'giveaways.end', 'giveaways.reroll', 'giveaways.cancel',
    'giveaways.list', 'giveaways.edit', 'giveaways.requirements', 'giveaways.pause',
  ],
  levels: [
    'levels.rank', 'levels.leaderboard', 'levels.add', 'levels.remove', 'levels.set',
    'levels.reset', 'levels.rewards', 'levels.config', 'levels.toggle',
  ],
  events: [
    'events.create', 'events.list', 'events.cancel', 'events.edit', 'events.remind',
    'events.schedule', 'events.remindme', 'events.poll',
  ],
  custom: [
    'custom.add', 'custom.edit', 'custom.delete', 'custom.list', 'custom.info',
    'custom.variables', 'custom.cooldown', 'custom.permissions', 'custom.autoresponder',
  ],
  logs: [
    'logs.setup', 'logs.toggle', 'logs.messages', 'logs.members', 'logs.channels',
    'logs.roles', 'logs.voice', 'logs.moderation', 'logs.server', 'logs.invites',
    'logs.audit', 'logs.ignore',
  ],
  profile: [
    'profile.view', 'profile.bio', 'profile.badges', 'profile.birthday', 'profile.timezone',
    'profile.afk', 'profile.rep', 'profile.stats', 'profile.privacy',
  ],
  server: ['server.info'],
});

/** Flat list of every node. */
const ALL_NODES = Object.freeze(Object.values(NODES).flat());

/** All node names that exist, for `/config backup` validation and tests. */
const NODE_SET = new Set(ALL_NODES);

// ---------------------------------------------------------------------------
// Node matching
// ---------------------------------------------------------------------------

/**
 * Does `held` satisfy `required`?
 *
 * Supports exact nodes, module wildcards (`moderation.*`) and the global
 * wildcard (`*`). Returns true when `required` is falsy, so commands without a
 * declared node are open to anyone with the Discord permission.
 *
 * @param {string[]} held
 * @param {string|string[]|null} required
 */
function hasNode(held, required) {
  if (!required) return true;
  const needed = Array.isArray(required) ? required : [required];
  if (needed.length === 0) return true;

  const set = new Set(held || []);
  if (set.has('*')) return true;

  return needed.some((node) => {
    if (set.has(node)) return true;
    // `moderation.*` matches `moderation.ban`
    const [moduleId] = String(node).split('.');
    return set.has(`${moduleId}.*`);
  });
}

/** Human readable label for a node, falling back to the raw id. */
function describeNode(node) {
  if (node === '*') return 'all modules';
  if (node.endsWith('.*')) {
    const moduleId = node.slice(0, -2);
    return `${moduleId} (all)`;
  }
  return node;
}

// ---------------------------------------------------------------------------
// Discord permission gates
// ---------------------------------------------------------------------------

/** Common permission bundles, referenced by command definitions. */
const PERMS = Object.freeze({
  none: null,
  manageGuild: [PermissionFlagsBits.ManageGuild],
  manageRoles: [PermissionFlagsBits.ManageRoles],
  manageChannels: [PermissionFlagsBits.ManageChannels],
  manageMessages: [PermissionFlagsBits.ManageMessages],
  manageNicknames: [PermissionFlagsBits.ManageNicknames],
  kick: [PermissionFlagsBits.KickMembers],
  ban: [PermissionFlagsBits.BanMembers],
  moderate: [PermissionFlagsBits.ModerateMembers],
  mute: [PermissionFlagsBits.ModerateMembers],
  viewAuditLog: [PermissionFlagsBits.ViewAuditLog],
  administrator: [PermissionFlagsBits.Administrator],
});

/**
 * Resolve the set of nodes a guild member holds.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {object} [guildConfig] row from guild_config; may carry `admin_roles`
 * @returns {string[]}
 */
function resolveNodes(member, guildConfig = {}) {
  if (!member) return [];

  // Env-listed admins bypass every check.
  if (config.adminIds.includes(member.id)) return ['*'];

  // Guild owner always has full access.
  if (member.guild && member.guild.ownerId === member.id) return ['*'];

  // Optional per-guild admin role list stored in config metadata.
  const adminRoles = Array.isArray(guildConfig.admin_roles) ? guildConfig.admin_roles : [];
  if (adminRoles.length > 0 && member.roles?.cache) {
    for (const roleId of adminRoles) {
      if (member.roles.cache.has(roleId)) return ['*'];
    }
  }

  // Otherwise derive from Discord permissions. This keeps the bot usable out
  // of the box: an Administrator is staff, and so is anyone with Ban Members.
  const permissions = member.permissions;
  const nodes = new Set();

  if (!permissions) return [];

  const can = (flag) => permissions.has(flag);

  if (can(PermissionFlagsBits.Administrator)) return ['*'];

  if (can(PermissionFlagsBits.BanMembers)) {
    ['ban', 'tempban', 'unban', 'kick', 'mute', 'unmute', 'warn', 'warnings', 'clearwarns',
      'purge', 'slowmode', 'lock', 'unlock', 'hide', 'unhide', 'nick', 'note', 'case',
      'history', 'reason'].forEach((n) => nodes.add(`moderation.${n}`));
  }

  if (can(PermissionFlagsBits.KickMembers)) {
    ['kick', 'warn', 'warnings', 'clearwarns', 'note', 'case', 'history'].forEach((n) => nodes.add(`moderation.${n}`));
  }

  if (can(PermissionFlagsBits.ModerateMembers)) {
    ['mute', 'unmute', 'warn', 'warnings'].forEach((n) => nodes.add(`moderation.${n}`));
  }

  if (can(PermissionFlagsBits.ManageMessages)) {
    ['purge', 'slowmode', 'warn'].forEach((n) => nodes.add(`moderation.${n}`));
  }

  if (can(PermissionFlagsBits.ManageChannels)) {
    ['lock', 'unlock', 'hide', 'unhide', 'slowmode'].forEach((n) => nodes.add(`moderation.${n}`));
  }

  if (can(PermissionFlagsBits.ManageGuild)) {
    nodes.add('*');
  }

  // Everyone gets the read-only and self-service surfaces.
  ['server.info'].forEach((n) => nodes.add(n));

  return [...nodes];
}

/**
 * Full authorisation check for a command.
 *
 * @param {object} params
 * @param {import('discord.js').GuildMember|null} params.member
 * @param {object} [params.guildConfig]
 * @param {string|string[]|null} [params.node]     bot permission node(s)
 * @param {bigint[]|null} [params.userPerms]        Discord permission bits
 * @param {boolean} [params.guildOnly]
 * @returns {{ ok: boolean, reason: string|null, code: string|null, missingPerms: string[] }}
 */
function check({ member, guildConfig = {}, node = null, userPerms = null, guildOnly = true }) {
  if (guildOnly && !member) {
    return { ok: false, code: 'no_guild', reason: 'This command only works inside a server.', missingPerms: [] };
  }

  if (!member) return { ok: true, reason: null, code: null, missingPerms: [] };

  // DM usage for guild-only commands is already rejected above; here we allow
  // user-self commands in DMs.
  const nodes = resolveNodes(member, guildConfig);

  // 1) Discord permission bits
  const missingPerms = [];
  if (Array.isArray(userPerms) && userPerms.length > 0) {
    for (const bit of userPerms) {
      if (!member.permissions.has(bit)) {
        missingPerms.push(permissionName(bit));
      }
    }
    if (missingPerms.length > 0) {
      return {
        ok: false,
        code: 'missing_discord_perms',
        reason: `You need the ${missingPerms.join(', ')} permission to do that.`,
        missingPerms,
      };
    }
  }

  // 2) Bot permission nodes
  if (!hasNode(nodes, node)) {
    return {
      ok: false,
      code: 'missing_node',
      reason: `You do not have access to \`${describeNode(Array.isArray(node) ? node[0] : node)}\`.`,
      missingPerms: [],
    };
  }

  return { ok: true, reason: null, code: null, missingPerms: [] };
}

/** Turn a permission bit into a readable name. Falls back to the bit value. */
function permissionName(bit) {
  for (const [name, value] of Object.entries(PermissionFlagsBits)) {
    if (value === bit) return prettyPermission(name);
  }
  return String(bit);
}

/** "BanMembers" -> "Ban Members" */
function prettyPermission(name) {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * Check the *bot's* own permissions in a channel, so we can produce a clear
 * error instead of a raw DiscordAPIError.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildBasedChannel|null} channel
 * @param {bigint[]} needed
 * @returns {{ ok: boolean, missing: string[] }}
 */
function checkBotPermissions(guild, channel, needed = []) {
  const me = guild?.members?.me;
  if (!me) return { ok: false, missing: ['Bot member not cached'] };

  const missing = [];
  for (const bit of needed) {
    const has = channel ? channel.permissionsFor(me)?.has(bit) : me.permissions.has(bit);
    if (!has) missing.push(permissionName(bit));
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Can the bot act on this member? Protects against role-hierarchy mistakes.
 *
 * @param {import('discord.js').GuildMember} actor
 * @param {import('discord.js').GuildMember} target
 * @param {import('discord.js').Guild} guild
 * @returns {{ ok: boolean, reason: string|null }}
 */
function checkHierarchy(actor, target, guild) {
  if (!target) return { ok: false, reason: 'That member is not in this server.' };

  if (target.id === guild.ownerId) {
    return { ok: false, reason: 'The server owner cannot be targeted.' };
  }

  if (target.id === guild.client.user.id) {
    return { ok: false, reason: 'I cannot target myself.' };
  }

  const me = guild.members.me;
  if (me && target.roles.highest.position >= me.roles.highest.position) {
    return { ok: false, reason: 'That member has a role equal to or higher than mine, so I cannot act on them.' };
  }

  // Actors may act on members below their own highest role. The guild owner
  // and administrators are already handled by the node resolver.
  if (actor && actor.id !== guild.ownerId) {
    if (target.roles.highest.position >= actor.roles.highest.position) {
      return { ok: false, reason: 'That member has a role equal to or higher than yours, so you cannot act on them.' };
    }
  }

  return { ok: true, reason: null };
}

module.exports = {
  NODES,
  ALL_NODES,
  NODE_SET,
  PERMS,
  hasNode,
  describeNode,
  resolveNodes,
  check,
  checkBotPermissions,
  checkHierarchy,
  permissionName,
  prettyPermission,
};
