'use strict';

/**
 * /afk - mark yourself away.
 *
 * The message event clears the status automatically when you next speak and
 * notifies anyone who mentions you while you are away.
 */

const { defineCommand } = require('../../core/command');
const embeds = require('../../lib/embeds');
const helpers = require('../../lib/helpers');
const afk = require('./afk-store');

const command = defineCommand({
  name: 'afk',
  description: 'Let people know you are away',
  module: 'profile',
  node: 'profile.afk',
  aliases: ['away'],
  cooldown: 5,
  args: [
    { name: 'reason', type: 'string', required: false, description: 'Why you are away', maxLength: 200 },
  ],

  async run(ctx) {
    const existing = await afk.get(ctx.guildId, ctx.userId);
    const reason = ctx.get('reason');

    // Running it with no reason while already AFK clears the status.
    if (existing && !reason) {
      await afk.clear(ctx.guildId, ctx.userId);
      return ctx.reply({
        embeds: [embeds.success('Welcome back', 'Your AFK status has been cleared.')],
      });
    }

    await afk.set(ctx.guildId, ctx.userId, reason ?? 'AFK');

    return ctx.reply({
      embeds: [
        embeds.info(
          'AFK set',
          [
            `💤 You are now marked as away${reason ? `: **${helpers.truncate(reason, 200)}**` : ''}.`,
            'Anyone who mentions you will be told, and speaking here will clear it automatically.',
          ].join('\n'),
        ),
      ],
      ephemeral: true,
    });
  },
});

module.exports = command;
