'use strict';

/**
 * Module 8 - Leveling & XP.
 *
 *   /rank | /leaderboard | /levels add | remove | set | reset |
 *          rewards | config | toggle
 *
 * XP itself is granted by the message event; these commands read it, adjust it
 * for staff, and manage the reward table.
 */

const { PermissionFlagsBits } = require('discord.js');
const { defineCommand } = require('../../core/command');
const helpers = require('../../lib/helpers');
const embeds = require('../../lib/embeds');
const config = require('../../config');
const { COLORS, xpForLevel } = require('../../lib/constants');
const service = require('./leveling-service');

/** Resolve an argument to a member. */
async function asMember(ctx, name) {
  const raw = ctx.get(name);
  if (!raw) return null;
  if (typeof raw === 'object' && raw.id) {
    return raw.roles ? raw : (await ctx.guild.members.fetch(raw.id).catch(() => null));
  }
  const id = helpers.extractId(String(raw));
  return id ? ctx.guild.members.fetch(id).catch(() => null) : null;
}

/** Resolve an argument to a role. */
function asRole(ctx, name) {
  const raw = ctx.get(name);
  if (!raw) return null;
  if (typeof raw === 'object' && raw.id) return raw;
  const id = helpers.extractId(String(raw));
  if (id) return ctx.guild.roles.cache.get(id) ?? null;
  const lowered = String(raw).toLowerCase().replace(/^@/, '');
  return ctx.guild.roles.cache.find((role) => role.name.toLowerCase() === lowered) ?? null;
}

// ---------------------------------------------------------------------------
// /rank
// ---------------------------------------------------------------------------

const rank = defineCommand({
  name: 'rank',
  description: 'Show your level and XP',
  module: 'levels',
  node: 'levels.rank',
  aliases: ['r', 'level'],
  cooldown: 3,
  args: [
    { name: 'user', type: 'user', required: false, description: 'Whose rank to show (default: you)' },
  ],

  async run(ctx) {
    const check = ctx.hasPermission('levels.rank');
    if (!check.ok) return ctx.deny(check.reason);

    const raw = ctx.get('user');
    let member = ctx.member;

    if (raw) {
      member = (typeof raw === 'object' && raw.id)
        ? (raw.roles ? raw : await ctx.guild.members.fetch(raw.id).catch(() => null))
        : await asMember(ctx, 'user');
    }

    if (!member) return ctx.error('Member not found', 'I could not find that member.');

    const [row, rankPosition, total] = await Promise.all([
      service.getUser(ctx.guildId, member.id),
      service.getUser(ctx.guildId, member.id).then((user) => service.rankOf(ctx.guildId, Number(user?.total_xp ?? 0))),
      service.totalRanked(ctx.guildId),
    ]);

    const data = service.progress(row);

    const embed = embeds.embed({
      color: member.displayHexColor && member.displayHexColor !== '#000000' ? member.displayColor : COLORS.brand,
      title: `${member.displayName}'s rank`,
      description: [
        `**Level ${data.level}**`,
        `\`${helpers.progressBar(data.intoLevel, data.needed, 18)}\``,
        `${helpers.formatNumber(data.intoLevel)} / ${helpers.formatNumber(data.needed)} XP to level ${data.level + 1}`,
      ].join('\n'),
    });

    embed.setThumbnail(member.user.displayAvatarURL({ size: 256 }));
    embed.addFields(
      { name: 'Rank', value: rankPosition ? `#${rankPosition} of ${helpers.formatNumber(total)}` : 'unranked', inline: true },
      { name: 'Total XP', value: helpers.formatNumber(data.totalXp), inline: true },
      { name: 'Messages', value: helpers.formatNumber(data.messages), inline: true },
    );

    if (data.voiceSeconds > 0) {
      embed.addFields({ name: 'Voice time', value: helpers.formatDuration(data.voiceSeconds, { units: 2 }), inline: true });
    }

    embed.setFooter({ text: config.brandFooterText });

    // Public when looking at someone else, private when checking your own.
    const isSelf = member.id === ctx.userId;
    return ctx.reply({ embeds: [embed], ephemeral: !isSelf });
  },
});

