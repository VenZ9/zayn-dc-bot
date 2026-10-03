'use strict';

/**
 * Module 2 - Server Management.
 *
 * /serverinfo /userinfo /roleinfo /channelinfo /avatar /banner /emojis
 * /icon /invites /boosters /members /ping /uptime /botinfo
 *
 * All read-only except /invites, which reads Discord's invite list.
 */

const {
  PermissionFlagsBits,
  ChannelType,
  version: djsVersion,
} = require('discord.js');
const { defineCommand } = require('../../core/command');
const { PERMS } = require('../../lib/permissions');
const helpers = require('../../lib/helpers');
const embeds = require('../../lib/embeds');
const ui = require('../../lib/ui');
const config = require('../../config');
const { COLORS, LIMITS } = require('../../lib/constants');
const { resolveTarget } = require('../moderation/ban');

// ---------------------------------------------------------------------------
// /serverinfo
// ---------------------------------------------------------------------------

const serverinfo = defineCommand({
  name: 'serverinfo',
  description: 'Show detailed information about this server',
  module: 'server',
  node: 'server.info',
  aliases: ['si', 'guildinfo'],
  cooldown: 5,
  async run(ctx) {
    const guild = ctx.guild;

    // Owner is usually cached; fetch only when needed.
    const owner = await guild.fetchOwner().catch(() => null);

    const channels = guild.channels.cache;
    const counts = {
      text: channels.filter((c) => c.type === ChannelType.GuildText).size,
      voice: channels.filter((c) => c.type === ChannelType.GuildVoice).size,
      category: channels.filter((c) => c.type === ChannelType.GuildCategory).size,
      forum: channels.filter((c) => c.type === ChannelType.GuildForum).size,
      threads: channels.filter((c) => c.isThread()).size,
    };

    const bots = guild.members.cache.filter((member) => member.user.bot).size;
    const humans = Math.max(0, guild.memberCount - bots);

    const embed = embeds.embed({
      color: COLORS.brand,
      title: guild.name,
      description: guild.description || undefined,
    });

    embed.setThumbnail(guild.iconURL({ size: 256 }) ?? null);

    embed.addFields(
      { name: 'Owner', value: owner ? `<@${owner.id}>` : 'Unknown', inline: true },
      { name: 'Created', value: `${helpers.timestamp(guild.createdAt, 'R')}`, inline: true },
      { name: 'ID', value: `\`${guild.id}\``, inline: true },

      { name: 'Members', value: `${helpers.formatNumber(humans)} human(s)`, inline: true },
      { name: 'Bots', value: `${helpers.formatNumber(bots)}`, inline: true },
      { name: 'Boost tier', value: `Level ${guild.premiumTier} (${guild.premiumSubscriptionCount ?? 0} boosts)`, inline: true },

      { name: 'Roles', value: helpers.formatNumber(guild.roles.cache.size), inline: true },
      { name: 'Emojis', value: `${guild.emojis.cache.size} / ${guild.emojis.cache.filter((e) => e.animated).size} animated`, inline: true },
      { name: 'Stickers', value: helpers.formatNumber(guild.stickers?.cache.size ?? 0), inline: true },
    );

    embed.addFields({
      name: 'Channels',
      value: [
        `Text: **${counts.text}**`,
        `Voice: **${counts.voice}**`,
        `Categories: **${counts.category}**`,
        `Forums: **${counts.forum}**`,
        `Threads: **${counts.threads}**`,
      ].join(' • '),
    });

    if (guild.bannerURL()) embed.setImage(guild.bannerURL({ size: 1024 }));

    const features = guild.features?.slice(0, 8) ?? [];
    if (features.length > 0) {
      embed.addFields({ name: 'Features', value: features.map((f) => `\`${f}\``).join(' ') });
    }

    await ctx.reply({ embeds: [embed] });
  },
});

// ---------------------------------------------------------------------------
// /userinfo
// ---------------------------------------------------------------------------

