'use strict';

/**
 * Module 13 - User Profiles.
 *
 *   /profile view | bio | badge | birthday | timezone | privacy | rep | stats
 *   /afk
 *
 * Profiles are global (one row per user). Reputation is per guild. Privacy
 * flags decide what other members see.
 */

const { defineCommand } = require('../../core/command');
const helpers = require('../../lib/helpers');
const embeds = require('../../lib/embeds');
const xp = require('../../lib/xp');
const config = require('../../config');
const { COLORS, BADGES } = require('../../lib/constants');
const store = require('./profile-store');

/** Render the badge list as emoji + labels. */
function badgeList(badges) {
  const list = Array.isArray(badges) ? badges : [];
  if (list.length === 0) return '*no badges yet*';
  return list
    .map((id) => (BADGES[id] ? `${BADGES[id].emoji} ${BADGES[id].label}` : id))
    .join(' • ');
}

const profile = defineCommand({
  name: 'profile',
  description: 'Your or another member\'s profile',
  module: 'profile',
  node: 'profile.view',
  aliases: ['me', 'pfp'],
  cooldown: 3,
  subcommands: [
    {
      name: 'view',
      description: 'Show a profile',
      args: [
        { name: 'user', type: 'user', required: false, description: 'Whose profile (default: you)' },
      ],
    },
    {
      name: 'bio',
      description: 'Set your bio',
      args: [
        { name: 'text', type: 'string', required: true, description: 'Your bio (max 400 characters)', maxLength: 400 },
      ],
    },
    {
      name: 'badge',
      description: 'Show off or hide a badge you own',
      args: [
        { name: 'badge', type: 'string', required: true, description: 'Which badge', choices: Object.values(BADGES).map((badge) => ({ name: `${badge.emoji} ${badge.label}`, value: badge.id })) },
        { name: 'show', type: 'boolean', required: false, description: 'Show or hide it (default: show)' },
      ],
    },
    {
      name: 'birthday',
      description: 'Set your birthday',
      args: [
        { name: 'date', type: 'string', required: true, description: 'Month and day, e.g. 03-14', maxLength: 10 },
      ],
    },
    {
      name: 'timezone',
      description: 'Set your timezone',
      args: [
        { name: 'zone', type: 'string', required: true, description: 'IANA timezone, e.g. Europe/London', maxLength: 60 },
      ],
    },
    {
      name: 'privacy',
      description: 'Choose what others can see',
      args: [
        { name: 'field', type: 'string', required: true, description: 'Which field', choices: Object.keys(store.DEFAULT_PRIVACY).map((key) => ({ name: key, value: key })) },
        { name: 'visible', type: 'boolean', required: true, description: 'Whether others can see it' },
      ],
    },
    {
      name: 'rep',
      description: 'Give someone reputation',
      args: [
        { name: 'user', type: 'user', required: true, description: 'Who to give reputation to' },
        { name: 'reason', type: 'string', required: false, description: 'Why', maxLength: 200 },
      ],
    },
    {
      name: 'stats',
      description: 'Your server statistics',
      args: [
        { name: 'user', type: 'user', required: false, description: 'Whose stats (default: you)' },
      ],
    },
  ],

  async run(ctx) {
    const sub = ctx.subcommand?.name ?? 'view';

    const nodeMap = {
      view: 'profile.view',
      bio: 'profile.bio',
      badge: 'profile.badges',
      birthday: 'profile.birthday',
      timezone: 'profile.timezone',
      privacy: 'profile.privacy',
      rep: 'profile.rep',
      stats: 'profile.stats',
    };

    // Anyone may view their own profile; the node gate applies to edits and
    // to viewing someone else.
    const isSelfView = sub === 'view' && !ctx.get('user');
    if (!isSelfView) {
      const check = ctx.hasPermission(nodeMap[sub] ?? 'profile.view');
      if (!check.ok) return ctx.deny(check.reason);
    }

    switch (sub) {
      case 'view': return runView(ctx);
      case 'bio': return runBio(ctx);
      case 'badge': return runBadge(ctx);
      case 'birthday': return runBirthday(ctx);
      case 'timezone': return runTimezone(ctx);
      case 'privacy': return runPrivacy(ctx);
      case 'rep': return runRep(ctx);
      case 'stats': return runStats(ctx);
      default: return ctx.error('Unknown option', `\`${sub}\` is not available.`);
    }
  },
});