// ---------------------------------------------------------------------------
// /leaderboard
// ---------------------------------------------------------------------------

const leaderboard = defineCommand({
  name: 'leaderboard',
  description: 'Show the XP leaderboard',
  module: 'levels',
  node: 'levels.leaderboard',
  aliases: ['lb', 'top'],
  cooldown: 5,
  args: [
    { name: 'page', type: 'integer', required: false, description: 'Page number', min: 1, max: 100 },
  ],

  async run(ctx) {
    const check = ctx.hasPermission('levels.leaderboard');
    if (!check.ok) return ctx.deny(check.reason);

    const page = helpers.clamp(Number.parseInt(ctx.get('page'), 10) || 1, 1, 100);
    const perPage = 10;

    const [rows, total] = await Promise.all([
      service.leaderboard(ctx.guildId, { limit: perPage, offset: (page - 1) * perPage }),
      service.totalRanked(ctx.guildId),
    ]);

    if (rows.length === 0) {
      return ctx.reply({
        embeds: [embeds.info('Nobody is ranked yet', 'Send some messages to start earning XP!')],
      });
    }

    const medals = ['🥇', '🥈', '🥉'];

    const embed = embeds.embed({
      color: COLORS.gold,
      title: `🏆 ${ctx.guild.name} leaderboard`,
    });

    embed.setDescription(
      rows.map((row, index) => {
        const position = (page - 1) * perPage + index + 1;
        const badge = medals[position - 1] ?? `**${position}.**`;
        const data = service.progress(row);
        return `${badge} <@${row.user_id}> — level **${data.level}** • ${helpers.formatNumber(data.totalXp)} XP`;
      }).join('\n'),
    );

    embed.setThumbnail(ctx.guild.iconURL({ size: 256 }));
    embed.setFooter({
      text: `Page ${page} of ${Math.max(1, Math.ceil(total / perPage))} • ${helpers.formatNumber(total)} ranked • ${config.brandFooterText}`,
    });

    return ctx.reply({ embeds: [embed] });
  },
});

// ---------------------------------------------------------------------------
// /levels
// ---------------------------------------------------------------------------

