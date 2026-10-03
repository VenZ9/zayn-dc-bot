'use strict';

/**
 * Command definition builder + argument syntax parser.
 *
 * A command is declared once with a slash-shaped argument list:
 *
 *   module.exports = defineCommand({
 *     name: 'ban',
 *     description: 'Ban a member',
 *     node: 'moderation.ban',
 *     userPerms: PERMS.ban,
 *     args: [
 *       { name: 'user',   type: 'user',   required: true, description: 'Who to ban' },
 *       { name: 'reason', type: 'string', required: false, description: 'Why' },
 *       { name: 'days',   type: 'integer', required: false },
 *     ],
 *     async run(ctx) { ... },
 *   });
 *
 * The same `args` array produces three things:
 *   1. the slash command payload (SlashCommandBuilder)
 *   2. the prefix usage string (`.ban <user> [reason] [days]`)
 *   3. the prefix token parser, which greedily fills the last string argument
 *      so `.ban @user being rude in chat` captures the whole reason.
 */

const {
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
  SlashCommandSubcommandGroupBuilder,
  SlashCommandUserOption,
  SlashCommandStringOption,
  SlashCommandIntegerOption,
  SlashCommandBooleanOption,
  SlashCommandNumberOption,
  SlashCommandChannelOption,
  SlashCommandRoleOption,
  SlashCommandMentionableOption,
  SlashCommandAttachmentOption,
  SlashCommandOptionsOnlyBuilder,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');

// ---------------------------------------------------------------------------
// Argument types
// ---------------------------------------------------------------------------

/** Canonical argument type names. */
const ARG_TYPES = Object.freeze([
  'string', 'integer', 'number', 'boolean', 'user', 'member',
  'channel', 'role', 'mentionable', 'attachment',
]);

/** Which types swallow the remainder of a prefix message. */
const GREEDY_TYPES = new Set(['string']);

// ---------------------------------------------------------------------------
// Slash option builders
// ---------------------------------------------------------------------------

/**
 * Turn one arg definition into a discord.js option, attached to a builder.
 * @param {any} builder SlashCommandBuilder | SlashCommandSubcommandBuilder
 * @param {object} arg
 */
function addOption(builder, arg) {
  const { name, type = 'string', description = '\u200b', required = false, choices, autocomplete } = arg;

  switch (type) {
    case 'user':
    case 'member': {
      const option = new SlashCommandUserOption()
        .setName(name)
        .setDescription(description)
        .setRequired(required);
      builder.addUserOption(option);
      break;
    }

    case 'string': {
      const option = new SlashCommandStringOption()
        .setName(name)
        .setDescription(description)
        .setRequired(required);
      if (arg.minLength) option.setMinLength(arg.minLength);
      if (arg.maxLength) option.setMaxLength(Math.min(arg.maxLength, 6000));
      if (choices) option.addChoices(...choices);
      if (autocomplete) option.setAutocomplete(true);
      builder.addStringOption(option);
      break;
    }

    case 'integer': {
      const option = new SlashCommandIntegerOption()
        .setName(name)
        .setDescription(description)
        .setRequired(required);
      if (arg.min !== undefined) option.setMinValue(arg.min);
      if (arg.max !== undefined) option.setMaxValue(arg.max);
      if (choices) option.addChoices(...choices);
      if (autocomplete) option.setAutocomplete(true);
      builder.addIntegerOption(option);
      break;
    }

    case 'number': {
      const option = new SlashCommandNumberOption()
        .setName(name)
        .setDescription(description)
        .setRequired(required);
      if (arg.min !== undefined) option.setMinValue(arg.min);
      if (arg.max !== undefined) option.setMaxValue(arg.max);
      if (choices) option.addChoices(...choices);
      builder.addNumberOption(option);
      break;
    }

    case 'boolean': {
      const option = new SlashCommandBooleanOption()
        .setName(name)
        .setDescription(description)
        .setRequired(required);
      builder.addBooleanOption(option);
      break;
    }

    case 'channel': {
      const option = new SlashCommandChannelOption()
        .setName(name)
        .setDescription(description)
        .setRequired(required);
      if (arg.channelTypes) option.addChannelTypes(...arg.channelTypes);
      else if (arg.textOnly) option.addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
      else if (arg.voiceOnly) option.addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice);
      builder.addChannelOption(option);
      break;
    }

    case 'role': {
      const option = new SlashCommandRoleOption()
        .setName(name)
        .setDescription(description)
        .setRequired(required);
      builder.addRoleOption(option);
      break;
    }

    case 'mentionable': {
      const option = new SlashCommandMentionableOption()
        .setName(name)
        .setDescription(description)
        .setRequired(required);
      builder.addMentionableOption(option);
      break;
    }

    case 'attachment': {
      const option = new SlashCommandAttachmentOption()
        .setName(name)
        .setDescription(description)
        .setRequired(required);
      builder.addAttachmentOption(option);
      break;
    }

    default:
      throw new Error(`Unknown argument type "${type}" for option "${name}"`);
  }
}