/** Resolve the target member from the `user` argument, defaulting to the caller. */
async function targetOf(ctx) {
  const raw = ctx.get('user');
  if (!raw) return ctx.member;

  const id = typeof raw === 'object' ? raw.id : helpers.extractId(String(raw));
  if (!id) return ctx.member;

  return ctx.guild.members.cache.get(id)
    ?? await ctx.guild.members.fetch(id).catch(() => null);
}

// ---------------------------------------------------------------------------

async function runView(ctx) {
  const member = await targetOf(ctx);
  if (!member) return ctx.error('Member not found', 'I could not find that member.');

  const row = await store.get(member.id);
  const isSelf = member.id === ctx.userId;

  const embed = embeds.embed({
    color: row?.color ? Number.parseInt(String(row.color).replace('#', ''), 16) || COLORS.brand : COLORS.brand,
    title: `${member.user.username}`,
    description: member.user.bot ? '🤖 Bot account' : null,
  });

  embed.setThumbnail(member.displayAvatarURL({ size: 256 }));

  const levelRow = await require('../levels/leveling-service').getUser(ctx.guildId, member.id).catch(() => null);
  const progress = xp.progressFromXp(Number(levelRow?.total_xp ?? 0));

  embed.addFields(
    { name: 'Level', value: `${progress.level} — ${xp.rankTitle(progress.level)}`, inline: true },
    { name: 'Reputation', value: `⭐ ${helpers.formatNumber(row?.reputation ?? 0)}`, inline: true },
    { name: 'Joined', value: member.joinedAt ? helpers.timestamp(member.joinedAt, 'R') : 'unknown', inline: true },
  );

  if (store.visible(row, 'bio')) {
    embed.addFields({ name: 'Bio', value: row?.bio ? helpers.truncate(row.bio, 400) : '*no bio set*' });
  }

  if (store.visible(row, 'badges')) {
    embed.addFields({ name: 'Badges', value: helpers.truncate(badgeList(row?.badges), 300) });
  }

  if ((isSelf || store.visible(row, 'birthday')) && row?.birthday) {
    embed.addFields({ name: '🎂 Birthday', value: String(row.birthday).slice(5), inline: true });
  }

  if (isSelf || store.visible(row, 'stats')) {
    embed.addFields({ name: 'Timezone', value: row?.timezone || 'UTC', inline: true });
  }

  embed.setFooter({ text: config.brandFooterText });
  return ctx.reply({ embeds: [embed] });
}

async function runBio(ctx) {
  const text = String(ctx.get('text') ?? '').trim();
  if (!text) return ctx.error('No bio', 'Write something for your bio.');

  await store.update(ctx.userId, { bio: text.slice(0, 400) });

  return ctx.reply({
    embeds: [embeds.success('Bio updated', helpers.truncate(text, 400))],
    ephemeral: true,
  });
}

async function runBadge(ctx) {
  const badgeId = ctx.get('badge');
  const show = ctx.get('show') !== false;

  const row = await store.ensure(ctx.userId);
  const owned = Array.isArray(row.badges) ? row.badges : [];

  if (!owned.includes(badgeId)) {
    return ctx.error('Badge not owned', `You do not have the ${BADGES[badgeId]?.label ?? badgeId} badge.`);
  }

  const next = show
    ? owned
    : owned.filter((id) => id !== badgeId);

  // Hiding a badge simply drops it; showing re-adds it if it was hidden.
  if (show && !owned.includes(badgeId)) next.push(badgeId);

  await store.update(ctx.userId, { badges: next });

  return ctx.reply({
    embeds: [embeds.success(show ? 'Badge shown' : 'Badge hidden', `${BADGES[badgeId]?.emoji ?? '🏅'} ${BADGES[badgeId]?.label ?? badgeId}`)],
    ephemeral: true,
  });
}