const levels = defineCommand({
  name: 'levels',
  description: 'Manage XP and level rewards',
  module: 'levels',
  node: 'levels.config',
  userPerms: [PermissionFlagsBits.ManageGuild],
  aliases: ['xp'],
  cooldown: 3,
  subcommands: [
    {
      name: 'add',
      description: 'Give XP to a member',
      args: [
        { name: 'user', type: 'user', required: true, description: 'Who to give XP to' },
        { name: 'amount', type: 'integer', required: true, description: 'How much XP', min: 1, max: 1000000 },
      ],
    },
    {
      name: 'remove',
      description: 'Take XP away from a member',
      args: [
        { name: 'user', type: 'user', required: true, description: 'Who to remove XP from' },
        { name: 'amount', type: 'integer', required: true, description: 'How much XP', min: 1, max: 1000000 },
      ],
    },
    {
      name: 'set',
      description: 'Set a member\'s total XP',
      args: [
        { name: 'user', type: 'user', required: true, description: 'Whose XP to set' },
        { name: 'amount', type: 'integer', required: true, description: 'The new total XP', min: 0, max: 100000000 },
      ],
    },
    {
      name: 'reset',
      description: 'Reset XP for a member or the whole server',
      args: [
        { name: 'user', type: 'user', required: false, description: 'Whose XP to reset (omit for everyone)' },
      ],
    },
    {
      name: 'rewards',
      description: 'Manage level reward roles',
      args: [
        {
          name: 'action',
          type: 'string',
          required: true,
          description: 'What to do',
          choices: [
            { name: 'List', value: 'list' },
            { name: 'Add', value: 'add' },
            { name: 'Remove', value: 'remove' },
          ],
        },
        { name: 'level', type: 'integer', required: false, description: 'The level', min: 1, max: 1000 },
        { name: 'role', type: 'role', required: false, description: 'The role to grant' },
      ],
    },
    {
      name: 'config',
      description: 'Configure XP gain and the announce channel',
      args: [
        { name: 'channel', type: 'channel', required: false, description: 'Where level-ups are announced' },
        { name: 'min', type: 'integer', required: false, description: 'Minimum XP per message', min: 1, max: 1000 },
        { name: 'max', type: 'integer', required: false, description: 'Maximum XP per message', min: 1, max: 1000 },
        { name: 'cooldown', type: 'integer', required: false, description: 'Seconds between XP gains', min: 5, max: 3600 },
        { name: 'stack', type: 'boolean', required: false, description: 'Keep all reward roles instead of only the highest' },
      ],
    },
    {
      name: 'toggle',
      description: 'Turn the XP system on or off',
      args: [
        { name: 'enabled', type: 'boolean', required: true, description: 'On or off' },
      ],
    },
  ],

  async run(ctx) {
    const sub = ctx.subcommand?.name ?? 'config';
    const nodeMap = {
      add: 'levels.add',
      remove: 'levels.remove',
      set: 'levels.set',
      reset: 'levels.reset',
      rewards: 'levels.rewards',
      config: 'levels.config',
      toggle: 'levels.toggle',
    };

    const check = ctx.hasPermission(nodeMap[sub] ?? 'levels.config');
    if (!check.ok) return ctx.deny(check.reason);

    switch (sub) {
      case 'add': return runAdd(ctx);
      case 'remove': return runRemove(ctx);
      case 'set': return runSet(ctx);
      case 'reset': return runReset(ctx);
      case 'rewards': return runRewards(ctx);
      case 'config': return runConfig(ctx);
      case 'toggle': return runToggle(ctx);
      default: return ctx.error('Unknown option', `\`${sub}\` is not available.`);
    }
  },
});

// ---------------------------------------------------------------------------
// add / remove / set
// ---------------------------------------------------------------------------

async function runAdd(ctx) {
  const member = await asMember(ctx, 'user');
  if (!member) return ctx.error('Member not found', 'I could not find that member.');

  const amount = helpers.clamp(Number.parseInt(ctx.get('amount'), 10) || 0, 1, 1000000);
  const result = await service.addXp(ctx.guildId, member.id, amount);

  return ctx.reply({
    embeds: [
      embeds.success(
        'XP added',
        [
          `Gave **${helpers.formatNumber(amount)}** XP to <@${member.id}>.`,
          `They are now level **${result.level}** with **${helpers.formatNumber(result.totalXp)}** XP.`,
        ].join('\n'),
      ),
    ],
    ephemeral: true,
  });
}

async function runRemove(ctx) {
  const member = await asMember(ctx, 'user');
  if (!member) return ctx.error('Member not found', 'I could not find that member.');

  const amount = helpers.clamp(Number.parseInt(ctx.get('amount'), 10) || 0, 1, 1000000);
  const row = await service.getUser(ctx.guildId, member.id);

  if (!row) {
    return ctx.error('No progress', `<@${member.id}> has no XP recorded yet.`);
  }

  const next = Math.max(0, Number(row.total_xp ?? 0) - amount);
  await service.setXp(ctx.guildId, member.id, next);

  return ctx.reply({
    embeds: [
      embeds.success(
        'XP removed',
        `Removed **${helpers.formatNumber(amount)}** XP from <@${member.id}>. They now have **${helpers.formatNumber(next)}** XP.`,
      ),
    ],
    ephemeral: true,
  });
}

