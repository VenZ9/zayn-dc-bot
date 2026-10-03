'use strict';

/**
 * Reaction roles.
 *
 * A message can carry one or more emoji → role mappings. Reacting toggles the
 * role. Called by the guild event handlers on reaction add / remove.
 *
 * Table: reaction_roles (message_id, emoji unique)
 * Modes:
 *   toggle  react adds, unreact removes (default)
 *   add     reacting only ever adds
 *   remove  reacting only ever removes
 *   unique  reacting removes any other role in the same group first
 */

const logger = require('../../lib/logger');

const log = logger.child('reaction-roles');

/** The stored emoji key for a reaction, matching what was saved. */
function emojiKey(reaction) {
  const emoji = reaction.emoji;
  if (!emoji) return null;
  return emoji.id ? String(emoji.id) : String(emoji.name);
}

/** Every mapping on a message. */
async function mappingsFor(messageId) {
  const db = require('../../db');
  return db.select('reaction_roles', {
    where: { message_id: messageId },
    limit: 100,
    optional: true,
    fallback: [],
  });
}

/** Find the mapping that matches this reaction. */
function findMapping(rows, reaction) {
  const id = reaction.emoji?.id ? String(reaction.emoji.id) : null;
  const name = reaction.emoji?.name ? String(reaction.emoji.name) : null;

  return rows.find((row) => row.emoji === id
    || row.emoji === name
    || row.emoji === `<:${name}:${id}>`) ?? null;
}

/**
 * React to add or remove a role.
 *
 * @param {import('discord.js').MessageReaction} reaction
 * @param {import('discord.js').User} user
 * @param {'add'|'remove'} mode
 */
async function onReaction(reaction, user, mode) {
  if (!user || user.bot) return false;

  // Partials: fetch the full message when it is not cached.
  const message = reaction.message?.partial
    ? await reaction.message.fetch().catch(() => null)
    : reaction.message;
  if (!message || !message.guild) return false;

  const rows = await mappingsFor(message.id).catch(() => []);
  if (rows.length === 0) return false;

  const mapping = findMapping(rows, reaction);
  if (!mapping) return false;

  const member = await message.guild.members.fetch(user.id).catch(() => null);
  if (!member) return false;

  const role = message.guild.roles.cache.get(mapping.role_id)
    ?? await message.guild.roles.fetch(mapping.role_id).catch(() => null);

  if (!role) {
    log.warn(`reaction role ${mapping.role_id} no longer exists`);
    return false;
  }

  const me = message.guild.members.me;
  if (me && me.roles.highest.position <= role.position) {
    log.warn(`cannot manage reaction role ${role.id} - it is above my highest role`);
    return false;
  }

  const has = member.roles.cache.has(role.id);

  try {
    if (mode === 'add') {
      if (mapping.mode === 'remove') {
        if (has) await member.roles.remove(role, 'Reaction role');
        return true;
      }

      if (mapping.mode === 'toggle' && has) {
        await member.roles.remove(role, 'Reaction role');
        return true;
      }

      if (!has) {
        // In unique mode, drop the member's other roles from the same group.
        if (mapping.mode === 'unique' && mapping.group_key) {
          const siblings = rows.filter((row) => row.group_key === mapping.group_key && row.role_id !== role.id);
          for (const sibling of siblings) {
            if (member.roles.cache.has(sibling.role_id)) {
              // eslint-disable-next-line no-await-in-loop
              await member.roles.remove(sibling.role_id, 'Reaction role (unique group)').catch(() => {});
            }
          }
        }
        await member.roles.add(role, 'Reaction role');
      }
    } else if (mapping.mode !== 'add') {
      // mode === 'remove': unreacting removes the role.
      if (has) await member.roles.remove(role, 'Reaction role');
    }
  } catch (error) {
    log.warn(`reaction role update failed for ${user.id}:`, error.message);
    return false;
  }

  return true;
}

/**
 * The message was cleared of all reactions - drop every mapped role from every
 * member who held one is not feasible cheaply, so this is a no-op that exists to
 * satisfy the event contract.
 *
 * @param {import('discord.js').Message} message
 */
async function onReactionRemoveAll(message) {
  const rows = await mappingsFor(message.id).catch(() => []);
  if (rows.length === 0) return false;
  log.debug(`${rows.length} reaction role mapping(s) left on cleared message ${message.id}`);
  return true;
}

module.exports = { onReaction, onReactionRemoveAll, mappingsFor, emojiKey };
