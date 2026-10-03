'use strict';

/**
 * Unified command context.
 *
 * This is the piece that makes hybrid slash + prefix commands possible without
 * duplicating a single handler. Both entry points construct a `Context`, and
 * handlers only ever talk to this object.
 *
 * The differences between the two sources are absorbed here:
 *
 *   | concern        | slash                        | prefix                     |
 *   |----------------|------------------------------|----------------------------|
 *   | reply          | interaction.reply            | channel.send                |
 *   | ephemeral      | supported                    | not possible - falls back   |
 *   | arguments      | options.getString()          | parsed tokens               |
 *   | reply target   | interaction.reply            | message.reply               |
 *   | edit own reply | interaction.editReply        | message.edit                |
 *
 * Handlers call ctx.reply / ctx.error / ctx.args / ctx.member and never need to
 * know which source triggered them.
 */

const {
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');

const config = require('../config');
const logger = require('../lib/logger');
const embeds = require('../lib/embeds');
const ui = require('../lib/ui');
const permissions = require('../lib/permissions');
const helpers = require('../lib/helpers');

const log = logger.child('context');

/** Where the command came from. */
const SOURCE = Object.freeze({ SLASH: 'slash', PREFIX: 'prefix', COMPONENT: 'component' });

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

class Context {
  /**
   * @param {object} params
   * @param {import('discord.js').Client} params.client
   * @param {import('discord.js').ChatInputCommandInteraction|import('discord.js').Message} params.source
   * @param {'slash'|'prefix'} params.kind
   * @param {object} params.command              the command definition
   * @param {import('discord.js').Guild|null} params.guild
   * @param {import('discord.js').GuildMember|null} params.member
   * @param {import('discord.js').User} params.user
   * @param {import('discord.js').GuildBasedChannel|null} params.channel
   * @param {object} params.guildConfig
   * @param {Record<string, any>} [params.args]  resolved arguments
   * @param {string[]} [params.rawArgs]          raw tokens for prefix commands
   * @param {object} [params.subcommand]         { group, name } when nested
   * @param {import('discord.js').Message|null} [params.message]
   */
  constructor(params) {
    this.client = params.client;
    this.source = params.source;
    this.kind = params.kind;
    this.command = params.command;
    this.guild = params.guild;
    this.member = params.member;
    this.user = params.user;
    this.channel = params.channel;
    this.guildConfig = params.guildConfig || {};
    this.args = params.args || {};
    this.rawArgs = params.rawArgs || [];
    this.subcommand = params.subcommand || null;
    this.message = params.message || null;

    /** @type {import('discord.js').Message|null} */
    this._replyMessage = null;
    /** Tracks whether we already replied, for the prefix path. */
    this._replied = false;
    /** Set when a handler wants the trigger message removed. */
    this.autoDeleteTrigger = false;

    this.log = log.child(params.command?.name || 'unknown');
  }

  // -------------------------------------------------------------------------
  // Identity shortcuts
  // -------------------------------------------------------------------------

  get interaction() {
    return this.kind === SOURCE.SLASH ? this.source : null;
  }

  get isSlash() { return this.kind === SOURCE.SLASH; }
  get isPrefix() { return this.kind === SOURCE.PREFIX; }

  get guildId() { return this.guild?.id ?? null; }
  get channelId() { return this.channel?.id ?? null; }
  get userId() { return this.user.id; }

  /** Display name: nickname in the guild when available, else username. */
  get displayName() {
    return this.member?.displayName || this.user.globalName || this.user.username;
  }

  get locale() {
    return this.interaction?.locale || 'en-US';
  }

  /** The prefix this guild uses, for help text and usage strings. */
  get prefix() {
    return this.guildConfig?.prefix || config.defaultPrefix;
  }

  // -------------------------------------------------------------------------
  // Capability checks
  // -------------------------------------------------------------------------

  /**
   * Can the bot send embeds and use components in this channel?
   * @returns {{ ok: boolean, reason: string|null }}
   */
  canSend() {
    if (!this.channel || !this.guild) return { ok: true, reason: null };

    const me = this.guild.members.me;
    if (!me) return { ok: false, reason: 'I am not cached in this server yet.' };

    const perms = this.channel.permissionsFor(me);
    if (!perms) return { ok: false, reason: 'I cannot resolve my permissions in this channel.' };

    const needed = [
      [PermissionFlagsBits.ViewChannel, 'View Channel'],
      [PermissionFlagsBits.SendMessages, 'Send Messages'],
      [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
    ];

    const missing = needed.filter(([bit]) => !perms.has(bit)).map(([, name]) => name);
    if (missing.length > 0) {
      return { ok: false, reason: `I am missing these permissions here: **${missing.join(', ')}**.` };
    }
    return { ok: true, reason: null };
  }

  /** Does the invoking member hold the node(s) required by this command? */
  /**
   * @param {string|string[]|null} [node]
   * @returns {{ ok: boolean, reason: string|null, code: string|null }}
   */
  hasPermission(node) {
    const required = node ?? this.command?.node ?? null;
    return permissions.check({
      member: this.member,
      guildConfig: this.guildConfig,
      node: required,
      userPerms: this.command?.userPerms ?? null,
      guildOnly: this.command?.guildOnly !== false,
    });
  }

  /** Is this user a bot admin / guild owner? */
  isAdmin() {
    if (!this.member) return false;
    if (config.adminIds.includes(this.user.id)) return true;
    return this.guild?.ownerId === this.user.id;
  }

  // -------------------------------------------------------------------------
  // Replying
  // -------------------------------------------------------------------------

  /**
   * Send a response.
   *
   * `ephemeral` is honoured on slash commands and silently ignored on prefix
   * commands, where Discord has no such concept - the embed simply appears in
   * the channel. Handlers should not need to care.
   *
   * @param {object} payload { embeds?, content?, components?, files?, ephemeral?, fetchReply? }
   * @returns {Promise<import('discord.js').Message>}
   */
  async reply(payload = {}) {
    const {
      embeds: embedList,
      content,
      components,
      files,
      ephemeral = false,
      allowedMentions,
      fetchReply = true,
    } = payload;

    const normalised = {
      embeds: embedList ? (Array.isArray(embedList) ? embedList : [embedList]) : undefined,
      content: content ?? undefined,
      components: components ?? undefined,
      files: files ?? undefined,
      allowedMentions: allowedMentions ?? { parse: ['users'] },
    };

    // Slash path ------------------------------------------------------------
    if (this.isSlash) {
      const interaction = this.interaction;

      if (interaction.deferred || interaction.replied) {
        const message = await interaction.followUp({ ...normalised, ephemeral });
        this._replyMessage = message;
        this._replied = true;
        return message;
      }

      const response = await interaction.reply({
        ...normalised,
        ephemeral,
        withResponse: true,
      });

      const message = response?.resource?.message ?? response;
      this._replyMessage = message ?? null;
      this._replied = true;
      return message;
    }

    // Prefix path -----------------------------------------------------------
    // An empty content string is invalid for Discord, and a payload with only
    // components crashes, so always guarantee at least one part.
    if (!normalised.content && !normalised.embeds && !normalised.files) {
      normalised.content = '\u200b';
    }
    if (normalised.content === '' ) normalised.content = undefined;

    const target = this.message
      ? await this.message.reply({ ...normalised, fetchReply })
      : await this.channel.send(normalised);

    this._replyMessage = target;
    this._replied = true;
    return target;
  }

  /**
   * Edit the bot's own previous reply.
   * @param {object} payload
   */
  async editReply(payload) {
    if (this.isSlash) {
      return this.interaction.editReply(payload);
    }
    if (this._replyMessage) {
      return this._replyMessage.edit(payload);
    }
    return this.reply(payload);
  }

  /**
   * Defer a slow response so we do not hit the 3 second interaction timeout.
   * No-op on prefix commands.
   * @param {{ ephemeral?: boolean }} [options]
   */
  async defer(options = {}) {
    if (!this.isSlash) return;
    const { ephemeral = true } = options;
    if (this.interaction.deferred || this.interaction.replied) return;
    await this.interaction.deferReply({ ephemeral });
  }

  /**
   * Acknowledge a component interaction (button / select / modal) ephemerally.
   * @param {object|string} [payload]
   */
  async acknowledge(payload = {}) {
    if (!this.source?.isRepliable?.()) return;
    const normalised = typeof payload === 'string' ? { content: payload } : payload;
    const flags = normalised.ephemeral === false ? undefined : MessageFlags.Ephemeral;
    await this.source.reply({ ...normalised, flags, ephemeral: normalised.ephemeral === false ? undefined : true })
      .catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Shorthand responders
  // -------------------------------------------------------------------------

  /** Green success embed. */
  async success(title, description, options = {}) {
    return this.reply({ embeds: [embeds.success(title, description)], ...options });
  }

  /** Red error embed. */
  async error(title, description, options = {}) {
    return this.reply({ embeds: [embeds.error(title, description)], ...options });
  }

  /** Yellow warning embed. */
  async warn(title, description, options = {}) {
    return this.reply({ embeds: [embeds.warning(title, description)], ...options });
  }

  /** Blurple info embed. */
  async info(title, description, options = {}) {
    return this.reply({ embeds: [embeds.info(title, description)], ...options });
  }

  /**
   * Report that the caller lacks permission.
   * @param {string} [reason]
   */
  async deny(reason) {
    const message = reason || 'You do not have permission to use this command.';
    if (this.isSlash) return this.reply({ embeds: [embeds.error('Missing permission', message)], ephemeral: true });
    return this.reply({ embeds: [embeds.error('Missing permission', message)] });
  }

  /**
   * Report a handler failure, hiding internals in production.
   * @param {Error} error
   */
  async fail(error) {
    this.log.error(`handler failed (${this.kind}):`, error);
    const detail = config.isProduction
      ? 'Something went wrong while running this command. The error has been logged.'
      : `\`\`\`${helpers.truncate(error?.stack || error?.message || String(error), 1500)}\`\`\``;
    try {
      return await this.reply({ embeds: [embeds.error('Command failed', detail)], ephemeral: true });
    } catch {
      return null;
    }
  }

  /** Ask for confirmation of a destructive action. */
  async confirm(options) {
    return ui.confirm(this, options);
  }

  /** Paginate a list of embeds. */
  async paginate(pages, options) {
    return ui.paginate(this, pages, options);
  }

  // -------------------------------------------------------------------------
  // Modal support
  // -------------------------------------------------------------------------

  /**
   * Show a modal (slash only) and return the interaction for awaiting submit.
   *
   * Prefix commands cannot show modals, so `null` is returned and callers fall
   * back to their prefix argument path.
   *
   * @param {import('discord.js').ModalBuilder} modal
   * @returns {Promise<import('discord.js').ModalSubmitInteraction|null>}
   */
  async showModal(modal) {
    if (!this.isSlash) return null;
    try {
      await this.interaction.showModal(modal);
      return this.interaction;
    } catch (error) {
      this.log.warn('showModal failed:', error.message);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Argument access
  // -------------------------------------------------------------------------

  /**
   * Read an argument.
   *
   * On slash commands this pulls from the interaction options; on prefix
   * commands it reads the parsed token by name or position. Handlers therefore
   * use `ctx.get('user')` regardless of source.
   *
   * @param {string} name
   * @param {any} [fallback]
   */
  get(name, fallback = null) {
    if (this.isSlash) {
      const interaction = this.interaction;
      const options = interaction.options;

      // Try, in order: subcommand option, plain option.
      const fromOption = safeCall(() => options.get(name));
      if (fromOption !== null && fromOption !== undefined) return unwrapOption(fromOption);

      // Some options are declared on a subcommand; look them up explicitly.
      const sub = this.subcommand?.name || this.subcommand?.group;
      if (sub) {
        const nested = safeCall(() => options.getSubcommandGroup(false));
        void nested;
      }

      return fallback;
    }

    // Prefix: named token first, then positional.
    if (Object.prototype.hasOwnProperty.call(this.args, name)) {
      const value = this.args[name];
      return value === undefined ? fallback : value;
    }
    return fallback;
  }

  /**
   * Positional argument access for prefix-style usage inside a handler.
   * @param {number} index zero based
   * @param {any} [fallback]
   */
  arg(index, fallback = null) {
    const value = this.rawArgs[index];
    return value === undefined ? fallback : value;
  }

  /** The raw argument string (prefix only). */
  get rawArgsText() {
    return this.rawArgs.join(' ');
  }

  // -------------------------------------------------------------------------
  // Trigger cleanup
  // -------------------------------------------------------------------------

  /**
   * Delete the prefix trigger message, when configured and permitted.
   * Called by the prefix runner after the handler succeeds.
   */
  async cleanupTrigger() {
    if (!this.message || !this.guild) return;
    if (!this.guildConfig?.prefix_delete_message) return;
    if (this.autoDeleteTrigger === false) return;

    const me = this.guild.members.me;
    if (!me) return;
    if (!this.channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)) return;

    try {
      await this.message.delete();
    } catch (error) {
      this.log.debug('could not delete trigger message:', error.message);
    }
  }

  /** Build a mention for the invoking user. */
  get userMention() {
    return `<@${this.user.id}>`;
  }

  /** Build a usage string, e.g. `.ban <user> [reason]` or `/ban`. */
  usage() {
    if (this.isSlash) return `/${this.command.name}`;
    const args = this.command?.usage ? ` ${this.command.usage}` : '';
    return `${this.prefix}${this.command.name}${args}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a getter, returning null on throw. */
function safeCall(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * Normalise a discord.js option into a plain value.
 *
 * Without this, handlers would receive a wrapper object for mentions, so
 * `ctx.get('user')` would not be a User. Everything the modules care about is
 * unwrapped here.
 *
 * @param {any} option
 */
function unwrapOption(option) {
  if (option === null || option === undefined) return option;

  // discord.js option classes expose typed getters that throw when the wrong
  // type is requested, so probe from most specific to least.
  const typed = [
    () => option.getMember?.(false),
    () => option.getUser?.(),
    () => option.getRole?.(),
    () => option.getChannel?.(),
    () => option.getMentionable?.(),
    () => option.getAttachment?.(),
  ];

  for (const attempt of typed) {
    const value = safeCall(attempt);
    if (value !== null && value !== undefined) return value;
  }

  // handle subcommands
  const sub = safeCall(() => option.getSubcommand?.());
  if (sub) return sub;

  return option.value;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a Context for a slash command interaction.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {object} command
 * @param {object} guildConfig
 */
function fromInteraction(interaction, command, guildConfig) {
  const subcommandGroup = interaction.options.getSubcommandGroup(false);
  const subcommandName = interaction.options.getSubcommand(false);

  return new Context({
    client: interaction.client,
    source: interaction,
    kind: SOURCE.SLASH,
    command,
    guild: interaction.guild ?? null,
    member: interaction.member ?? null,
    user: interaction.user,
    channel: interaction.channel ?? null,
    guildConfig,
    args: {},
    rawArgs: [],
    subcommand: subcommandName ? { group: subcommandGroup, name: subcommandName } : null,
  });
}

/**
 * Build a Context for a prefix message.
 *
 * @param {import('discord.js').Message} message
 * @param {object} command
 * @param {object} guildConfig
 * @param {{ args: Record<string, any>, rawArgs: string[], subcommand?: object }} parsed
 */
function fromMessage(message, command, guildConfig, parsed = {}) {
  return new Context({
    client: message.client,
    source: message,
    kind: SOURCE.PREFIX,
    command,
    guild: message.guild ?? null,
    member: message.member ?? null,
    user: message.author,
    channel: message.channel ?? null,
    guildConfig,
    args: parsed.args || {},
    rawArgs: parsed.rawArgs || [],
    subcommand: parsed.subcommand || null,
    message,
  });
}

/** Build a Context from a component interaction, for button handlers. */
function fromComponent(interaction, { guildConfig = {}, command = null } = {}) {
  return new Context({
    client: interaction.client,
    source: interaction,
    kind: SOURCE.COMPONENT,
    command: command || { name: interaction.customId?.split(':')[0] || 'component' },
    guild: interaction.guild ?? null,
    member: interaction.member ?? null,
    user: interaction.user,
    channel: interaction.channel ?? null,
    guildConfig,
    args: {},
    rawArgs: [],
  });
}

module.exports = {
  Context,
  SOURCE,
  fromInteraction,
  fromMessage,
  fromComponent,
  unwrapOption,
  ChannelType,
};