async function runSet(ctx) {
  const member = await asMember(ctx, 'user');
  if (!member) return ctx.error('Member not found', 'I could not find that member.');

  const amount = helpers.clamp(Number.parseInt(ctx.get('amount'), 10) || 0, 0, 100000000);
  const row = await service.setXp(ctx.guildId, member.id, amount);
  const level = row?.level ?? 0;

  return ctx.reply({
    embeds: [
      embeds.success(
        'XP set',
        `<@${member.id}> now has **${helpers.formatNumber(amount)}** XP and is level **${level}**.\nRun \`/rank\` to see the updated card.`,
      ),
    ],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

async function runReset(ctx) {
  const raw = ctx.get('user');

  if (raw) {
    const member = await asMember(ctx, 'user');
    if (!member) return ctx.error('Member not found', 'I could not find that member.');

    const confirmed = await ctx.confirm({
      title: `Reset ${member.displayName}'s progress?`,
      body: 'Their XP and level will be wiped and any reward roles removed.',
      confirmLabel: 'Reset progress',
    });
    if (!confirmed) return;

    await service.resetUser(ctx.guildId, member.id);
    const removed = await service.stripRewards(member);

    return ctx.reply({
      embeds: [
        embeds.success(
          'Progress reset',
          `<@${member.id}> is back to level 0.${removed.length > 0 ? ` Removed **${removed.length}** reward role(s).` : ''}`,
        ),
      ],
    });
  }

  const confirmed = await ctx.confirm({
    title: 'Reset the entire leaderboard?',
    body: 'Every member\'s XP and level in this server will be deleted. Reward roles are left in place.',
    confirmLabel: 'Reset everything',
  });
  if (!confirmed) return;

  await service.resetGuild(ctx.guildId);

  return ctx.reply({
    embeds: [embeds.success('Leaderboard reset', 'All XP records have been cleared for this server.')],
  });
}

// ---------------------------------------------------------------------------
// rewards
// ---------------------------------------------------------------------------

async function runRewards(ctx) {
  const action = ctx.get('action') || 'list';

  if (action === 'list') {
    const rows = await service.rewards(ctx.guildId);

    if (rows.length === 0) {
      return ctx.reply({
        embeds: [
          embeds.info(
            'No rewards configured',
            'Use `/levels rewards action:Add level:<n> role:<role>` to create one.',
          ),
        ],
      });
    }

    return ctx.reply({
      embeds: [
        embeds.embed({
          color: COLORS.brand,
          title: `🎁 Level rewards (${rows.length})`,
          description: rows.map((row) => {
            const missing = !ctx.guild.roles.cache.has(row.role_id);
            const role = missing ? `\`${row.role_id}\` *(deleted)*` : `<@&${row.role_id}>`;
            return `**Level ${row.level}** → ${role}`;
          }).join('\n'),
        }),
      ],
    });
  }

  const level = Number.parseInt(ctx.get('level'), 10);
  if (!Number.isFinite(level) || level < 1) {
    return ctx.error('Level required', 'Give a level of 1 or higher.');
  }

  const role = asRole(ctx, 'role');
  if (!role) return ctx.error('Role not found', 'I could not find that role.');

  if (action === 'add') {
    if (!role.editable) {
      return ctx.error(
        'Role is too high',
        `**${role.name}** is above my highest role, so I cannot grant it. Move my role higher.`,
      );
    }

    await service.addReward(ctx.guildId, level, role.id);

    return ctx.reply({
      embeds: [
        embeds.success('Reward added', `Members reaching level **${level}** will receive <@&${role.id}>.`),
      ],
      ephemeral: true,
    });
  }

  if (action === 'remove') {
    await service.removeReward(ctx.guildId, level, role.id);

    return ctx.reply({
      embeds: [
        embeds.success('Reward removed', `<@&${role.id}> is no longer granted at level **${level}**.`),
      ],
      ephemeral: true,
    });
  }

  return ctx.error('Unknown action', `\`${action}\` is not a rewards action.`);
}

// ---------------------------------------------------------------------------
// config / toggle
// ---------------------------------------------------------------------------

async function runConfig(ctx) {
  const db = require('../../db');
  const patch = {};

  const rawChannel = ctx.get('channel');
  if (rawChannel) {
    const channel = (typeof rawChannel === 'object' && rawChannel.id)
      ? rawChannel
      : ctx.guild.channels.cache.get(helpers.extractId(String(rawChannel)) ?? '');
    if (!channel) return ctx.error('Channel not found', 'That is not a valid channel.');
    patch.levels_announce_channel = channel.id;
  }

  const min = Number.parseInt(ctx.get('min'), 10);
  const max = Number.parseInt(ctx.get('max'), 10);
  if (Number.isFinite(min)) patch.levels_min_xp = helpers.clamp(min, 1, 1000);
  if (Number.isFinite(max)) patch.levels_max_xp = helpers.clamp(max, 1, 1000);

  if (Number.isFinite(min) && Number.isFinite(max) && min > max) {
    return ctx.error('Invalid range', 'The minimum XP cannot be greater than the maximum.');
  }

  const cooldown = Number.parseInt(ctx.get('cooldown'), 10);
  if (Number.isFinite(cooldown)) patch.levels_cooldown_secs = helpers.clamp(cooldown, 5, 3600);

  const stack = ctx.get('stack');
  if (typeof stack === 'boolean') patch.levels_stack_rewards = stack;

  if (Object.keys(patch).length === 0) {
    const guildConfig = await db.getGuildConfig(ctx.guildId, { fresh: true });
    const current = service.settings(guildConfig);
    const channelText = current.announceChannel
      ? (ctx.guild.channels.cache.has(current.announceChannel) ? `<#${current.announceChannel}>` : '*(missing channel)*')
      : '*same channel as the message*';

    return ctx.reply({
      embeds: [
        embeds.info(
          'Level configuration',
          [
            `Status: ${current.enabled ? '🟢 on' : '🔴 off'}`,
            `XP per message: **${current.minXp}–${current.maxXp}**`,
            `Cooldown: **${current.cooldown}s**`,
            `Announce channel: ${channelText}`,
            `Stack rewards: **${current.stackRewards ? 'yes' : 'no'}**`,
          ].join('\n'),
        ),
      ],
    });
  }

  await db.setGuildConfig(ctx.guildId, patch);

  const lines = [];
  if (patch.levels_min_xp !== undefined || patch.levels_max_xp !== undefined) {
    const guildConfig = await db.getGuildConfig(ctx.guildId, { fresh: true });
    const current = service.settings(guildConfig);
    lines.push(`XP per message: **${current.minXp}–${current.maxXp}**`);
  }
  if (patch.levels_announce_channel !== undefined) lines.push(`Announcements: <#${patch.levels_announce_channel}>`);
  if (patch.levels_cooldown_secs !== undefined) lines.push(`Cooldown: **${patch.levels_cooldown_secs}s**`);
  if (patch.levels_stack_rewards !== undefined) lines.push(`Stack rewards: **${patch.levels_stack_rewards ? 'yes' : 'no'}**`);

  return ctx.reply({
    embeds: [embeds.success('Configuration updated', lines.join('\n'))],
    ephemeral: true,
  });
}

async function runToggle(ctx) {
  const enabled = ctx.get('enabled');
  if (typeof enabled !== 'boolean') return ctx.error('No value given', 'Pass `true` or `false`.');

  const db = require('../../db');
  await db.setGuildConfig(ctx.guildId, { levels_enabled: enabled });

  return ctx.reply({
    embeds: [
      embeds.success(
        `XP system ${enabled ? 'enabled' : 'disabled'}`,
        enabled ? 'Members will earn XP again.' : 'No more XP will be granted until you re-enable it.',
      ),
    ],
    ephemeral: true,
  });
}

module.exports = { commands: [rank, leaderboard, levels] };

void xpForLevel;
