-- ============================================================================
--  ZAYN'S DC BOT - Supabase / PostgreSQL schema
-- ----------------------------------------------------------------------------
--  HOW TO RUN
--    1. Open your Supabase project.
--    2. Left sidebar -> SQL Editor -> New query.
--    3. Paste this entire file and press "Run".
--    4. Re-run it any time - every statement is idempotent.
--
--  ID TYPE NOTE
--    Discord snowflakes are 64-bit and exceed JavaScript's safe integer limit
--    (2^53). Every Discord ID column below is therefore TEXT, so nothing is
--    ever silently rounded. Do not "optimise" these to bigint.
--
--  ROW LEVEL SECURITY
--    RLS is enabled on every table with NO policies. The bot connects with the
--    service_role key, which bypasses RLS. Anything using the anon key is
--    therefore locked out, which is what we want for a private bot.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Helper: keep updated_at fresh
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ===========================================================================
-- 1. GUILD CONFIG
--    One row per server. Everything the /config module writes lives here.
-- ===========================================================================
create table if not exists public.guild_config (
  guild_id              text primary key,
  prefix                text        not null default '.',
  prefix_enabled        boolean     not null default true,
  prefix_delete_message boolean     not null default false,
  language              text        not null default 'en',
  timezone              text        not null default 'UTC',
  mod_log_channel       text,
  modlog_enabled        boolean     not null default true,
  mute_role_id          text,
  dj_role_id            text,
  welcome_enabled       boolean     not null default false,
  welcome_channel       text,
  welcome_message       text,
  welcome_image         text,
  welcome_dm            boolean     not null default false,
  goodbye_enabled       boolean     not null default false,
  goodbye_channel       text,
  goodbye_message       text,
  autorole_id           text,
  levels_enabled        boolean     not null default true,
  levels_announce_channel text,
  levels_base_xp        integer     not null default 15,
  levels_min_xp         integer     not null default 5,
  levels_max_xp         integer     not null default 25,
  levels_cooldown_secs  integer     not null default 60,
  levels_stack_rewards  boolean     not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

drop trigger if exists trg_guild_config_touch on public.guild_config;
create trigger trg_guild_config_touch before update on public.guild_config
  for each row execute function public.touch_updated_at();

-- ===========================================================================
-- 2. MODERATION CASES
--    Every moderation action becomes a case with a per-guild incrementing
--    number, so /case 12 always refers to "the 12th action in this server".
-- ===========================================================================
create table if not exists public.mod_cases (
  id            uuid primary key default gen_random_uuid(),
  guild_id      text        not null,
  case_number   integer     not null,
  action        text        not null,        -- ban|tempban|unban|kick|mute|unmute|warn|note|purge|slowmode|lock|...
  target_id     text        not null,
  target_tag    text,
  moderator_id  text        not null,
  moderator_tag text,
  reason        text,
  duration      bigint,                       -- seconds, null = permanent
  expires_at    timestamptz,                  -- when a temp action ends
  active        boolean     not null default true,
  resolved      boolean     not null default false,
  resolved_by   text,
  resolved_at   timestamptz,
  metadata      jsonb       not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create unique index if not exists uq_mod_cases_guild_number on public.mod_cases (guild_id, case_number);
create index if not exists idx_mod_cases_guild_target  on public.mod_cases (guild_id, target_id);
create index if not exists idx_mod_cases_guild_action  on public.mod_cases (guild_id, action);
create index if not exists idx_mod_cases_created       on public.mod_cases (guild_id, created_at desc);
create index if not exists idx_mod_cases_expiry        on public.mod_cases (expires_at)
  where expires_at is not null and active = true;

-- ===========================================================================
-- 3. NOTES
--    Free-form staff notes attached to a user.
-- ===========================================================================
create table if not exists public.notes (
  id           uuid primary key default gen_random_uuid(),
  guild_id     text        not null,
  user_id      text        not null,
  author_id    text        not null,
  content      text        not null,
  created_at   timestamptz not null default now()
);
create index if not exists idx_notes_guild_user on public.notes (guild_id, user_id, created_at desc);

-- ===========================================================================
-- 4. TICKETS
-- ===========================================================================
create table if not exists public.ticket_panels (
  id           uuid primary key default gen_random_uuid(),
  guild_id     text        not null,
  channel_id   text        not null,
  message_id   text,
  title        text        not null default 'Support',
  description  text        not null default 'Click the button below to open a ticket.',
  button_label text        not null default 'Open Ticket',
  category_id  text,                          -- discord category to create under
  support_roles jsonb      not null default '[]'::jsonb,
  created_by   text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_ticket_panels_guild on public.ticket_panels (guild_id);

create table if not exists public.tickets (
  id             uuid primary key default gen_random_uuid(),
  guild_id       text        not null,
  ticket_number  integer     not null,
  channel_id     text        not null,
  opener_id      text        not null,
  opener_tag     text,
  subject        text,
  status         text        not null default 'open',   -- open|closed|deleted
  priority       text        not null default 'normal', -- low|normal|high|urgent
  claimed_by     text,
  claimed_at     timestamptz,
  added_users    jsonb       not null default '[]'::jsonb,
  panel_id       uuid,
  transcript     text,
  transcript_url text,
  closed_by      text,
  closed_at      timestamptz,
  close_reason   text,
  last_activity  timestamptz not null default now(),
  created_at     timestamptz not null default now()
);
create unique index if not exists uq_tickets_guild_number on public.tickets (guild_id, ticket_number);
create unique index if not exists uq_tickets_channel      on public.tickets (channel_id);
create index if not exists idx_tickets_guild_status       on public.tickets (guild_id, status);
create index if not exists idx_tickets_opener             on public.tickets (guild_id, opener_id);

-- ===========================================================================
-- 5. ANALYTICS
--    Daily rollups plus live counters. Snapshots power retention/activity.
-- ===========================================================================
create table if not exists public.analytics_counters (
  guild_id     text primary key,
  total_messages  bigint not null default 0,
  total_joins     bigint not null default 0,
  total_leaves    bigint not null default 0,
  total_commands  bigint not null default 0,
  total_voice_seconds bigint not null default 0,
  total_mod_actions   bigint not null default 0,
  updated_at   timestamptz not null default now()
);

drop trigger if exists trg_analytics_counters_touch on public.analytics_counters;
create trigger trg_analytics_counters_touch before update on public.analytics_counters
  for each row execute function public.touch_updated_at();

create table if not exists public.analytics_daily (
  id            uuid primary key default gen_random_uuid(),
  guild_id      text        not null,
  day           date        not null,
  messages      integer     not null default 0,
  joins         integer     not null default 0,
  leaves        integer     not null default 0,
  commands      integer     not null default 0,
  voice_seconds integer     not null default 0,
  unique_members integer    not null default 0
);
create unique index if not exists uq_analytics_daily on public.analytics_daily (guild_id, day);
create index if not exists idx_analytics_daily_guild on public.analytics_daily (guild_id, day desc);

create table if not exists public.analytics_channels (
  id         uuid primary key default gen_random_uuid(),
  guild_id   text        not null,
  channel_id text        not null,
  messages   bigint      not null default 0,
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_analytics_channels on public.analytics_channels (guild_id, channel_id);

create table if not exists public.analytics_members (
  id           uuid primary key default gen_random_uuid(),
  guild_id     text        not null,
  user_id      text        not null,
  messages     bigint      not null default 0,
  voice_seconds bigint     not null default 0,
  commands     bigint      not null default 0,
  last_seen    timestamptz,
  joined_at    timestamptz,
  updated_at   timestamptz not null default now()
);
create unique index if not exists uq_analytics_members on public.analytics_members (guild_id, user_id);
create index if not exists idx_analytics_members_messages on public.analytics_members (guild_id, messages desc);

-- Member count snapshots - used by /analytics retention.
create table if not exists public.member_snapshots (
  id         uuid primary key default gen_random_uuid(),
  guild_id   text        not null,
  day        date        not null,
  member_count integer   not null,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_member_snapshots on public.member_snapshots (guild_id, day);

-- ===========================================================================
-- 6. LEVELING & XP
-- ===========================================================================
create table if not exists public.levels (
  id            uuid primary key default gen_random_uuid(),
  guild_id      text        not null,
  user_id       text        not null,
  xp            bigint      not null default 0,
  level         integer     not null default 0,
  total_xp      bigint      not null default 0,
  messages      bigint      not null default 0,
  voice_seconds bigint      not null default 0,
  last_xp_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists uq_levels_guild_user on public.levels (guild_id, user_id);
create index if not exists idx_levels_leaderboard on public.levels (guild_id, total_xp desc);

drop trigger if exists trg_levels_touch on public.levels;
create trigger trg_levels_touch before update on public.levels
  for each row execute function public.touch_updated_at();

create table if not exists public.level_rewards (
  id         uuid primary key default gen_random_uuid(),
  guild_id   text        not null,
  level      integer     not null,
  role_id    text        not null,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_level_rewards on public.level_rewards (guild_id, level, role_id);

-- ===========================================================================
-- 7. GIVEAWAYS
-- ===========================================================================
create table if not exists public.giveaways (
  id             uuid primary key default gen_random_uuid(),
  guild_id       text        not null,
  channel_id     text        not null,
  message_id     text,
  host_id        text        not null,
  prize          text        not null,
  description    text,
  winners_count  integer     not null default 1,
  required_role  text,
  required_level integer,
  required_messages integer,
  bonus_entries  jsonb       not null default '{}'::jsonb,
  status         text        not null default 'running', -- running|paused|ended|cancelled
  paused_at      timestamptz,
  ends_at        timestamptz not null,
  ended_at       timestamptz,
  winner_ids     jsonb       not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_giveaways_guild  on public.giveaways (guild_id, status);
create index if not exists idx_giveaways_ends   on public.giveaways (ends_at) where status = 'running';
create unique index if not exists uq_giveaways_message on public.giveaways (message_id) where message_id is not null;

drop trigger if exists trg_giveaways_touch on public.giveaways;
create trigger trg_giveaways_touch before update on public.giveaways
  for each row execute function public.touch_updated_at();

create table if not exists public.giveaway_entries (
  id          uuid primary key default gen_random_uuid(),
  giveaway_id uuid        not null references public.giveaways (id) on delete cascade,
  guild_id    text        not null,
  user_id     text        not null,
  created_at  timestamptz not null default now()
);
create unique index if not exists uq_giveaway_entries on public.giveaway_entries (giveaway_id, user_id);

-- ===========================================================================
-- 8. CUSTOM COMMANDS & AUTORESPONDERS
-- ===========================================================================
create table if not exists public.custom_commands (
  id            uuid primary key default gen_random_uuid(),
  guild_id      text        not null,
  name          text        not null,
  aliases       jsonb       not null default '[]'::jsonb,
  response      text        not null,
  embed         boolean     not null default false,
  cooldown      integer     not null default 3,      -- seconds, 0 = none
  allowed_roles jsonb       not null default '[]'::jsonb,
  denied_roles  jsonb       not null default '[]'::jsonb,
  allowed_channels jsonb    not null default '[]'::jsonb,
  uses          bigint      not null default 0,
  enabled       boolean     not null default true,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists uq_custom_commands_name on public.custom_commands (guild_id, lower(name));

drop trigger if exists trg_custom_commands_touch on public.custom_commands;
create trigger trg_custom_commands_touch before update on public.custom_commands
  for each row execute function public.touch_updated_at();

create table if not exists public.custom_command_uses (
  id           uuid primary key default gen_random_uuid(),
  command_id   uuid        not null references public.custom_commands (id) on delete cascade,
  guild_id     text        not null,
  user_id      text        not null,
  used_at      timestamptz not null default now()
);
create index if not exists idx_ccu_cooldown on public.custom_command_uses (command_id, user_id, used_at desc);

create table if not exists public.autoresponders (
  id          uuid primary key default gen_random_uuid(),
  guild_id    text        not null,
  trigger     text        not null,                  -- the phrase/regex source
  response    text        not null,
  match_type  text        not null default 'contains', -- exact|contains|startswith|regex
  wildcard    boolean     not null default false,
  ignore_roles jsonb      not null default '[]'::jsonb,
  allowed_channels jsonb  not null default '[]'::jsonb,
  enabled     boolean     not null default true,
  uses        bigint      not null default 0,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_autoresponders_guild on public.autoresponders (guild_id) where enabled = true;

drop trigger if exists trg_autoresponders_touch on public.autoresponders;
create trigger trg_autoresponders_touch before update on public.autoresponders
  for each row execute function public.touch_updated_at();

-- ===========================================================================
-- 9. SCHEDULED TASKS, EVENTS, POLLS
--    One queue table drives reminders, scheduled messages and event pings so
--    the scheduler has a single poll loop that survives restarts.
-- ===========================================================================
create table if not exists public.scheduled_tasks (
  id           uuid primary key default gen_random_uuid(),
  guild_id     text        not null,
  channel_id   text,
  user_id      text,                       -- creator / reminder owner
  kind         text        not null,       -- reminder|message|event_reminder
  payload      jsonb       not null default '{}'::jsonb,
  run_at       timestamptz not null,
  repeat_secs  bigint,                     -- null = one shot
  status       text        not null default 'pending', -- pending|done|cancelled|failed
  attempts     integer     not null default 0,
  last_error   text,
  processed_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists idx_scheduled_due     on public.scheduled_tasks (run_at) where status = 'pending';
create index if not exists idx_scheduled_guild   on public.scheduled_tasks (guild_id, status);

create table if not exists public.events (
  id            uuid primary key default gen_random_uuid(),
  guild_id      text        not null,
  name          text        not null,
  description   text,
  channel_id    text,
  host_id       text        not null,
  starts_at     timestamptz not null,
  ends_at       timestamptz,
  location      text,
  max_attendees integer,
  remind_before integer     not null default 900,   -- seconds before start
  reminder_sent boolean     not null default false,
  status        text        not null default 'scheduled', -- scheduled|cancelled|done
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_events_guild on public.events (guild_id, starts_at);
create index if not exists idx_events_due   on public.events (starts_at) where status = 'scheduled' and reminder_sent = false;

drop trigger if exists trg_events_touch on public.events;
create trigger trg_events_touch before update on public.events
  for each row execute function public.touch_updated_at();

create table if not exists public.event_attendees (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid        not null references public.events (id) on delete cascade,
  guild_id   text        not null,
  user_id    text        not null,
  status     text        not null default 'going', -- going|maybe|declined
  created_at timestamptz not null default now()
);
create unique index if not exists uq_event_attendees on public.event_attendees (event_id, user_id);

create table if not exists public.polls (
  id          uuid primary key default gen_random_uuid(),
  guild_id    text        not null,
  channel_id  text        not null,
  message_id  text,
  question    text        not null,
  options     jsonb       not null default '[]'::jsonb,
  votes       jsonb       not null default '{}'::jsonb,   -- { optionIndex: [userId,...] }
  multiple    boolean     not null default false,
  anonymous   boolean     not null default false,
  ends_at     timestamptz,
  closed      boolean     not null default false,
  created_by  text        not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_polls_guild on public.polls (guild_id, created_at desc);

-- ===========================================================================
-- 10. LOGGING
-- ===========================================================================
create table if not exists public.logs_config (
  guild_id    text primary key,
  enabled     boolean     not null default false,
  events      jsonb       not null default '{}'::jsonb,  -- { messages: "<channelId>", ... }
  ignored_channels jsonb  not null default '[]'::jsonb,
  ignored_roles    jsonb  not null default '[]'::jsonb,
  ignored_users    jsonb  not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

drop trigger if exists trg_logs_config_touch on public.logs_config;
create trigger trg_logs_config_touch before update on public.logs_config
  for each row execute function public.touch_updated_at();

-- Bot-level audit trail: what the staff did through the bot.
create table if not exists public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  guild_id    text        not null,
  actor_id    text,
  actor_tag   text,
  action      text        not null,
  target_type text,
  target_id   text,
  details     jsonb       not null default '{}'::jsonb,
  source      text        not null default 'slash',  -- slash|prefix|system|automod
  created_at  timestamptz not null default now()
);
create index if not exists idx_audit_guild   on public.audit_log (guild_id, created_at desc);
create index if not exists idx_audit_actor   on public.audit_log (guild_id, actor_id, created_at desc);

-- ===========================================================================
-- 11. REACTION ROLES & ROLE MENUS
-- ===========================================================================
create table if not exists public.reaction_roles (
  id          uuid primary key default gen_random_uuid(),
  guild_id    text        not null,
  channel_id  text        not null,
  message_id  text        not null,
  emoji       text        not null,
  role_id     text        not null,
  mode        text        not null default 'toggle', -- toggle|add|remove|unique
  group_key   text,
  created_by  text,
  created_at  timestamptz not null default now()
);
create unique index if not exists uq_reaction_roles on public.reaction_roles (message_id, emoji);

create table if not exists public.role_menus (
  id          uuid primary key default gen_random_uuid(),
  guild_id    text        not null,
  channel_id  text        not null,
  message_id  text,
  title       text        not null default 'Self-assignable roles',
  description text,
  options     jsonb       not null default '[]'::jsonb, -- [{ label, roleId, emoji, description }]
  mode        text        not null default 'toggle',    -- toggle|unique
  created_by  text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_role_menus_guild on public.role_menus (guild_id);

-- ===========================================================================
-- 12. USER PROFILES
-- ===========================================================================
create table if not exists public.profiles (
  id            uuid primary key default gen_random_uuid(),
  user_id       text        not null unique,       -- global, not per guild
  bio           text,
  badges        jsonb       not null default '[]'::jsonb,
  birthday      date,
  timezone      text        not null default 'UTC',
  reputation    bigint      not null default 0,
  privacy       jsonb       not null default '{"profile":true,"bio":true,"birthday":false,"stats":true,"badges":true}'::jsonb,
  color         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

create table if not exists public.reputation (
  id         uuid primary key default gen_random_uuid(),
  guild_id   text        not null,
  giver_id   text        not null,
  target_id  text        not null,
  reason     text,
  created_at timestamptz not null default now()
);
create index if not exists idx_rep_target on public.reputation (guild_id, target_id, created_at desc);
create index if not exists idx_rep_giver  on public.reputation (guild_id, giver_id, created_at desc);

create table if not exists public.afk (
  id         uuid primary key default gen_random_uuid(),
  guild_id   text        not null,
  user_id    text        not null,
  reason     text        not null default 'AFK',
  set_at     timestamptz not null default now()
);
create unique index if not exists uq_afk_guild_user on public.afk (guild_id, user_id);

-- ===========================================================================
-- 13. MISC: voice sessions & invite tracking
-- ===========================================================================
create table if not exists public.voice_sessions (
  id          uuid primary key default gen_random_uuid(),
  guild_id    text        not null,
  user_id     text        not null,
  channel_id  text        not null,
  joined_at   timestamptz not null default now(),
  left_at     timestamptz,
  seconds     integer
);
create index if not exists idx_voice_open on public.voice_sessions (guild_id, user_id) where left_at is null;

create table if not exists public.invites (
  id          uuid primary key default gen_random_uuid(),
  guild_id    text        not null,
  code        text        not null,
  inviter_id  text,
  uses        integer     not null default 0,
  max_uses    integer,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists uq_invites on public.invites (guild_id, code);

-- ===========================================================================
-- ANALYTICS INCREMENT HELPER
--   Upsert-with-increment is awkward over PostgREST, so this function does it
--   atomically in one round trip. Called with the service role key.
-- ===========================================================================
create or replace function public.bump_analytics(
  p_guild_id  text,
  p_day       date,
  p_messages  integer default 0,
  p_joins     integer default 0,
  p_leaves    integer default 0,
  p_commands  integer default 0,
  p_voice     integer default 0
)
returns void
language plpgsql
as $$
begin
  insert into public.analytics_counters (guild_id, total_messages, total_joins, total_leaves, total_commands, total_voice_seconds)
  values (p_guild_id, greatest(p_messages,0), greatest(p_joins,0), greatest(p_leaves,0), greatest(p_commands,0), greatest(p_voice,0))
  on conflict (guild_id) do update set
    total_messages      = public.analytics_counters.total_messages      + greatest(p_messages,0),
    total_joins         = public.analytics_counters.total_joins         + greatest(p_joins,0),
    total_leaves        = public.analytics_counters.total_leaves        + greatest(p_leaves,0),
    total_commands      = public.analytics_counters.total_commands      + greatest(p_commands,0),
    total_voice_seconds = public.analytics_counters.total_voice_seconds + greatest(p_voice,0),
    updated_at          = now();

  insert into public.analytics_daily (guild_id, day, messages, joins, leaves, commands, voice_seconds)
  values (p_guild_id, p_day, greatest(p_messages,0), greatest(p_joins,0), greatest(p_leaves,0), greatest(p_commands,0), greatest(p_voice,0))
  on conflict (guild_id, day) do update set
    messages      = public.analytics_daily.messages      + greatest(p_messages,0),
    joins         = public.analytics_daily.joins         + greatest(p_joins,0),
    leaves        = public.analytics_daily.leaves        + greatest(p_leaves,0),
    commands      = public.analytics_daily.commands      + greatest(p_commands,0),
    voice_seconds = public.analytics_daily.voice_seconds + greatest(p_voice,0);
end;
$$;

-- Same idea for per-channel counters.
create or replace function public.bump_channel(p_guild_id text, p_channel_id text, p_messages integer default 1)
returns void
language plpgsql
as $$
begin
  insert into public.analytics_channels (guild_id, channel_id, messages)
  values (p_guild_id, p_channel_id, greatest(p_messages,0))
  on conflict (guild_id, channel_id) do update set
    messages   = public.analytics_channels.messages + greatest(p_messages,0),
    updated_at = now();
end;
$$;

-- And per-member counters.
create or replace function public.bump_member(
  p_guild_id text,
  p_user_id  text,
  p_messages integer default 0,
  p_voice    integer default 0,
  p_commands integer default 0
)
returns void
language plpgsql
as $$
begin
  insert into public.analytics_members (guild_id, user_id, messages, voice_seconds, commands, last_seen)
  values (p_guild_id, p_user_id, greatest(p_messages,0), greatest(p_voice,0), greatest(p_commands,0), now())
  on conflict (guild_id, user_id) do update set
    messages      = public.analytics_members.messages      + greatest(p_messages,0),
    voice_seconds = public.analytics_members.voice_seconds + greatest(p_voice,0),
    commands      = public.analytics_members.commands      + greatest(p_commands,0),
    last_seen     = now(),
    updated_at    = now();
end;
$$;

-- Atomically allocate the next case number for a guild.
create or replace function public.next_case_number(p_guild_id text)
returns integer
language plpgsql
as $$
declare
  v_next integer;
begin
  select coalesce(max(case_number), 0) + 1
    into v_next
    from public.mod_cases
   where guild_id = p_guild_id;

  return v_next;
end;
$$;

-- Atomically allocate the next ticket number for a guild.
create or replace function public.next_ticket_number(p_guild_id text)
returns integer
language plpgsql
as $$
declare
  v_next integer;
begin
  select coalesce(max(ticket_number), 0) + 1
    into v_next
    from public.tickets
   where guild_id = p_guild_id;

  return v_next;
end;
$$;

-- ===========================================================================
-- ROW LEVEL SECURITY
--   Enabled, with no policies. service_role bypasses RLS; the anon key gets
--   nothing. Keeps a leaked publishable key harmless.
-- ===========================================================================
alter table public.guild_config        enable row level security;
alter table public.mod_cases           enable row level security;
alter table public.notes               enable row level security;
alter table public.ticket_panels       enable row level security;
alter table public.tickets             enable row level security;
alter table public.analytics_counters  enable row level security;
alter table public.analytics_daily     enable row level security;
alter table public.analytics_channels  enable row level security;
alter table public.analytics_members   enable row level security;
alter table public.member_snapshots    enable row level security;
alter table public.levels              enable row level security;
alter table public.level_rewards       enable row level security;
alter table public.giveaways           enable row level security;
alter table public.giveaway_entries    enable row level security;
alter table public.custom_commands     enable row level security;
alter table public.custom_command_uses enable row level security;
alter table public.autoresponders      enable row level security;
alter table public.scheduled_tasks     enable row level security;
alter table public.events              enable row level security;
alter table public.event_attendees     enable row level security;
alter table public.polls               enable row level security;
alter table public.logs_config         enable row level security;
alter table public.audit_log           enable row level security;
alter table public.reaction_roles      enable row level security;
alter table public.role_menus          enable row level security;
alter table public.profiles            enable row level security;
alter table public.reputation          enable row level security;
alter table public.afk                 enable row level security;
alter table public.voice_sessions      enable row level security;
alter table public.invites             enable row level security;

-- ===========================================================================
-- Done. Create the tables, then run `npm run deploy` locally to register the
-- slash commands in every guild listed in GUILD_IDS.
-- ===========================================================================
