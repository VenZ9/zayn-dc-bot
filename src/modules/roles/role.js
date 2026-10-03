'use strict';

/**
 * Module 6 - Roles & Permissions.
 *
 *   /role add | remove | create | delete | color | rename | all | humans |
 *          bots | permissions
 *
 * Every action is gated behind Manage Roles and checked against role
 * hierarchy, so the bot can never be made to edit a role above its own.
 */

const { PermissionFlagsBits } = require('discord.js');
const { defineCommand } = require('../../core/command');
const { PERMS } = require('../../lib/permissions');
const helpers = require('../../lib/helpers');
const embeds = require('../../lib/embeds');
const config = require('../../config');
const { COLORS, LIMITS } = require('../../lib/constants');

const role = defineCommand({
  name: 'role',
  description: 'Add, remove and manage roles',
  module: 'roles',
  node: 'roles.add',
  userPerms: PERMS.manageRoles,
  aliases: ['roles'],
  cooldown: 3,
  subcommands: [
    {
      name: 'add',
      description: 'Give a role to a member',
      args: [
        { name: 'user', type: 'user', required: true, description: 'Who to give the role to' },
        { name: 'role', type: 'role', required: true, description: 'The role to add' },
      ],
    },
    {
      name: 'remove',
      description: 'Take a role away from a member',
      args: [
        { name: 'user', type: 'user', required: true, description: 'Who to remove the role from' },
        { name: 'role', type: 'role', required: true, description: 'The role to remove' },
      ],
    },
    {
      name: 'create',
      description: 'Create a new role',
      args: [
        { name: 'name', type: 'string', required: true, description: 'The role name', maxLength: 90 },
        { name: 'color', type: 'string', required: false, description: 'Hex colour, e.g. #5865f2', maxLength: 9 },
        { name: 'hoist', type: 'boolean', required: false, description: 'Show separately in the member list' },
        { name: 'mentionable', type: 'boolean', required: false, description: 'Allow anyone to mention it' },
      ],
    },
    {
      name: 'delete',
      description: 'Delete a role',
      args: [
        { name: 'role', type: 'role', required: true, description: 'The role to delete' },
      ],
    },
    {
      name: 'color',
      description: 'Change a role colour',
      args: [
        { name: 'role', type: 'role', required: true, description: 'The role to recolour' },
        { name: 'color', type: 'string', required: true, description: 'Hex colour, or "reset"', maxLength: 9 },
      ],
    },
    {
      name: 'rename',
      description: 'Rename a role',
      args: [
        { name: 'role', type: 'role', required: true, description: 'The role to rename' },
        { name: 'name', type: 'string', required: true, description: 'The new name', maxLength: 90 },
      ],
    },
    {
      name: 'all',
      description: 'Give a role to every member',
      args: [
        { name: 'role', type: 'role', required: true, description: 'The role to give everyone' },
      ],
    },
    {
      name: 'humans',
      description: 'Give a role to every human member',
      args: [
        { name: 'role', type: 'role', required: true, description: 'The role to give humans' },
      ],
    },
    {
      name: 'bots',
      description: 'Give a role to every bot',
      args: [
        { name: 'role', type: 'role', required: true, description: 'The role to give bots' },
      ],
    },
    {
      name: 'permissions',
      description: 'List the permissions a role grants',
      args: [
        { name: 'role', type: 'role', required: true, description: 'The role to inspect' },
      ],
    },
  ],

  async run(ctx) {
    const sub = ctx.subcommand?.name ?? null;
    if (!sub) {
      return ctx.reply({
        embeds: [
          embeds.info(
            'Role management',
            [
              `\`${ctx.prefix}role add <user> <role>\``,
              `\`${ctx.prefix}role remove <user> <role>\``,
              `\`${ctx.prefix}role create <name> [color]\``,
              `\`${ctx.prefix}role delete <role>\``,
              `\`${ctx.prefix}role color <role> <hex>\``,
              `\`${ctx.prefix}role rename <role> <name>\``,
              `\`${ctx.prefix}role all|humans|bots <role>\``,
              `\`${ctx.prefix}role permissions <role>\``,
            ].join('\n'),
          ),
        ],
      });
    }

    if (!ctx.guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return ctx.error('Missing permission', 'I need **Manage Roles** to do that.');
    }

    switch (sub) {
      case 'add': return runAdd(ctx);
      case 'remove': return runRemove(ctx);
      case 'create': return runCreate(ctx);
      case 'delete': return runDelete(ctx);
      case 'color': return runColor(ctx);
      case 'rename': return runRename(ctx);
      case 'all': return runBulk(ctx, 'all');
      case 'humans': return runBulk(ctx, 'humans');
      case 'bots': return runBulk(ctx, 'bots');
      case 'permissions': return runPermissions(ctx);
      default: return ctx.error('Unknown option', `\`${sub}\` is not available.`);
    }
  },
});

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