// ---------------------------------------------------------------------------
// Slash payload
// ---------------------------------------------------------------------------

/**
 * Build the SlashCommandBuilder for a command definition.
 *
 * Supports three shapes:
 *   - flat options                 (`/roleinfo <role>`)
 *   - subcommands                   (`/ticket open`)
 *   - subcommand groups             (`/ticket setup panel`)
 *
 * @param {object} command
 * @returns {any} something with .toJSON()
 */
function buildSlash(command) {
  const builder = new SlashCommandBuilder()
    .setName(command.name)
    .setDescription(command.description || 'No description provided.');
  if (command.nameLocalizations) builder.setNameLocalizations(command.nameLocalizations);
  if (command.descriptionLocalizations) builder.setDescriptionLocalizations(command.descriptionLocalizations);

  // An explicit default member permission hides the command from people who
  // cannot use it, which is friendlier than erroring after the fact.
  if (command.defaultMemberPermissions) {
    builder.setDefaultMemberPermissions(command.defaultMemberPermissions);
  }
  if (command.nsfw) builder.setNSFW(true);

  // ---- subcommand groups --------------------------------------------------
  if (Array.isArray(command.groups) && command.groups.length > 0) {
    for (const group of command.groups) {
      const groupBuilder = new SlashCommandSubcommandGroupBuilder()
        .setName(group.name)
        .setDescription(group.description || '\u200b');

      for (const sub of group.subcommands || []) {
        const subBuilder = new SlashCommandSubcommandBuilder()
          .setName(sub.name)
          .setDescription(sub.description || '\u200b');
        for (const arg of sub.args || []) addOption(subBuilder, arg);
        groupBuilder.addSubcommand(subBuilder);
      }
      builder.addSubcommandGroup(groupBuilder);
    }
    return builder;
  }

  // ---- subcommands --------------------------------------------------------
  if (Array.isArray(command.subcommands) && command.subcommands.length > 0) {
    for (const sub of command.subcommands) {
      const subBuilder = new SlashCommandSubcommandBuilder()
        .setName(sub.name)
        .setDescription(sub.description || '\u200b');
      for (const arg of sub.args || []) addOption(subBuilder, arg);
      builder.addSubcommand(subBuilder);
    }
    // Some commands mix a default action with subcommands (e.g. bare `/role`),
    // but Discord forbids that, so we return options-only when there are none.
    return builder;
  }

  // ---- flat --------------------------------------------------------------
  for (const arg of command.args || []) addOption(builder, arg);
  return builder;
}

// ---------------------------------------------------------------------------
// Prefix usage / parsing
// ---------------------------------------------------------------------------

/**
 * Build a human readable usage string for the help embed.
 * @param {object} command
 * @returns {string[]} one entry per variant
 */