const userinfo = defineCommand({
  name: 'userinfo',
  description: 'Show information about a user',
  module: 'server',
  node: 'server.info',
  aliases: ['ui', 'whois'],
  cooldown: 5,
  args: [
    { name: 'user', type: 'user', required: false, description: 'The user to inspect (defaults to you)' },
  ],

  async run(ctx) {
    // Default to the caller, which is by far the most common use.
    let member = null;
    let user = ctx.user;

    const raw = ctx.get('user');
    if (raw && typeof raw === 'object' && raw.id) {
      user = raw.user ?? raw;
      member = raw.user ? raw : (ctx.guild.members.cache.get(raw.id) ?? null);
      if (!member) member = await ctx.guild.members.fetch(raw.id).catch(() => null);
    } else if (!raw) {
      member = ctx.member;
    } else {
      const resolved = await resolveTarget(ctx);
      if (resolved.error) return ctx.error('Not found', resolved.error);
      user = resolved.user;
      member = resolved.member;
    }

    const embed = embeds.embed({ color: COLORS.brand, title: user.tag ?? user.username });
    embed.setThumbnail(user.displayAvatarURL({ size: 256 }));

    embed.addFields(
      { name: 'Username', value: user.username, inline: true },
      { name: 'ID', value: `\`${user.id}\``, inline: true },
      { name: 'Bot', value: user.bot ? 'Yes' : 'No', inline: true },
      { name: 'Account created', value: `${helpers.timestamp(user.createdAt, 'R')}\n(${helpers.accountAge(user.createdAt)} ago)`, inline: true },
    );

    if (member) {
      embed.addFields(
        { name: 'Display name', value: member.displayName, inline: true },
        { name: 'Joined', value: `${helpers.timestamp(member.joinedAt, 'R')}\n(${helpers.accountAge(member.joinedAt)} ago)`, inline: true },
        { name: 'Nickname', value: member.nickname ?? '*none*', inline: true },
      );

      if (member.premiumSince) {
        embed.addFields({ name: 'Boosting since', value: helpers.timestamp(member.premiumSince, 'R'), inline: true });
      }

      const roles = member.roles.cache
        .filter((role) => role.id !== ctx.guild.id)
        .sort((a, b) => b.position - a.position)
        .map((role) => `<@&${role.id}>`)
        .slice(0, 20);

      embed.addFields({
        name: `Roles (${member.roles.cache.size - 1})`,
        value: roles.length > 0 ? roles.join(' ') : '*none*',
      });

      // Key permissions worth surfacing rather than dumping the whole bitfield.
      const notable = [
        [PermissionFlagsBits.Administrator, 'Administrator'],
        [PermissionFlagsBits.ManageGuild, 'Manage Server'],
        [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
        [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
        [PermissionFlagsBits.BanMembers, 'Ban Members'],
        [PermissionFlagsBits.KickMembers, 'Kick Members'],
        [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
        [PermissionFlagsBits.ManageMessages, 'Manage Messages'],
      ]
        .filter(([bit]) => member.permissions.has(bit))
        .map(([, name]) => name);

      if (notable.length > 0) {
        embed.addFields({ name: 'Key permissions', value: notable.join(', ') });
      }

      const status = member.presence?.status;
      if (status) {
        const label = { online: '🟢 Online', idle: '🟡 Idle', dnd: '🔴 Do Not Disturb', offline: '⚫ Offline' }[status];
        embed.addFields({ name: 'Status', value: label ?? status, inline: true });
      }
    } else {
      embed.addFields({ name: 'Member', value: 'Not in this server', inline: true });
    }

    if (member?.bannerURL?.()) embed.setImage(member.bannerURL({ size: 1024 }));

    await ctx.reply({ embeds: [embed] });
  },
});

// ---------------------------------------------------------------------------
// /roleinfo
// ---------------------------------------------------------------------------

const roleinfo = defineCommand({
  name: 'roleinfo',
  description: 'Show information about a role',
  module: 'server',
  node: 'server.info',
  aliases: ['ri'],
  cooldown: 5,
  args: [
    { name: 'role', type: 'role', required: true, description: 'The role to inspect' },
  ],

  async run(ctx) {
    let role = ctx.get('role');

    // Prefix path leaves a string when the name did not resolve directly.
    if (role && typeof role !== 'object') {
      const prefix = require('../../core/prefix');
      role = prefix.resolveRole(ctx.guild, String(role));
    }

    if (!role) return ctx.error('Role not found', 'I could not find that role.');

    const members = ctx.guild.members.cache.filter((member) => member.roles.cache.has(role.id)).size;

    const embed = embeds.embed({
      color: role.color || COLORS.neutral,
      title: role.name,
    });

    embed.addFields(
      { name: 'ID', value: `\`${role.id}\``, inline: true },
      { name: 'Colour', value: role.hexColor, inline: true },
      { name: 'Position', value: String(role.position), inline: true },
      { name: 'Members', value: helpers.formatNumber(members), inline: true },
      { name: 'Mentionable', value: role.mentionable ? 'Yes' : 'No', inline: true },
      { name: 'Displayed separately', value: role.hoist ? 'Yes' : 'No', inline: true },
      { name: 'Managed', value: role.managed ? 'Yes (bot/integration)' : 'No', inline: true },
      { name: 'Created', value: helpers.timestamp(role.createdAt, 'R'), inline: true },
    );

    const perms = role.permissions.toArray();
    if (perms.includes('Administrator')) {
      embed.addFields({ name: 'Permissions', value: '⚠️ **Administrator** - this role bypasses all channel restrictions.' });
    } else if (perms.length > 0) {
      embed.addFields({
        name: `Permissions (${perms.length})`,
        value: helpers.truncate(perms.map((p) => `\`${p}\``).join(' '), 1000),
      });
    } else {
      embed.addFields({ name: 'Permissions', value: '*none*' });
    }

    await ctx.reply({ embeds: [embed] });
  },
});

// ---------------------------------------------------------------------------
// /channelinfo
// ---------------------------------------------------------------------------

const channelinfo = defineCommand({
  name: 'channelinfo',
  description: 'Show information about a channel',
  module: 'server',
  node: 'server.info',
  aliases: ['ci'],
  cooldown: 5,
  args: [
    { name: 'channel', type: 'channel', required: false, description: 'The channel to inspect (defaults to this one)' },
  ],

  async run(ctx) {
    let channel = ctx.get('channel');
    if (channel && typeof channel !== 'object') {
      const prefix = require('../../core/prefix');
      channel = prefix.resolveChannel(ctx.guild, String(channel));
    }
    if (!channel) channel = ctx.channel;

    if (!channel) return ctx.error('Channel not found', 'I could not find that channel.');

    const typeName = ChannelType[channel.type] ?? String(channel.type);

    const embed = embeds.embed({
      color: COLORS.brand,
      title: `#${channel.name}`,
      description: channel.topic ? helpers.truncate(channel.topic, 500) : undefined,
    });

    embed.addFields(
      { name: 'ID', value: `\`${channel.id}\``, inline: true },
      { name: 'Type', value: typeName, inline: true },
      { name: 'Created', value: helpers.timestamp(channel.createdAt, 'R'), inline: true },
    );

    if (channel.parent) embed.addFields({ name: 'Category', value: channel.parent.name, inline: true });
    if (typeof channel.rateLimitPerUser === 'number') {
      embed.addFields({
        name: 'Slowmode',
        value: channel.rateLimitPerUser > 0 ? `${channel.rateLimitPerUser}s` : 'Off',
        inline: true,
      });
    }
    if (channel.nsfw !== undefined) embed.addFields({ name: 'NSFW', value: channel.nsfw ? 'Yes' : 'No', inline: true });
    if (typeof channel.position === 'number') embed.addFields({ name: 'Position', value: String(channel.position), inline: true });

    if (channel.isVoiceBased?.()) {
      embed.addFields(
        { name: 'Bitrate', value: `${Math.round(channel.bitrate / 1000)} kbps`, inline: true },
        { name: 'User limit', value: channel.userLimit === 0 ? 'Unlimited' : String(channel.userLimit), inline: true },
      );
      if (channel.members) embed.addFields({ name: 'Connected', value: helpers.formatNumber(channel.members.size), inline: true });
    }

    if (channel.isTextBased?.()) {
      embed.addFields({ name: 'Messages', value: helpers.formatNumber(channel.messages?.cache.size ?? 0), inline: true });
    }

    // Overwrites, summarised rather than dumped.
    const overwrites = channel.permissionOverwrites?.cache;
    if (overwrites && overwrites.size > 0) {
      embed.addFields({
        name: `Permission overwrites (${overwrites.size})`,
        value: helpers.truncate(
          overwrites.map((overwrite) => {
            const target = overwrite.type === 0
              ? `<@&${overwrite.id}>`
              : `<@${overwrite.id}>`;
            return target;
          }).join(' '),
          1000,
        ),
      });
    }

    await ctx.reply({ embeds: [embed] });
  },
});

// ---------------------------------------------------------------------------
// /avatar
// ---------------------------------------------------------------------------

const avatar = defineCommand({
  name: 'avatar',
  description: 'Show a user\'s avatar',
  module: 'server',
  node: 'server.info',
  aliases: ['av', 'pfp'],
  cooldown: 3,
  args: [
    { name: 'user', type: 'user', required: false, description: 'Whose avatar to show (defaults to you)' },
    { name: 'server', type: 'boolean', required: false, description: 'Prefer the server-specific avatar' },
  ],

  async run(ctx) {
    let user = ctx.user;
    let member = ctx.member;

    const raw = ctx.get('user');
    if (raw && typeof raw === 'object' && raw.id) {
      user = raw.user ?? raw;
      member = raw.user ? raw : (ctx.guild.members.cache.get(raw.id) ?? null);
    } else if (raw) {
      const resolved = await resolveTarget(ctx);
      if (resolved.error) return ctx.error('Not found', resolved.error);
      user = resolved.user;
      member = resolved.member;
    }

    const preferServer = ctx.get('server') === true;

    // A server avatar is only meaningful on a member object.
    let url;
    if (preferServer && member?.displayAvatarURL) {
      url = member.displayAvatarURL({ size: 1024, extension: 'png' });
    } else {
      url = user.displayAvatarURL({ size: 1024, extension: 'png' });
    }

    const embed = embeds.embed({
      color: COLORS.brand,
      title: `${user.tag ?? user.username}'s avatar`,
      description: [
        `[PNG](${user.displayAvatarURL({ size: 1024, extension: 'png' })})`,
        `[JPG](${user.displayAvatarURL({ size: 1024, extension: 'jpg' })})`,
        `[WEBP](${user.displayAvatarURL({ size: 1024, extension: 'webp' })})`,
        user.avatar?.startsWith('a_') ? `[GIF](${user.displayAvatarURL({ size: 1024, extension: 'gif' })})` : null,
      ].filter(Boolean).join(' • '),
    });

    embed.setImage(url);
    await ctx.reply({ embeds: [embed] });
  },
});

// ---------------------------------------------------------------------------
// /banner
// ---------------------------------------------------------------------------

const banner = defineCommand({
  name: 'banner',
  description: 'Show a user\'s profile banner',
  module: 'server',
  node: 'server.info',
  cooldown: 3,
  args: [
    { name: 'user', type: 'user', required: false, description: 'Whose banner to show (defaults to you)' },
  ],

  async run(ctx) {
    let user = ctx.user;

    const raw = ctx.get('user');
    if (raw && typeof raw === 'object' && raw.id) user = raw.user ?? raw;
    else if (raw) {
      const resolved = await resolveTarget(ctx);
      if (resolved.error) return ctx.error('Not found', resolved.error);
      user = resolved.user;
    }

    // The banner is not on the cached user object; it needs a fresh fetch.
    const fetched = await ctx.client.users.fetch(user.id, { force: true }).catch(() => null);
    if (!fetched) return ctx.error('Could not fetch', 'I could not load that user.');

    const url = fetched.bannerURL({ size: 1024 });
    if (!url) {
      return ctx.reply({
        embeds: [embeds.info('No banner', `**${fetched.tag ?? fetched.username}** has not set a profile banner.`)],
      });
    }

    const embed = embeds.embed({
      color: fetched.accentColor ?? COLORS.brand,
      title: `${fetched.tag ?? fetched.username}'s banner`,
      description: `[PNG](${fetched.bannerURL({ size: 1024, extension: 'png' })})`
        + (fetched.banner?.startsWith('a_') ? ` • [GIF](${fetched.bannerURL({ size: 1024, extension: 'gif' })})` : ''),
    });
    embed.setImage(url);
    await ctx.reply({ embeds: [embed] });
  },
});

// ---------------------------------------------------------------------------
// /icon
// ---------------------------------------------------------------------------

const icon = defineCommand({
  name: 'icon',
  description: 'Show the server icon',
  module: 'server',
  node: 'server.info',
  cooldown: 3,
  async run(ctx) {
    const url = ctx.guild.iconURL({ size: 1024 });
    if (!url) {
      return ctx.reply({ embeds: [embeds.info('No icon', 'This server has no icon set.')] });
    }

    const embed = embeds.embed({
      color: COLORS.brand,
      title: `${ctx.guild.name} icon`,
      description: [
        `[PNG](${ctx.guild.iconURL({ size: 1024, extension: 'png' })})`,
        `[JPG](${ctx.guild.iconURL({ size: 1024, extension: 'jpg' })})`,
        `[WEBP](${ctx.guild.iconURL({ size: 1024, extension: 'webp' })})`,
      ].join(' • '),
    });
    embed.setImage(url);

    await ctx.reply({ embeds: [embed] });
  },
});

// ---------------------------------------------------------------------------
// /emojis
// ---------------------------------------------------------------------------

const emojis = defineCommand({
  name: 'emojis',
  description: 'List the server\'s custom emojis',
  module: 'server',
  node: 'server.info',
  cooldown: 5,
  args: [
    {
      name: 'type',
      type: 'string',
      required: false,
      description: 'Filter by type',
      choices: [
        { name: 'All', value: 'all' },
        { name: 'Static', value: 'static' },
        { name: 'Animated', value: 'animated' },
      ],
    },
  ],

  async run(ctx) {
    const filter = ctx.get('type') || 'all';

    let list = [...ctx.guild.emojis.cache.values()];
    if (filter === 'static') list = list.filter((emoji) => !emoji.animated);
    if (filter === 'animated') list = list.filter((emoji) => emoji.animated);

    if (list.length === 0) {
      return ctx.reply({
        embeds: [embeds.info('No emojis', filter === 'all'
          ? 'This server has no custom emojis.'
          : `This server has no ${filter} emojis.`)],
      });
    }

    list.sort((a, b) => a.name.localeCompare(b.name));

    // 20 per page keeps each embed well inside the 4096 char description limit.
    const perPage = 20;
    const pages = [];

    for (let index = 0; index < list.length; index += perPage) {
      const slice = list.slice(index, index + perPage);
      const embed = embeds.embed({
        color: COLORS.brand,
        title: `Emojis (${list.length})`,
        description: slice
          .map((emoji) => `${emoji.toString()} \`:${emoji.name}:\`${emoji.animated ? ' *(animated)*' : ''}`)
          .join('\n'),
      });
      embed.setFooter({
        text: `Page ${Math.floor(index / perPage) + 1} of ${Math.ceil(list.length / perPage)} • ${config.brandFooterText}`,
      });
      pages.push(embed);
    }

    await ctx.paginate(pages);
  },
});

// ---------------------------------------------------------------------------
// /invites
// ---------------------------------------------------------------------------

const invites = defineCommand({
  name: 'invites',
  description: 'List active invites for this server',
  module: 'server',
  node: 'server.info',
  cooldown: 5,
  args: [
    { name: 'user', type: 'user', required: false, description: 'Only show invites created by this user' },
  ],

  async run(ctx) {
    const live = await ctx.guild.invites.fetch().catch(() => null);

    if (!live) {
      return ctx.error(
        'Cannot read invites',
        'I need the **Manage Server** permission to list invites.',
      );
    }

    const filterUser = ctx.get('user');

    // Prefer live data, but fall back to the tracked table so history survives
    // an invite expiring.
    const tracker = require('./invite-tracker');
    const stored = await tracker.getStats(ctx.guild);

    let rows = [...live.values()].map((invite) => ({
      code: invite.code,
      uses: invite.uses ?? 0,
      maxUses: invite.maxUses ?? 0,
      inviter: invite.inviter ?? null,
      channel: invite.channel ?? null,
      expiresAt: invite.expiresAt ?? null,
      temporary: invite.temporary ?? false,
      live: true,
    }));

    // Include stored invites that are no longer live, so the totals are honest.
    const liveCodes = new Set(rows.map((row) => row.code));
    for (const entry of stored) {
      if (liveCodes.has(entry.code)) continue;
      rows.push({
        code: entry.code,
        uses: entry.uses,
        maxUses: entry.maxUses ?? 0,
        inviter: entry.inviterId ? { id: entry.inviterId } : null,
        channel: null,
        expiresAt: null,
        temporary: false,
        live: false,
      });
    }

    if (filterUser) {
      rows = rows.filter((row) => row.inviter?.id === filterUser.id);
    }

    if (rows.length === 0) {
      return ctx.reply({
        embeds: [embeds.info('No invites', filterUser
          ? `<@${filterUser.id}> has no active invites.`
          : 'This server has no active invites.')],
      });
    }

    rows.sort((a, b) => b.uses - a.uses);

    const totalUses = rows.reduce((sum, row) => sum + row.uses, 0);

    const perPage = 15;
    const pages = [];

    for (let index = 0; index < rows.length; index += perPage) {
      const slice = rows.slice(index, index + perPage);
      const embed = embeds.embed({
        color: COLORS.brand,
        title: `Invites (${rows.length})`,
        description: `Total uses across all invites: **${helpers.formatNumber(totalUses)}**`,
      });

      for (const row of slice) {
        const details = [
          row.inviter ? `by <@${row.inviter.id}>` : 'by unknown',
          `${row.uses}${row.maxUses ? `/${row.maxUses}` : ''} uses`,
          row.channel ? `in <#${row.channel.id}>` : null,
          row.expiresAt ? `expires ${helpers.timestamp(row.expiresAt, 'R')}` : 'never expires',
          row.live ? null : '*(no longer active)*',
        ].filter(Boolean).join(' • ');

        embed.addFields({ name: `discord.gg/${row.code}`, value: details });
      }

      embed.setFooter({
        text: `Page ${Math.floor(index / perPage) + 1} of ${Math.ceil(rows.length / perPage)} • ${config.brandFooterText}`,
      });
      pages.push(embed);
    }

    await ctx.paginate(pages);
  },
});

// ---------------------------------------------------------------------------
// /boosters
// ---------------------------------------------------------------------------

const boosters = defineCommand({
  name: 'boosters',
  description: 'List members currently boosting this server',
  module: 'server',
  node: 'server.info',
  cooldown: 5,
  async run(ctx) {
    const boosters = [...ctx.guild.members.cache.values()]
      .filter((member) => member.premiumSince)
      .sort((a, b) => a.premiumSince.getTime() - b.premiumSince.getTime());

    if (boosters.length === 0) {
      return ctx.reply({
        embeds: [embeds.info(
          'No boosters',
          `This server has no boosts yet.\n\nBoost tier: **${ctx.guild.premiumTier}**`,
        )],
      });
    }

    const perPage = 12;
    const pages = [];

    for (let index = 0; index < boosters.length; index += perPage) {
      const slice = boosters.slice(index, index + perPage);
      const embed = embeds.embed({
        color: COLORS.pink,
        title: `💎 Boosters (${boosters.length})`,
        description: `Boost tier **${ctx.guild.premiumTier}** • `
          + `**${ctx.guild.premiumSubscriptionCount ?? boosters.length}** boost(s)`,
      });

      for (const member of slice) {
        embed.addFields({
          name: member.user.tag ?? member.user.username,
          value: `<@${member.id}> • boosting since ${helpers.timestamp(member.premiumSince, 'R')}`,
        });
      }

      embed.setFooter({
        text: `Page ${Math.floor(index / perPage) + 1} of ${Math.ceil(boosters.length / perPage)} • ${config.brandFooterText}`,
      });
      pages.push(embed);
    }

    await ctx.paginate(pages);
  },
});

// ---------------------------------------------------------------------------
// /members
// ---------------------------------------------------------------------------

const members = defineCommand({
  name: 'members',
  description: 'Show a breakdown of the server\'s members',
  module: 'server',
  node: 'server.info',
  cooldown: 5,
  async run(ctx) {
    const guild = ctx.guild;
    const cached = [...guild.members.cache.values()];

    const bots = cached.filter((member) => member.user.bot);
    const humans = cached.filter((member) => !member.user.bot);
    const online = cached.filter((member) => member.presence && member.presence.status !== 'offline');
    const boosting = cached.filter((member) => member.premiumSince);

    const embed = embeds.embed({
      color: COLORS.brand,
      title: `${guild.name} - member breakdown`,
    });

    embed.addFields(
      { name: 'Total', value: helpers.formatNumber(guild.memberCount), inline: true },
      { name: 'Humans', value: helpers.formatNumber(humans.length), inline: true },
      { name: 'Bots', value: helpers.formatNumber(bots.length), inline: true },
    );

    // Presence is only populated for cached members, so label it clearly.
    if (online.length > 0) {
      embed.addFields({
        name: 'Online (cached)',
        value: helpers.formatNumber(online.length),
        inline: true,
      });
    }

    embed.addFields(
      { name: 'Boosting', value: helpers.formatNumber(boosting.length), inline: true },
      { name: 'Bots %', value: `${helpers.formatNumber(Math.round((bots.length / Math.max(1, cached.length)) * 100))}%`, inline: true },
    );

    // Join trend over the last 30 days, from the daily snapshots.
    const db = require('../../db');
    const snapshots = await db.select('member_snapshots', {
      where: { guild_id: guild.id },
      order: { column: 'day', ascending: false },
      limit: 30,
      optional: true,
      fallback: [],
    });

    if (snapshots.length >= 2) {
      const newest = snapshots[0];
      const oldest = snapshots[snapshots.length - 1];
      const xp = require('../../lib/xp');
      embed.addFields({
        name: `Growth (last ${snapshots.length} days)`,
        value: `${xp.trendIcon(oldest.member_count, newest.member_count)} ${xp.delta(oldest.member_count, newest.member_count)}`,
      });
    }

    // Top roles by member count, which is usually what people want next.
    const roleCounts = [...guild.roles.cache.values()]
      .filter((role) => role.id !== guild.id && !role.managed)
      .map((role) => ({
        role,
        count: cached.filter((member) => member.roles.cache.has(role.id)).length,
      }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    if (roleCounts.length > 0) {
      embed.addFields({
        name: 'Largest roles',
        value: roleCounts.map((entry) => `<@&${entry.role.id}>: **${entry.count}**`).join('\n'),
      });
    }

    await ctx.reply({ embeds: [embed] });
  },
});

// ---------------------------------------------------------------------------
// /ping
// ---------------------------------------------------------------------------

const ping = defineCommand({
  name: 'ping',
  description: 'Check the bot\'s latency',
  module: 'server',
  node: null,
  aliases: ['pong', 'latency'],
  cooldown: 3,
  async run(ctx) {
    // Measure a real round trip rather than reporting a cached value.
    const sentAt = Date.now();
    const message = await ctx.reply({
      embeds: [embeds.embed({ color: COLORS.brand, title: 'Pinging…' })],
    });
    const roundTrip = Date.now() - sentAt;

    const ws = Math.round(ctx.client.ws.ping);
    const db = require('../../db');
    const health = await db.ping();

    const quality = ws < 100 && roundTrip < 300 ? 'Excellent'
      : ws < 200 && roundTrip < 600 ? 'Good'
        : ws < 400 ? 'Fair' : 'Poor';

    const embed = embeds.embed({
      color: ws < 200 ? COLORS.success : ws < 400 ? COLORS.warning : COLORS.danger,
      title: '🏓 Pong',
      description: `Connection quality: **${quality}**`,
    });

    embed.addFields(
      { name: 'WebSocket', value: `${ws}ms`, inline: true },
      { name: 'Round trip', value: `${roundTrip}ms`, inline: true },
      {
        name: 'Database',
        value: health.enabled
          ? (health.ok ? `${health.latencyMs}ms` : '❌ unreachable')
          : 'not configured',
        inline: true,
      },
    );

    await ctx.editReply({ embeds: [embed] });
    void message;
  },
});

// ---------------------------------------------------------------------------
// /uptime
// ---------------------------------------------------------------------------

const uptime = defineCommand({
  name: 'uptime',
  description: 'Show how long the bot has been running',
  module: 'server',
  node: null,
  aliases: ['up'],
  cooldown: 3,
  async run(ctx) {
    const seconds = Math.floor(process.uptime());
    const memory = process.memoryUsage();
    const startedAt = new Date(Date.now() - seconds * 1000);

    const embed = embeds.embed({
      color: COLORS.success,
      title: '⏱️ Uptime',
      description: `Running for **${helpers.formatDuration(seconds)}**`,
    });

    embed.addFields(
      { name: 'Started', value: helpers.timestamp(startedAt, 'R'), inline: true },
      { name: 'Exact', value: helpers.formatDuration(seconds, { units: 4 }), inline: true },
      { name: 'Node', value: process.version, inline: true },
      { name: 'Heap used', value: `${Math.round(memory.heapUsed / 1048576)} MB`, inline: true },
      { name: 'RSS', value: `${Math.round(memory.rss / 1048576)} MB`, inline: true },
      { name: 'Guilds', value: helpers.formatNumber(ctx.client.guilds.cache.size), inline: true },
    );

    await ctx.reply({ embeds: [embed] });
  },
});

// ---------------------------------------------------------------------------
// /botinfo
// ---------------------------------------------------------------------------

const botinfo = defineCommand({
  name: 'botinfo',
  description: 'Show information about this bot',
  module: 'server',
  node: null,
  aliases: ['bi', 'about', 'info'],
  cooldown: 3,
  async run(ctx) {
    const client = ctx.client;
    const registry = client.registry;

    const seconds = Math.floor(process.uptime());
    const memory = process.memoryUsage();

    const embed = embeds.embed({
      color: COLORS.brand,
      title: `🤖 ${client.user.username}`,
      // Branding requirement: name and discord handle on the primary embed.
      description: [
        `**${config.brand.footer}**`,
        `**${config.brand.discord}**`,
        config.brand.link ? `[${config.brand.link}](${config.brand.link})` : null,
      ].filter(Boolean).join('\n'),
    });

    embed.setThumbnail(client.user.displayAvatarURL({ size: 256 }));

    embed.addFields(
      { name: 'Servers', value: helpers.formatNumber(client.guilds.cache.size), inline: true },
      { name: 'Users (cached)', value: helpers.formatNumber(client.users.cache.size), inline: true },
      { name: 'Commands', value: helpers.formatNumber(registry?.list?.length ?? 0), inline: true },
      { name: 'Uptime', value: helpers.formatDuration(seconds, { units: 2 }), inline: true },
      { name: 'Ping', value: `${Math.round(client.ws.ping)}ms`, inline: true },
      { name: 'Memory', value: `${Math.round(memory.heapUsed / 1048576)} MB`, inline: true },
      { name: 'discord.js', value: `v${djsVersion}`, inline: true },
      { name: 'Node.js', value: process.version, inline: true },
      { name: 'Locale', value: ctx.locale, inline: true },
    );

    const db = require('../../db');
    const health = await db.ping();
    embed.addFields({
      name: 'Database',
      value: health.enabled
        ? (health.ok ? `✅ Connected (${health.latencyMs}ms)` : `❌ ${health.error}`)
        : '⚠️ Not configured',
      inline: true,
    });

    if (ctx.guild) {
      embed.addFields({ name: 'Prefix here', value: `\`${ctx.prefix}\``, inline: true });
    }

    embed.setFooter({ text: config.brandFooterText });
    await ctx.reply({ embeds: [embed] });
  },
});

module.exports = {
  commands: [
    serverinfo, userinfo, roleinfo, channelinfo, avatar, banner, icon,
    emojis, invites, boosters, members, ping, uptime, botinfo,
  ],
};