/** Resolve the `role` argument whether it arrived as an object or a token. */
function resolveRole(ctx) {
  const raw = ctx.get('role');
  if (!raw) return null;
  if (typeof raw === 'object' && raw.id) return raw;

  const id = helpers.extractId(String(raw));
  if (id) return ctx.guild.roles.cache.get(id) ?? null;

  const lowered = String(raw).toLowerCase().replace(/^@/, '');
  return ctx.guild.roles.cache.find((candidate) => candidate.name.toLowerCase() === lowered)
    ?? ctx.guild.roles.cache.find((candidate) => candidate.name.toLowerCase().startsWith(lowered))
    ?? null;
}

/** Resolve the `user` argument into a guild member. */
async function resolveMember(ctx, name = 'user') {
  const raw = ctx.get(name);
  if (!raw) return null;

  if (typeof raw === 'object' && raw.id) {
    return raw.roles ? raw : (await ctx.guild.members.fetch(raw.id).catch(() => null));
  }

  const id = helpers.extractId(String(raw));
  if (!id) return null;
  return ctx.guild.members.fetch(id).catch(() => null);
}

/** Parse a hex colour, returning null for anything unusable. */
function parseColor(input) {
  if (!input) return null;
  const text = String(input).trim().toLowerCase();
  if (text === 'reset' || text === 'none' || text === 'default') return 'reset';

  const match = text.match(/^#?([0-9a-f]{6})$/);
  if (!match) return null;
  return Number.parseInt(match[1], 16);
}

/**
 * Confirm the bot can safely act on a role.
 * @returns {string|null} an error message, or null when it is safe
 */
function guardRole(ctx, role) {
  if (role.id === ctx.guild.roles.everyone.id) {
    return 'That is the `@everyone` role and cannot be edited.';
  }
  if (role.managed) {
    return `**${role.name}** is managed by an integration and cannot be changed.`;
  }
  if (!role.editable) {
    return `**${role.name}** sits at or above my highest role, so I cannot edit it. Move my role above it first.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// add / remove
// ---------------------------------------------------------------------------

async function runAdd(ctx) {
  const member = await resolveMember(ctx);
  if (!member) return ctx.error('Member not found', 'I could not find that member in this server.');

  const target = resolveRole(ctx);
  if (!target) return ctx.error('Role not found', 'I could not find that role.');

  const guard = guardRole(ctx, target);
  if (guard) return ctx.error('Cannot assign that role', guard);

  const done = await member.roles.add(target, `${ctx.user.tag ?? ctx.userId} via /role add`)
    .then(() => true).catch((error) => error);

  if (done !== true) return ctx.error('Could not add the role', done.message ?? String(done));

  await audit(ctx, 'role.add', member.id, { role: target.id });

  return ctx.reply({
    embeds: [embeds.success('Role added', `<@${member.id}> now has <@&${target.id}>.`)],
  });
}

async function runRemove(ctx) {
  const member = await resolveMember(ctx);
  if (!member) return ctx.error('Member not found', 'I could not find that member in this server.');

  const target = resolveRole(ctx);
  if (!target) return ctx.error('Role not found', 'I could not find that role.');

  const guard = guardRole(ctx, target);
  if (guard) return ctx.error('Cannot remove that role', guard);

  if (!member.roles.cache.has(target.id)) {
    return ctx.error('Not assigned', `<@${member.id}> does not have <@&${target.id}>.`);
  }

  const done = await member.roles.remove(target, `${ctx.user.tag ?? ctx.userId} via /role remove`)
    .then(() => true).catch((error) => error);

  if (done !== true) return ctx.error('Could not remove the role', done.message ?? String(done));

  await audit(ctx, 'role.remove', member.id, { role: target.id });

  return ctx.reply({
    embeds: [embeds.success('Role removed', `<@${member.id}> no longer has <@&${target.id}>.`)],
  });
}

// ---------------------------------------------------------------------------
// create / delete
// ---------------------------------------------------------------------------

async function runCreate(ctx) {
  const name = ctx.get('name');
  if (!name) return ctx.error('No name given', 'Provide a name for the role.');

  const colorInput = ctx.get('color');
  const color = colorInput ? parseColor(colorInput) : null;
  if (colorInput && color === null) {
    return ctx.error('Invalid colour', 'Use a hex colour like `#5865f2`, or leave it out.');
  }

  const created = await ctx.guild.roles.create({
    name: String(name).slice(0, 100),
    color: color === 'reset' ? undefined : (color ?? undefined),
    hoist: ctx.get('hoist') === true,
    mentionable: ctx.get('mentionable') === true,
    reason: `Created by ${ctx.user.tag ?? ctx.userId}`,
  }).catch((error) => {
    ctx.log.error('role create failed:', error);
    return null;
  });

  if (!created) return ctx.error('Could not create the role', 'Discord rejected the request.');

  await audit(ctx, 'role.create', created.id, { name: created.name });

  return ctx.reply({
    embeds: [
      embeds.success(
        'Role created',
        `<@&${created.id}> is ready. Position: **${created.position}**, colour: **${created.hexColor}**.`,
      ),
    ],
  });
}

async function runDelete(ctx) {
  const target = resolveRole(ctx);
  if (!target) return ctx.error('Role not found', 'I could not find that role.');

  const guard = guardRole(ctx, target);
  if (guard) return ctx.error('Cannot delete that role', guard);

  const confirmed = await ctx.confirm({
    title: `Delete **${target.name}**?`,
    body: `This removes the role from **${target.members.size}** member(s) and cannot be undone.`,
    confirmLabel: 'Delete role',
  });
  if (!confirmed) return;

  const done = await target.delete(`Deleted by ${ctx.user.tag ?? ctx.userId}`)
    .then(() => true).catch((error) => error);

  if (done !== true) return ctx.error('Could not delete the role', done.message ?? String(done));

  await audit(ctx, 'role.delete', target.id, { name: target.name });

  return ctx.reply({
    embeds: [embeds.success('Role deleted', `**${target.name}** has been removed.`)],
  });
}

// ---------------------------------------------------------------------------
// color / rename
// ---------------------------------------------------------------------------

async function runColor(ctx) {
  const target = resolveRole(ctx);
  if (!target) return ctx.error('Role not found', 'I could not find that role.');

  const guard = guardRole(ctx, target);
  if (guard) return ctx.error('Cannot edit that role', guard);

  const color = parseColor(ctx.get('color'));
  if (color === null) return ctx.error('Invalid colour', 'Use a hex colour like `#5865f2`, or `reset`.');

  const done = await target.setColor(color === 'reset' ? null : color, `Recoloured by ${ctx.user.tag ?? ctx.userId}`)
    .then(() => true).catch((error) => error);

  if (done !== true) return ctx.error('Could not change the colour', done.message ?? String(done));

  await audit(ctx, 'role.color', target.id, { color: color === 'reset' ? null : color });

  return ctx.reply({
    embeds: [embeds.success('Colour updated', `<@&${target.id}> is now **${target.hexColor}**.`)],
  });
}

async function runRename(ctx) {
  const target = resolveRole(ctx);
  if (!target) return ctx.error('Role not found', 'I could not find that role.');

  const guard = guardRole(ctx, target);
  if (guard) return ctx.error('Cannot edit that role', guard);

  const name = String(ctx.get('name') ?? '').trim();
  if (!name) return ctx.error('No name given', 'Provide the new role name.');

  const previousName = target.name;
  const done = await target.setName(name.slice(0, 100), `Renamed by ${ctx.user.tag ?? ctx.userId}`)
    .then(() => true).catch((error) => error);

  if (done !== true) return ctx.error('Could not rename the role', done.message ?? String(done));

  await audit(ctx, 'role.rename', target.id, { from: previousName, to: name });

  return ctx.reply({
    embeds: [embeds.success('Role renamed', `**${previousName}** is now **${target.name}**.`)],
  });
}

// ---------------------------------------------------------------------------
// bulk operations
// ---------------------------------------------------------------------------

async function runBulk(ctx, mode) {
  const target = resolveRole(ctx);
  if (!target) return ctx.error('Role not found', 'I could not find that role.');

  const guard = guardRole(ctx, target);
  if (guard) return ctx.error('Cannot assign that role', guard);

  // Fetch every member so the operation does not depend on the cache.
  const all = await ctx.guild.members.fetch().catch(() => null);
  if (!all) return ctx.error('Could not fetch members', 'Discord did not return the member list.');

  let candidates = [...all.values()];
  if (mode === 'humans') candidates = candidates.filter((member) => !member.user.bot);
  if (mode === 'bots') candidates = candidates.filter((member) => member.user.bot);

  const already = candidates.filter((member) => member.roles.cache.has(target.id));
  const pending = candidates.filter((member) => !member.roles.cache.has(target.id));

  if (pending.length === 0) {
    return ctx.reply({
      embeds: [
        embeds.info(
          'Nothing to do',
          `All **${candidates.length}** matching member(s) already have <@&${target.id}>.`,
        ),
      ],
    });
  }

  const scope = mode === 'all' ? 'every member' : `every ${mode === 'humans' ? 'human' : 'bot'}`;
  const confirmed = await ctx.confirm({
    title: `Give **${target.name}** to ${scope}?`,
    body: `About to update **${pending.length}** member(s).`
      + (already.length > 0 ? ` ${already.length} already have it and will be skipped.` : ''),
    confirmLabel: `Add to ${pending.length}`,
  });
  if (!confirmed) return;

  await ctx.defer({ ephemeral: true });

  let added = 0;
  let failed = 0;

  // Batching through the role's own manager is far gentler on rate limits than
  // one request per member.
  const chunkSize = 100;
  for (let index = 0; index < pending.length; index += chunkSize) {
    const chunk = pending.slice(index, index + chunkSize);
    // eslint-disable-next-line no-await-in-loop
    const done = await target.setMembers(chunk, `Bulk assign by ${ctx.user.tag ?? ctx.userId}`)
      .then(() => true).catch(() => false);

    if (done) added += chunk.length;
    else failed += chunk.length;

    // Give the API a moment between batches.
    // eslint-disable-next-line no-await-in-loop
    if (index + chunkSize < pending.length) await helpers.sleep(1200);
  }

  await audit(ctx, `role.bulk.${mode}`, target.id, { added, failed, role: target.name });

  const embed = embeds.embed({
    color: failed === 0 ? COLORS.success : COLORS.warning,
    title: 'Bulk role update finished',
    description: `**${target.name}** applied to ${scope}.`,
  });
  embed.addFields(
    { name: 'Added', value: helpers.formatNumber(added), inline: true },
    { name: 'Failed', value: helpers.formatNumber(failed), inline: true },
    { name: 'Skipped', value: helpers.formatNumber(already.length), inline: true },
  );

  return ctx.editReply({ embeds: [embed] });
}

// ---------------------------------------------------------------------------
// permissions
// ---------------------------------------------------------------------------

async function runPermissions(ctx) {
  const target = resolveRole(ctx);
  if (!target) return ctx.error('Role not found', 'I could not find that role.');

  const granted = target.permissions.toArray();

  const embed = embeds.embed({
    color: target.hexColor === '#000000' ? COLORS.neutral : target.color,
    title: `🔐 ${target.name}`,
    description: granted.length === 0
      ? 'This role grants no permissions.'
      : '```\n' + helpers.chunk(granted.map((name) => name.replace(/([a-z])([A-Z])/g, '$1 $2')).join(', '), 3500)[0] + '\n```',
  });

  embed.addFields(
    { name: 'Members', value: helpers.formatNumber(target.members.size), inline: true },
    { name: 'Position', value: String(target.position), inline: true },
    { name: 'Colour', value: target.hexColor, inline: true },
    { name: 'Mentionable', value: target.mentionable ? 'Yes' : 'No', inline: true },
    { name: 'Hoisted', value: target.hoist ? 'Yes' : 'No', inline: true },
    { name: 'Managed', value: target.managed ? 'Yes' : 'No', inline: true },
  );

  if (target.permissions.has(PermissionFlagsBits.Administrator)) {
    embed.addFields({
      name: '⚠️ Administrator',
      value: 'This role bypasses every permission check. Grant it sparingly.',
    });
  }

  embed.setFooter({ text: `Role ${target.id} • ${config.brandFooterText}` });

  void LIMITS;
  return ctx.reply({ embeds: [embed] });
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

async function audit(ctx, action, targetId, details) {
  try {
    const db = require('../../db');
    await db.writeAudit({
      guildId: ctx.guildId,
      actorId: ctx.userId,
      actorTag: ctx.user.tag ?? ctx.user.username,
      action,
      targetType: 'role',
      targetId,
      details,
      source: ctx.kind,
    });
  } catch {
    // Auditing must never break the action it describes.
  }
}

module.exports = role;