async function runBirthday(ctx) {
  const raw = String(ctx.get('date') ?? '').trim();

  // Accept MM-DD or DD/MM; store as YYYY-MM-DD with a placeholder year.
  const match = raw.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (!match) return ctx.error('Invalid date', 'Use `MM-DD`, for example `03-14`.');

  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return ctx.error('Invalid date', 'That is not a real month and day.');
  }

  const value = `2000-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  await store.update(ctx.userId, { birthday: value });

  return ctx.reply({
    embeds: [embeds.success('Birthday set', `I will note **${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}**.`)],
    ephemeral: true,
  });
}

async function runTimezone(ctx) {
  const zone = String(ctx.get('zone') ?? '').trim();
  if (!helpers.isValidTimezone(zone)) {
    return ctx.error('Unknown timezone', 'Use an IANA name such as `Europe/London`.');
  }

  await store.update(ctx.userId, { timezone: zone });

  return ctx.reply({
    embeds: [embeds.success('Timezone set', `Your timezone is now **${zone}**.`)],
    ephemeral: true,
  });
}

async function runPrivacy(ctx) {
  const field = ctx.get('field');
  const visible = ctx.get('visible') === true;

  const result = await store.setPrivacy(ctx.userId, field, visible);
  if (!result.ok) return ctx.error('Could not update privacy', result.error);

  return ctx.reply({
    embeds: [embeds.success('Privacy updated', `**${field}** is now ${visible ? 'visible' : 'hidden'}.`)],
    ephemeral: true,
  });
}

async function runRep(ctx) {
  const member = await targetOf(ctx);
  if (!member) return ctx.error('Member not found', 'I could not find that member.');

  const result = await store.giveReputation(ctx.guildId, ctx.userId, member.id, ctx.get('reason'));
  if (!result.ok) return ctx.error('Could not give reputation', result.error);

  return ctx.reply({
    embeds: [embeds.success('Reputation given', `⭐ You gave **${member.user.username}** reputation. They now have **${helpers.formatNumber(result.total)}**.`)],
  });
}

async function runStats(ctx) {
  const member = await targetOf(ctx);
  if (!member) return ctx.error('Member not found', 'I could not find that member.');

  const levels = require('../levels/leveling-service');
  const row = await levels.getUser(ctx.guildId, member.id).catch(() => null);
  const settings = levels.settings(await require('../../db').getGuildConfig(ctx.guildId).catch(() => ({})));
  const rankPosition = row ? await levels.rankOf(ctx.guildId, Number(row.total_xp ?? 0)).catch(() => null) : null;
  const total = await levels.totalRanked(ctx.guildId).catch(() => 0);

  const progress = xp.progressFromXp(Number(row?.total_xp ?? 0));

  const embed = embeds.embed({
    color: COLORS.brand,
    title: `📊 ${member.user.username}`,
    description: `${xp.renderBar(Number(row?.total_xp ?? 0))}\n**Level ${progress.level}** — ${xp.rankTitle(progress.level)}`,
  });

  embed.addFields(
    { name: 'Rank', value: rankPosition ? `#${rankPosition} of ${helpers.formatNumber(total)}` : 'unranked', inline: true },
    { name: 'Total XP', value: helpers.formatNumber(progress.totalXp), inline: true },
    { name: 'Messages', value: helpers.formatNumber(row?.messages ?? 0), inline: true },
    { name: 'Voice', value: xp.voiceTime(row?.voice_seconds ?? 0), inline: true },
    { name: 'Reputation', value: `⭐ ${helpers.formatNumber((await store.get(member.id))?.reputation ?? 0)}`, inline: true },
    { name: 'XP per message', value: `${settings.minXp}-${settings.maxXp}`, inline: true },
  );

  embed.setFooter({ text: config.brandFooterText });
  return ctx.reply({ embeds: [embed] });
}

module.exports = profile;
