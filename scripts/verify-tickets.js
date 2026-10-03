'use strict';

/**
 * Structural verification for the ticket module.
 *
 * Loads the command the same way the router does, builds its slash payload and
 * asserts the shape Discord requires. Run with `node scripts/verify-tickets.js`.
 */

const path = require('node:path');
const assert = require('node:assert');

// Avoid the boot-time env assertion - this script only checks structure.
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_KEY ||= 'test';
process.env.DISCORD_TOKEN ||= 'aaaa.bbbb.cccc';
process.env.CLIENT_ID ||= '123456789012345678';

const ticket = require(path.join(__dirname, '..', 'src', 'modules', 'tickets', 'ticket.js'));
const service = require(path.join(__dirname, '..', 'src', 'modules', 'tickets', 'ticket-service.js'));

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${label}\n        ${error.message}`);
  }
}

console.log('ticket module structure');

check('exports a command named "ticket"', () => {
  assert.strictEqual(ticket.name, 'ticket');
});

check('is tagged with the tickets module and node', () => {
  assert.strictEqual(ticket.module, 'tickets');
  assert.strictEqual(ticket.node, 'tickets.open');
});

check('declares setup as a flat subcommand', () => {
  assert.strictEqual(ticket.groups, null, 'buildSlash ignores flat subcommands when groups exist');
  const setup = ticket.subcommands.find((sub) => sub.name === 'setup');
  assert.ok(setup, 'setup subcommand missing');
  assert.deepStrictEqual(setup.args.map((arg) => arg.name), ['category', 'role', 'action']);
});

check('declares the flat subcommands', () => {
  const names = ticket.subcommands.map((sub) => sub.name).sort();
  const expected = [
    'add', 'claim', 'close', 'list', 'open', 'panel', 'priority',
    'remove', 'rename', 'setup', 'stats', 'transcript',
  ];
  assert.deepStrictEqual(names, expected);
});

check('builds a valid slash payload', () => {
  const data = ticket.slashData;
  assert.strictEqual(data.name, 'ticket');
  assert.ok(data.description && data.description.length <= 100, 'description too long or missing');

  // Discord forbids mixing subcommand groups with flat subcommands, so this
  // command is flat: 12 subcommands and no groups.
  const optionNames = data.options.map((option) => option.name);
  assert.ok(optionNames.includes('setup'), 'setup subcommand not in payload');

  const setup = data.options.find((option) => option.name === 'setup');
  assert.strictEqual(setup.type, 1, 'setup should be a plain subcommand');
  assert.strictEqual(setup.options.length, 3, 'setup should hold three options');

  const groupCount = data.options.filter((option) => option.type === 2).length;
  const subcommandCount = data.options.filter((option) => option.type === 1).length;
  assert.strictEqual(groupCount, 0, `expected 0 groups, got ${groupCount}`);
  assert.strictEqual(subcommandCount, 12, `expected 12 subcommands, got ${subcommandCount}`);
  assert.strictEqual(data.options.length, 12, `expected 12 top-level options, got ${data.options.length}`);

  // Every option and nested option needs a non-empty description.
  const walk = (options, trail) => {
    for (const option of options) {
      assert.ok(option.name && /^[a-z0-9_-]{1,32}$/.test(option.name), `bad option name ${option.name} in ${trail}`);
      assert.ok(option.description && option.description.length <= 100, `bad description for ${trail}.${option.name}`);
      if (option.options) walk(option.options, `${trail}.${option.name}`);
    }
  };
  walk(data.options, 'ticket');
});

check('every subcommand arg produces a valid payload option', () => {
  const data = ticket.slashData;
  const all = data.options.flatMap((option) => (option.options ? option.options.flatMap((nested) => nested.options ?? [nested]) : [option]));
  const names = all.filter((option) => option.type !== 1 && option.type !== 2).map((option) => option.name);
  assert.ok(names.includes('level'), 'priority level option missing');
  assert.ok(names.includes('category'), 'setup category option missing');
  assert.ok(names.includes('role'), 'setup role option missing');
});

check('priority choices are present and well formed', () => {
  const data = ticket.slashData;
  const priority = data.options.find((option) => option.name === 'priority');
  const level = priority.options.find((option) => option.name === 'level');
  assert.strictEqual(level.choices.length, 4);
  assert.deepStrictEqual(level.choices.map((choice) => choice.value).sort(), ['high', 'low', 'normal', 'urgent']);
});

check('registers the four component handlers', () => {
  assert.ok(ticket.components && typeof ticket.components === 'object');
  const expected = ['tk:create', 'tk:close', 'tk:claim', 'tk:transcript'];
  for (const key of expected) {
    assert.strictEqual(typeof ticket.components[key], 'function', `${key} handler missing`);
  }
});

check('usage lines are generated for every variant', () => {
  assert.ok(Array.isArray(ticket.usageLines));
  assert.strictEqual(ticket.usageLines.length, 12, `expected 12 usage lines, got ${ticket.usageLines.length}`);
  for (const line of ticket.usageLines) {
    assert.ok(line.startsWith('ticket'), `usage line should start with the command name: ${line}`);
  }
});

check('service exposes the documented surface', () => {
  const expected = [
    'PRIORITIES', 'nextTicketNumber', 'latestPanel', 'open', 'close', 'buildTranscript',
    'addUser', 'removeUser', 'claim', 'rename', 'setPriority', 'findByChannel',
    'findById', 'list', 'stats', 'openTickets',
  ];
  for (const key of expected) {
    assert.ok(key in service, `service.${key} missing`);
  }
});

check('priority table is internally consistent', () => {
  for (const [key, meta] of Object.entries(service.PRIORITIES)) {
    assert.strictEqual(meta.id, key, `priority ${key} has a mismatched id`);
    assert.ok(meta.label && meta.emoji, `priority ${key} is missing presentation`);
    assert.ok(Number.isFinite(meta.color), `priority ${key} has no colour`);
  }
  assert.strictEqual(Object.keys(service.PRIORITIES).length, 4);
});

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all ticket module checks passed');
