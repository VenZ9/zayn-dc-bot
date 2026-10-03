'use strict';

/**
 * Small pure helpers used across modules.
 *
 * Everything here is deterministic and side-effect free, which is what makes it
 * worth unit testing - `scripts/check.js` exercises several of these.
 */

// ---------------------------------------------------------------------------
// Duration parsing / formatting
// ---------------------------------------------------------------------------

const UNIT_SECONDS = Object.freeze({
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400,
  w: 604800, week: 604800, weeks: 604800,
  mo: 2592000, month: 2592000, months: 2592000,
  y: 31536000, year: 31536000, years: 31536000,
});

/**
 * Parse a human duration into seconds.
 *
 * Accepts `10m`, `2h30m`, `1d`, `1 day`, `90s`, `1w 2d`.
 * Returns null when nothing sensible was found, so callers can reject input
 * rather than silently defaulting to something dangerous.
 *
 * @param {string} input
 * @returns {number|null} seconds, or null when unparseable
 */
function parseDuration(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) && input > 0 ? Math.floor(input) : null;

  const text = String(input).trim().toLowerCase();
  if (!text) return null;

  // Bare number: treat as seconds, matching how people actually type "mute 600".
  if (/^\d+$/.test(text)) {
    const seconds = Number.parseInt(text, 10);
    return seconds > 0 ? seconds : null;
  }

  const pattern = /(\d+(?:\.\d+)?)\s*(mo|[smhdwy]|sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours|day|days|week|weeks|month|months|year|years)\b/g;

  let total = 0;
  let matched = false;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    matched = true;
    const amount = Number.parseFloat(match[1]);
    const unit = UNIT_SECONDS[match[2]];
    if (!unit) continue;
    total += amount * unit;
  }

  if (!matched || total <= 0) return null;
  return Math.floor(total);
}

/**
 * Format seconds as a compact human string: `2d 3h 5m`.
 * @param {number} seconds
 * @param {{ units?: number }} [options] how many units to show (default 3)
 */
function formatDuration(seconds, options = {}) {
  const { units = 3 } = options;
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';

  const table = [
    ['y', 31536000],
    ['mo', 2592000],
    ['w', 604800],
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ];

  let remaining = Math.floor(seconds);
  const parts = [];

  for (const [label, size] of table) {
    if (remaining < size) continue;
    const value = Math.floor(remaining / size);
    remaining -= value * size;
    parts.push(`${value}${label}`);
    if (parts.length >= units) break;
  }

  return parts.length > 0 ? parts.join(' ') : '0s';
}

/**
 * Discord relative timestamp, e.g. `<t:1700000000:R>` -> "in 5 minutes".
 * @param {Date|number} date
 * @param {'R'|'f'|'F'|'t'|'T'|'d'|'D'} [style]
 */
