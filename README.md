# ZAYN'S DC BOT

A multi-purpose Discord bot built on **discord.js v14** with **13 feature modules**, hybrid **slash + prefix** commands and **Supabase (Postgres)** persistence.

Built by **ZAYN** — branding, quotes, acceptance criteria and deployment are all owned end-to-end.

---

## Table of contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Prerequisites](#prerequisites)
4. [Supabase setup](#1-supabase-setup)
5. [Discord application setup](#2-discord-application-setup)
6. [Configuration](#3-configuration)
7. [Install and run](#4-install-and-run)
8. [Registering slash commands](#5-registering-slash-commands)
9. [Self-check](#6-self-check)
10. [Deploying to Fly.io](#7-deploying-to-flyio)
11. [Deploying to Koyeb](#8-deploying-to-koyeb)
12. [Deploying to Render (free tier)](#9-deploying-to-render-free-tier)
13. [Docker](#10-docker)
14. [Command reference](#command-reference)
15. [Troubleshooting](#troubleshooting)

---

## Features

| # | Module | What it does |
|---|--------|--------------|
| 1 | 🛡️ **Moderation** | Ban, tempban, unban, kick, mute, unmute, warn, purge, slowmode, lock/hide channels, nicknames, notes, cases, history |
| 2 | ⚙️ **Server Management** | Server, user, role and channel information |
| 3 | 🎫 **Ticket System** | Panels, claiming, priorities, added members, HTML transcripts, statistics |
| 4 | 📊 **Server Analytics** | Message, member, channel and voice statistics from daily rollups |
| 5 | 👋 **Welcome & Goodbye** | Greeting messages with placeholders, images, autorole and DM welcomes |
| 6 | 🎭 **Roles & Permissions** | Role CRUD, mass assign, reaction roles and interactive role menus |
| 7 | 🎁 **Giveaways** | Timed giveaways, requirements, bonus entries, pause, reroll |
| 8 | 📈 **Leveling & XP** | XP from messages and voice, ranks, leaderboards, level rewards |
| 9 | 📅 **Events & Scheduling** | Guild events with RSVPs and reminders, plus timed messages |
| 10 | 📝 **Custom Commands** | Your own triggers with template variables, and reaction-free autoresponders |
| 11 | 🧾 **Logging & Audit** | Per-category event logs and a staff audit trail |
| 12 | 🔧 **Bot Configuration** | Prefix, language, timezone, mod log, mute/DJ roles, backups |
| 13 | 👤 **User Profiles** | Bios, badges, birthdays, timezones, privacy, reputation and stats |

Every command works **both ways** — as `/ban` and as `.ban` — unless it is marked slash-only.

---

## Architecture

```
discord-bot/
├── index.js                  # entrypoint: config → commands → client → events → login
├── deploy-commands.js        # registers slash commands (guild or global)
├── scripts/check.js          # offline load test (no Discord / DB needed)
├── Dockerfile                # production image
├── fly.toml                  # Fly.io config (always-on, single machine)
├── fly-deploy.md             # Fly.io walkthrough
├── render.yaml               # Render Blueprint (free tier, single instance)
├── render-deploy.md          # Render walkthrough + keep-alive setup
├── docker-compose.yml
├── .env.example
└── src/
    ├── config.js             # env parsing + validation
    ├── core/
    │   ├── client.js         # intents, partials, cache limits
    │   ├── health.js         # optional health-check HTTP server
    │   ├── command.js        # defineCommand, slash payload builder, arg parsing
    │   ├── context.js        # one Context for slash, prefix and components
    │   ├── handler.js        # permission gate, cooldowns, error handling
    │   ├── loader.js         # walks src/modules and src/events
    │   ├── components.js     # button / select / modal router
    │   ├── prefix.js         # message → Context, token resolution
    │   └── slash.js          # interaction → Context
    ├── lib/                  # constants, embeds, ui, helpers, logger, permissions, xp
    ├── db/
    │   ├── index.js          # Supabase client + query helpers
    │   └── schema.sql        # 30 tables, run once in the SQL editor
    ├── events/               # ready, interactionCreate, messageCreate, guild, guildMember
    ├── tasks/scheduler.js    # background loop: giveaways, tempbans, reminders, timed messages
    └── modules/              # one folder per feature module
```

**Two permission gates.** Every command first checks Discord permissions (`userPerms`), then a custom permission node such as `moderation.ban`. Nodes are resolved from admin roles, staff roles and Discord permissions, so servers can grant fine-grained access without giving out Administrator.

**One Context.** Slash, prefix and component interactions all produce the same `Context` object, so a handler never needs to know how it was invoked — it just calls `ctx.reply()`, `ctx.error()` or `ctx.confirm()`.

---

## Prerequisites

- **Node.js 20 or newer**
- A **Discord application** with a bot user
- A **Supabase project** (free tier is fine)

---

## 1. Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor → New query**.
3. Paste the entire contents of [`src/db/schema.sql`](src/db/schema.sql) and click **Run**.

   This creates the 30 tables the bot uses, their indexes, `updated_at` triggers and the analytics helper functions. It is idempotent — every statement uses `if not exists`, so it is safe to re-run.

4. Go to **Project Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **service_role** key → `SUPABASE_KEY`

> **Use the `service_role` key, not the `anon` key.** The bot authenticates as itself, not as an end user, so Row Level Security would block its writes with the anon key. The service role key bypasses RLS by design and must never be exposed to the browser or committed to git.

---

## 2. Discord application setup

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications).
2. **General Information → Application ID** → this is `CLIENT_ID`.
3. **Bot → Reset Token** → this is `DISCORD_TOKEN`. Treat it like a password.
4. **Bot → Privileged Gateway Intents** — switch **all three** ON:
   - ✅ **Presence Intent** (optional but recommended)
   - ✅ **Server Members Intent** — required for join/leave logs, autorole and member lookups
   - ✅ **Message Content Intent** — required to read prefix commands and autoresponders

   Without these the bot logs in but silently misses events. `npm start` warns you about any intent that is not granted.

5. **OAuth2 → URL Generator** — tick the `bot` and `applications.commands` scopes, then tick these permissions and use the generated URL to invite the bot:

   `View Channels`, `Send Messages`, `Embed Links`, `Attach Files`, `Read Message History`,
   `Add Reactions`, `Use External Emojis`, `Manage Messages`, `Manage Channels`, `Manage Roles`,
   `Manage Nicknames`, `Manage Webhooks`, `Manage Events`, `Kick Members`, `Ban Members`,
   `Moderate Members`, `Create Invite`, `Connect`, `Speak`, `Mention Everyone`

   Tick exactly what you need — Discord encodes the permission integer into the URL for you, so there is no number to copy by hand.

> The bot's highest role must sit **above** every role it manages (mute role, autorole, level rewards, reaction roles). Discord silently refuses role changes otherwise.

---

## 3. Configuration

Copy the template and fill it in:

```bash
cp .env.example .env
```

| Variable | Required | Notes |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | Bot token from the Developer Portal |
| `CLIENT_ID` | ✅ | Application ID |
| `GUILD_IDS` | ✅ | Comma-separated server IDs. Commands register per guild so they appear **instantly** |
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_KEY` | ✅ | Supabase **service_role** key |
| `DEV_GUILD_ID` | — | Guild used for local previews; defaults to the first `GUILD_IDS` entry |
| `BOT_ADMINS` | — | User IDs that bypass every permission check |
| `DEFAULT_PREFIX` | — | Prefix for new servers (default `.`) |
| `PREFIX_COMMANDS_ENABLED` | — | Master switch for prefix commands (default `true`) |
| `TASKS_ENABLED` | — | Background scheduler (default `true`) |
| `TASK_INTERVAL_SECONDS` | — | Scheduler tick, 10–3600 (default `30`) |
| `HEALTH_ENABLED` | — | Health-check HTTP server (default `true`) |
| `PORT` | — | Port the health server binds. Injected by Fly.io/Koyeb/Render; defaults to `8000` |
| `BRAND_NAME` / `BRAND_DISCORD` / `BRAND_FOOTER` / `BRAND_LINK` | — | Branding used in embeds, presence and `/help` |
| `LOG_LEVEL` | — | `error`, `warn`, `info` (default), `debug` |

**Where to find a server ID:** Discord → User Settings → Advanced → **Developer Mode** ON, then right-click the server icon → **Copy Server ID**.

---

## 4. Install and run

```bash
npm install
npm run deploy     # register slash commands in the guilds from GUILD_IDS
npm start          # start the bot
```

`npm start` validates the environment first and refuses to boot with a readable message if something is missing or malformed — you will never get a mysterious crash later.

---

## 5. Registering slash commands

```bash
npm run deploy         # per-guild — appears instantly (recommended)
npm run deploy:global  # global — can take up to an hour to propagate
```

Re-run `npm run deploy` **every time you change a command's name, description or arguments**. Discord caches command definitions, so a renamed option will keep its old shape until you re-register.

---

## 6. Self-check

```bash
npm run check          # load every command, event and task
npm run check:strict   # also fail on warnings
```

This loads the whole bot the same way `index.js` does — it needs **no Discord connection and no database** — then prints a summary and exits non-zero if anything failed. Run it before every deploy and in CI.

---

## 7. Deploying to Fly.io

Fly.io runs a **persistent machine**, which is what a Discord bot needs — it holds a
WebSocket open to the gateway and must never be suspended. The included `fly.toml` is
already configured for that: no public HTTP service, `auto_stop_machines = false`,
`min_machines_running = 1`, and exactly one machine.

```bash
# 1. install and authenticate the CLI
curl -L https://fly.io/install.sh | sh
fly auth login

# 2. create the app (fly.toml already exists - do NOT run bare `fly launch`)
fly apps create zayn-dc-bot

# 3. set the secrets (never put these in fly.toml - it is committed)
fly secrets set \
  DISCORD_TOKEN="your-bot-token" \
  CLIENT_ID="123456789012345678" \
  GUILD_IDS="111111111111111111,222222222222222222" \
  SUPABASE_URL="https://xxxxxxxxxxxx.supabase.co" \
  SUPABASE_KEY="your-service-role-key"

# 4. deploy
fly deploy

# 5. register the slash commands - from your machine, once
npm run deploy

# 6. watch it
fly logs
```

**The three things that matter:**

- **No `[http_service]` block.** The bot has no public web surface, so it gets no public IP.
  The health endpoint is still probed — Fly checks it directly on the machine via the
  top-level `[checks]` block.
- **`auto_stop_machines = false`.** Fly suspends idle machines by default. A suspended
  machine is an offline bot that misses every event.
- **Exactly one machine.** Two replicas open two gateway sessions and double-fire every
  scheduled task. Enforce it with `fly scale count 1`.

**Health endpoints** (internal port 8080): `/` text summary, `/health` liveness,
`/ready` readiness (logged in **and** Supabase reachable), `/metrics` Prometheus counters.

> **Full walkthrough:** see [`fly-deploy.md`](fly-deploy.md) for the complete guide,
> including cost control, updating, and a troubleshooting table.

---

## 8. Deploying to Koyeb

1. Push this repository to GitHub.
2. In [Koyeb](https://app.koyeb.com), create a **Web Service** from the repository.
3. **Build:** the included `Dockerfile` is detected automatically. Otherwise:
   - Build command: `npm ci --omit=dev`
   - Run command: `node index.js`
4. Add every variable from your `.env` under **Environment variables**. Do not upload `.env`.
5. Set **Instance type** to at least **Nano** (512 MB). Leveling and logging hold a small in-memory cache, so 512 MB is comfortable.
6. Deploy. The logs should show `logged in as …` followed by `ready — Nms ping`.

> **Register commands from your machine, not from Koyeb.** Run `npm run deploy` locally before deploying, or add a one-off Koyeb job with the `npm run deploy` command. Command registration is a one-time push, not part of the bot's steady state.

**Always-on note:** a Discord bot must stay connected to receive events. Koyeb scales to zero on some plans — make sure the service is set to keep one instance running, otherwise the bot will appear offline. The same applies to Render's free tier, which spins down after 15 idle minutes — see [Deploying to Render](#9-deploying-to-render-free-tier) for the keep-alive setup.

---

## 9. Deploying to Render (free tier)

Render's free tier runs the bot on a **Web Service** with no credit card. The repository
ships a [`render.yaml`](render.yaml) Blueprint that configures the whole service, so
deploying is: connect the repo, paste five secrets, apply — no CLI required.

```bash
# 1. https://render.com -> Get Started -> sign in with GitHub
# 2. New + -> Blueprint -> pick VenZ9/zayn-dc-bot
# 3. Render prompts for the five `sync: false` secrets:
#      DISCORD_TOKEN, CLIENT_ID, GUILD_IDS, SUPABASE_URL, SUPABASE_KEY
# 4. Apply -> it builds from the Dockerfile and deploys

# 5. register the slash commands - from your machine, once
npm run deploy
```

**Why a Web Service and not a Background Worker:** free-tier Background Workers do not
exist, and the Web Service provides the HTTP port that both Render's liveness probe and an
external keep-alive pinger need. The bot is *not* turned into a web app — it opens its
Discord gateway connection exactly as before. The HTTP listener is the small,
dependency-free sidecar already in `src/core/health.js`.

**The one step you must not skip:** free Web Services **spin down after 15 minutes of
inactivity**, and a sleeping bot is an offline bot. Point a free uptime monitor
(UptimeRobot or cron-job.org) at `https://<your-service>.onrender.com/health` every
**5 minutes** to keep it awake. Render offers no official way around the spin-down on the
free tier — this external ping is the workaround, and without it the bot goes silent within
15 minutes of your last command.

**Health check path:** `/health`. It answers 200 as soon as the process is up, *before* the
Discord handshake completes — which is what a liveness probe should test, and what the
keep-alive pinger needs. `/ready` is deliberately stricter (it also requires a successful
Supabase round-trip) and would fail the deploy during the normal login window, so it is
**not** used as the health check path.

**Instance count is pinned to 1.** Two instances would open two gateway sessions and
fire every scheduled task twice — giveaways ending twice, reminders repeating, tempbans
double-logging.

**After the first deploy**, run `npm run deploy` locally to publish the slash commands —
command registration is a one-time push from your machine, not part of the bot's steady
state.

Health endpoints on Render: `/` text summary, `/health` liveness, `/ready` readiness
(logged in **and** Supabase reachable), `/metrics` Prometheus counters.

> **Full walkthrough:** see [`render-deploy.md`](render-deploy.md) for the complete guide,
> including the keep-alive setup, free-tier caveats, an env-var reference and a
> troubleshooting table.

---

## 10. Docker

```bash
docker build -t zayn-dc-bot .
docker run --rm --env-file .env zayn-dc-bot
```

or with compose:

```bash
docker compose up --build
```

The image is a slim Node 20 base running as a non-root user, with `NODE_ENV=production` and `npm ci --omit=dev`.

---

## Command reference

Run `/help` to browse every module, or `/help module:<name>` for one module. `/setup` prints a guided checklist of what still needs configuring on a fresh server and fills a progress bar as you complete it.

Highlights:

```
/ban  /tempban  /unban  /kick  /mute  /warn  /purge  /lock  /slowmode
/ticket setup  /ticket panel  /ticket close  /ticket transcript
/welcome setup  /welcome message  /welcome autorole
/role add  /role menu  /role reactionrole
/giveaway start  /giveaway reroll  /giveaway end
/rank  /leaderboard  /levels rewards
/event create  /event schedule
/customcmd add  /autoresponder add
/logs setup  /logs channel  /logs test
/config prefix  /config timezone  /config backup
/profile view  /profile bio  /profile rep  /afk
```

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Slash commands do not appear | `GUILD_IDS` does not list the server, or the commands were never registered. Copy the server ID again and re-run `npm run deploy`. |
| Commands appear but a changed option did not update | Discord caches definitions. Re-run `npm run deploy`. |
| Bot logs in, but prefix commands and XP do nothing | **Message Content Intent** is off in the Developer Portal. |
| Join/leave logs and autorole are silent | **Server Members Intent** is off. |
| `Cannot find module` or a command silently missing | Run `npm run check` — it names the file and the reason. |
| A permission error on role actions | The bot's highest role is not above the role it is trying to manage. Drag it up in Server Settings → Roles. |
| `Supabase unreachable` on startup | `SUPABASE_URL` / `SUPABASE_KEY` are wrong, or `schema.sql` has not been run. |
| Writes fail with a policy error | You are using the `anon` key. Switch to the **service_role** key. |
| Reminders, giveaways or timed messages never fire | `TASKS_ENABLED=false`. Note that schedules run on the tick interval, so a job fires within one tick of its due time. |
| Giveaways or reminders fire **twice** | More than one instance is running. On Fly.io: `fly scale count 1`. On Render: confirm `numInstances: 1`. |
| Bot goes offline after a while on Fly.io | `auto_stop_machines` was flipped back on, or a second machine is competing for the gateway session. Check `fly status`. |
| Bot goes offline after ~15 min on Render's free tier | Free Web Services spin down when idle. Set up the 5-minute keep-alive ping — see [Deploying to Render](#9-deploying-to-render-free-tier). |

---

## Branding

Branding is configurable, not hard-coded. Set the `BRAND_*` variables to change the bot's name, handle and footer everywhere at once — embeds, presence and `/help` all read from the same source. Defaults:

- **Name:** ZAYN
- **Handle:** ZAYN'S DC - whos.zayn_
- **Footer:** Built by ZAYN

The media kit and promotional assets that accompany this build live outside the repository; keep them in step with `BRAND_*` whenever they change.

---

## License

MIT