function usageLines(command) {
  const lines = [];

  const renderArgs = (args = []) => args
    .map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`))
    .join(' ');

  if (Array.isArray(command.groups) && command.groups.length > 0) {
    for (const group of command.groups) {
      for (const sub of group.subcommands || []) {
        lines.push(`${command.name} ${group.name} ${sub.name} ${renderArgs(sub.args)}`.trim());
      }
    }
    return lines;
  }

  if (Array.isArray(command.subcommands) && command.subcommands.length > 0) {
    for (const sub of command.subcommands) {
      lines.push(`${command.name} ${sub.name} ${renderArgs(sub.args)}`.trim());
    }
    return lines;
  }

  lines.push(`${command.name} ${renderArgs(command.args)}`.trim());
  return lines;
}

/**
 * Parse prefix tokens against a command's argument list.
 *
 * Rules that make prefix commands feel natural:
 *   - a user/channel/role argument accepts a mention, an ID or a name
 *   - the LAST string argument is greedy, so the rest of the line becomes the
 *     value (`.ban @spammer being rude` -> reason "being rude")
 *   - missing optional arguments are simply absent
 *
 * @param {object} command
 * @param {string[]} tokens
 * @returns {{ args: Record<string, any>, rawArgs: string[], subcommand: object|null, rest: string[] }}
 */
function parseArgs(command, tokens) {
  const result = { args: {}, rawArgs: [], subcommand: null, rest: [] };

  // ---- resolve subcommand -------------------------------------------------
  let argsSpec = command.args || [];
  let remaining = [...tokens];

  if (Array.isArray(command.groups) && command.groups.length > 0) {
    const groupName = remaining[0]?.toLowerCase();
    const group = command.groups.find((candidate) => candidate.name === groupName);
    if (group) {
      remaining = remaining.slice(1);
      const subName = remaining[0]?.toLowerCase();
      const sub = (group.subcommands || []).find((candidate) => candidate.name === subName);
      if (sub) {
        remaining = remaining.slice(1);
        argsSpec = sub.args || [];
        result.subcommand = { group: group.name, name: sub.name };
      } else {
        result.subcommand = { group: group.name, name: null };
      }
    }
  } else if (Array.isArray(command.subcommands) && command.subcommands.length > 0) {
    const subName = remaining[0]?.toLowerCase();
    const sub = command.subcommands.find((candidate) => candidate.name === subName);
    if (sub) {
      remaining = remaining.slice(1);
      argsSpec = sub.args || [];
      result.subcommand = { group: null, name: sub.name };
    } else {
      result.subcommand = { group: null, name: null };
    }
  }

  result.rawArgs = remaining;

  // ---- fill arguments -----------------------------------------------------
  let cursor = 0;

  for (let index = 0; index < argsSpec.length; index += 1) {
    const arg = argsSpec[index];
    const isLast = index === argsSpec.length - 1;
    const isGreedy = isLast && GREEDY_TYPES.has(arg.type) && remaining.length - cursor > 1;

    if (cursor >= remaining.length) {
      if (arg.required && arg.default === undefined) {
        result.args[arg.name] = undefined;
      }
      continue;
    }

    if (isGreedy) {
      // Everything left becomes this argument.
      result.args[arg.name] = remaining.slice(cursor).join(' ');
      cursor = remaining.length;
      continue;
    }

    result.args[arg.name] = coerce(arg, remaining[cursor]);
    cursor += 1;
  }

  // Anything left over is exposed as `rest` so handlers can pick it up.
  result.rest = remaining.slice(cursor);
  return result;
}

/**
 * Coerce a raw prefix token into the type the argument declares.
 *
 * Values that cannot be resolved are returned as the raw string - handlers do
 * their own validation and can produce a good error message, which is better
 * than silently dropping the argument.
 */
function coerce(arg, token) {
  if (token === undefined || token === null) return undefined;
  const text = String(token);

  switch (arg.type) {
    case 'integer': {
      const parsed = Number.parseInt(text.replace(/[,_]/g, ''), 10);
      return Number.isFinite(parsed) ? parsed : text;
    }

    case 'number': {
      const parsed = Number.parseFloat(text.replace(/[,_]/g, ''));
      return Number.isFinite(parsed) ? parsed : text;
    }

    case 'boolean': {
      const lowered = text.toLowerCase();
      if (['true', 'yes', 'y', 'on', '1', 'enable', 'enabled'].includes(lowered)) return true;
      if (['false', 'no', 'n', 'off', '0', 'disable', 'disabled'].includes(lowered)) return false;
      return text;
    }

    case 'user':
    case 'member':
    case 'channel':
    case 'role':
    case 'mentionable':
      // Leave as the raw token: the runner resolves mentions and IDs against
      // the guild cache, where it can produce a helpful "not found" message.
      return text;

    default:
      return text;
  }
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

/**
 * Normalise a command module into the shape the loader and runners expect.
 *
 * @param {object} definition
 * @returns {object}
 */
function defineCommand(definition) {
  if (!definition?.name) throw new Error('defineCommand requires a name');
  if (!/^[a-z0-9_-]{1,32}$/.test(definition.name)) {
    throw new Error(`Command name "${definition.name}" must be lowercase letters, numbers, - or _ (max 32)`);
  }

  const command = {
    // identity
    name: definition.name,
    description: definition.description || 'No description provided.',
    module: definition.module || 'misc',
    category: definition.category || definition.module || 'misc',

    // access control
    node: definition.node ?? null,
    userPerms: definition.userPerms ?? null,
    botPerms: definition.botPerms ?? null,
    ownerOnly: definition.ownerOnly === true,
    guildOnly: definition.guildOnly !== false,
    adminOnly: definition.adminOnly === true,

    // prefix behaviour
    aliases: Array.isArray(definition.aliases) ? definition.aliases : [],
    usage: definition.usage ?? (definition.args ? buildUsageSuffix(definition.args) : ''),
    examples: Array.isArray(definition.examples) ? definition.examples : [],
    prefixEnabled: definition.prefixEnabled !== false,
    deleteTrigger: definition.deleteTrigger === true,

    // slash behaviour
    defaultMemberPermissions: definition.defaultMemberPermissions ?? null,
    nsfw: definition.nsfw === true,
    nameLocalizations: definition.nameLocalizations,
    descriptionLocalizations: definition.descriptionLocalizations,
    autocomplete: typeof definition.autocomplete === 'function' ? definition.autocomplete : null,

    // structure
    args: definition.args || [],
    subcommands: definition.subcommands || null,
    groups: definition.groups || null,

    // behaviour
    cooldown: Number.isFinite(definition.cooldown) ? definition.cooldown : 0,
    hidden: definition.hidden === true,

    // handlers
    run: definition.run,
    execute: definition.execute || definition.run,
    components: definition.components || null,
  };

  if (typeof command.run !== 'function') {
    throw new Error(`Command "${command.name}" is missing a run() handler`);
  }

  // Precompute the slash payload once - it never changes at runtime.
  command.slashData = buildSlash(command).toJSON();
  command.usageLines = usageLines(command);

  return command;
}

/** `<a> [b]` suffix used when `usage` is not supplied explicitly. */
function buildUsageSuffix(args) {
  return args.map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`)).join(' ');
}

/** Built-in aliases shared by several modules. */
const COMMON_ALIASES = Object.freeze({
  ban: ['b'],
  kick: ['k'],
  mute: ['m', 'timeout'],
  unmute: ['um'],
  warn: ['w'],
  warnings: ['warns'],
  purge: ['clear', 'prune'],
  slowmode: ['sm'],
  userinfo: ['ui', 'whois'],
  serverinfo: ['si'],
  roleinfo: ['ri'],
  channelinfo: ['ci'],
  avatar: ['av', 'pfp'],
  botinfo: ['bi'],
  help: ['h', 'commands'],
  rank: ['r', 'level'],
  leaderboard: ['lb', 'top'],
  profile: ['p', 'me'],
  ping: ['pong'],
  ticket: ['t'],
  giveaway: ['gw'],
});

module.exports = {
  defineCommand,
  buildSlash,
  buildUsageSuffix,
  usageLines,
  parseArgs,
  coerce,
  addOption,
  ARG_TYPES,
  COMMON_ALIASES,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
  SlashCommandSubcommandGroupBuilder,
};