function timestamp(date, style = 'R') {
  const ms = date instanceof Date ? date.getTime() : Number(date);
  if (!Number.isFinite(ms)) return 'unknown';
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/** Full date + relative, used in profile and case embeds. */
function fullTimestamp(date) {
  return `${timestamp(date, 'F')} (${timestamp(date, 'R')})`;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Escape Discord markdown so user-supplied text cannot format the embed.
 * Important for reasons, bios and custom command output.
 */
function escapeMarkdown(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/([\\`*_~|>])/g, '\\$1').replace(/@(everyone|here)/g, '@\u200b$1');
}

/**
 * Neutralise mass mentions. Called on every user supplied string before it is
 * echoed back or stored.
 */
function sanitiseMentions(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/@everyone/g, '@\u200beveryone')
    .replace(/@here/g, '@\u200bhere')
    .replace(/<@&(\d+)>/g, '@role')
    .replace(/<@!?(\d+)>/g, (match, id) => `@${id}`);
}

/** Shorten to `max` characters with an ellipsis. */
function truncate(text, max = 100) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Split text into chunks no longer than `size`, breaking on newlines. */
function chunk(text, size = 1000) {
  const value = String(text ?? '');
  if (value.length <= size) return [value];

  const lines = value.split('\n');
  const chunks = [];
  let current = '';

  for (const line of lines) {
    if (line.length > size) {
      if (current) { chunks.push(current); current = ''; }
      for (let i = 0; i < line.length; i += size) chunks.push(line.slice(i, i + size));
      continue;
    }
    if ((current + line).length + 1 > size) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

/** "1 message" / "5 messages" */
function pluralise(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Thousands separators. Handles bigints from Postgres count columns. */
function formatNumber(value) {
  const number = typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
  if (!Number.isFinite(number)) return '0';
  return number.toLocaleString('en-US');
}

/** `1d 2h` style "member for" string. */
function accountAge(createdAt) {
  const ms = Date.now() - new Date(createdAt).getTime();
  const days = Math.floor(ms / 86400000);
  if (days < 1) {
    const hours = Math.max(0, Math.floor(ms / 3600000));
    return `${hours}h`;
  }
  return formatDuration(days * 86400, { units: 2 });
}

/** Progress bar like `████░░░░░░ 42%`. */
function progressBar(current, total, size = 12, filled = '█', empty = '░') {
  if (!Number.isFinite(total) || total <= 0) return `${empty.repeat(size)} 0%`;
  const ratio = Math.min(1, Math.max(0, current / total));
  const filledCount = Math.round(ratio * size);
  const percent = Math.round(ratio * 100);
  return `${filled.repeat(filledCount)}${empty.repeat(size - filledCount)} ${percent}%`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SNOWFLAKE = /^\d{15,25}$/;

/** Is this a plausible Discord ID? */
function isSnowflake(value) {
  return SNOWFLAKE.test(String(value ?? '').trim());
}

/** Strip a mention (`<@123>`, `<@!123>`, `<@&123>`, `<#123>`) down to its ID. */
function extractId(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^<[@#!&]*(\d{15,25})>$/);
  if (match) return match[1];
  return SNOWFLAKE.test(text) ? text : null;
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegex(text) {
  return String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Clamp a number into a range. */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------

/** Random integer in [min, max] inclusive. */
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Pick one element at random. */
function pick(array) {
  if (!Array.isArray(array) || array.length === 0) return undefined;
  return array[Math.floor(Math.random() * array.length)];
}

/**
 * Deterministic shuffle (Fisher-Yates) using a supplied RNG.
 * @param {any[]} array
 * @param {() => number} [rng] defaults to Math.random
 */
function shuffle(array, rng = Math.random) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Pick `count` distinct elements. Returns fewer when the array is smaller. */
function sample(array, count) {
  if (!Array.isArray(array)) return [];
  return shuffle(array).slice(0, Math.max(0, count));
}

// ---------------------------------------------------------------------------
// Dates / timezones
// ---------------------------------------------------------------------------

/** Current UTC date as `YYYY-MM-DD`. */
function today(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** Add days to a date, returning a new Date. */
function addDays(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

/** Sensible default timezone list for `/config timezone` autocomplete. */
const COMMON_TIMEZONES = Object.freeze([
  'UTC', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome',
  'Europe/Moscow', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo',
  'Asia/Shanghai', 'Australia/Sydney', 'Pacific/Auckland',
]);

/** Is this a timezone the runtime actually understands? */
function isValidTimezone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Local date parts for a timezone. */
function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  return parts;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Strip undefined values so a PATCH body stays small. */
function compact(object) {
  return Object.fromEntries(Object.entries(object || {}).filter(([, value]) => value !== undefined));
}

/** Await a promise but never throw - returns [error, value]. */
async function settle(promise) {
  try {
    return [null, await promise];
  } catch (error) {
    return [error, null];
  }
}

/** Sleep helper for rate-limit friendly loops. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = {
  parseDuration,
  formatDuration,
  timestamp,
  fullTimestamp,
  escapeMarkdown,
  sanitiseMentions,
  truncate,
  chunk,
  pluralise,
  formatNumber,
  accountAge,
  progressBar,
  isSnowflake,
  extractId,
  escapeRegex,
  clamp,
  randomInt,
  pick,
  shuffle,
  sample,
  today,
  addDays,
  COMMON_TIMEZONES,
  isValidTimezone,
  zonedParts,
  compact,
  settle,
  sleep,
};
