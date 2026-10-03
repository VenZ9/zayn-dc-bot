# Deploying ZAYN'S DC BOT to Render (free tier)

This is the complete, step-by-step guide to running the bot 24/7 on **Render's free
tier** — no credit card required. Everything here uses the checked-in
[`render.yaml`](render.yaml) Blueprint, so the service configuration is version
controlled rather than clicked together by hand.

---

## Read this first — what "free" actually costs you

Render's free tier is genuinely free (GitHub sign-in, no card), but it comes with one
behaviour you must design around:

> **A free Web Service is spun down after 15 minutes with no inbound traffic.** The next
> request triggers a cold start that takes roughly 30–90 seconds.

For a normal web app that's a slow first page load. For a **Discord bot it is fatal** —
a suspended container is an offline bot: it drops the gateway connection and misses
every message, join, ticket and scheduled task while it sleeps.

Render offers no official way to keep a free service awake. The fix used here is an
**external keep-alive pinger** hitting the bot's health endpoint every 5 minutes, which
resets the inactivity timer before it expires. That is step 6 below, and **it is not
optional** — skip it and the bot will go silent within 15 minutes of your last command.

Two honest caveats, so nothing surprises you later:

- An external pinger keeps the service **awake**, but it is a documented-against workaround
  rather than a supported guarantee. If Render restarts or redeploys the service, the bot
  comes back on its own (the pinger only needs it running again to keep it running).
- If you ever need certainty, a paid instance removes the spin-down entirely — you can
  upgrade later without changing anything else.

---

## Why a **Web** Service and not a Background Worker

A Discord bot feels like a "worker" (no web page, no visitors), so a Background Worker
looks like the natural choice. It isn't, for two reasons:

1. **Background Workers are not available on the free tier** — they start on a paid
   instance. A Web Service is the only free service type that gives a stay-alive container.
2. A Web Service gives us the **HTTP port** that both Render's own liveness probe *and*
   the keep-alive pinger need in order to talk to the container at all.

This does **not** turn the bot into a web app. It still opens its Discord gateway
connection exactly as before. The HTTP listener is the small, dependency-free sidecar
already built into `src/core/health.js` — it was in the project from the start, and it
binds `process.env.PORT` on `0.0.0.0`, which is precisely what Render expects.

### Why exactly one instance

`numInstances: 1` is pinned in the Blueprint, and autoscaling is deliberately left
unconfigured. Two instances would open **two** gateway sessions and fire every scheduled
task twice — giveaways ending twice, reminders repeating, tempbans double-logging. One
instance, always.

---

## 1. Prerequisites

- The bot's Supabase database is already provisioned (30 tables). If you are setting it up
  fresh, run `src/db/schema.sql` in the Supabase SQL editor first — see the
  [Supabase setup](README.md#1-supabase-setup) section of the README.
- This repository pushed to GitHub (it already is: `VenZ9/zayn-dc-bot`).
- Your five secret values to hand:

  | Variable | Where to get it |
  |---|---|
  | `DISCORD_TOKEN` | Discord Developer Portal → your app → **Bot** → *Reset Token* |
  | `CLIENT_ID` | Developer Portal → your app → **General Information** → *Application ID* |
  | `GUILD_IDS` | Your server ID(s), comma-separated. Enable *Developer Mode* → right-click the server → *Copy Server ID* |
  | `SUPABASE_URL` | Supabase → *Project Settings* → **API** → *Project URL* |
  | `SUPABASE_KEY` | Supabase → *Project Settings* → **API** → **`service_role`** key |

  > ⚠️ Use the **`service_role`** key, never the `anon`/publishable key. Every table has Row
  > Level Security enabled with no policies, so the anon key is locked out and *every write
  > fails*. The `service_role` key bypasses RLS, which is the intended design for a bot that
  > authenticates as itself rather than as a user.

---

## 2. Create the Render account

1. Go to <https://render.com> and click **Get Started**.
2. Choose **GitHub** and authorise Render to read your repositories.
   Render needs read access to clone and build; it does **not** need write access, so
   you can grant it *only* this repository if you prefer.
3. **No payment details are requested on the free tier.**

---

## 3. Apply the Blueprint

1. In the Render dashboard click **New +** (top right) → **Blueprint**.
2. Pick the repository **`VenZ9/zayn-dc-bot`**.
3. Render reads `render.yaml` and shows a preview of what it will create — one web service
   named **`zayn-dc-bot`**, on the **free** plan, in **Singapore**.
4. Render now prompts for each variable marked `sync: false`. Paste in your five secrets:

   ```
   DISCORD_TOKEN   = <your bot token>
   CLIENT_ID       = 123456789012345678
   GUILD_IDS       = 111111111111111111,222222222222222222
   SUPABASE_URL    = https://ypxtcocassjoaandbjxo.supabase.co
   SUPABASE_KEY    = <your service_role key>
   ```

   These are stored **encrypted on the service**, never written into the repository. The
   `render.yaml` file contains only the *names*.

5. Click **Apply** / **Create Resources**. The first build starts immediately.

> **Blueprint or manual?** You can also create the service by hand via
> **New + → Web Service**, set *Language* to **Docker**, *Instance Type* to **Free**, and add
> the same variables under *Environment*. The Blueprint does all of that for you and keeps it
> reproducible, so prefer it.

---

## 4. Watch the first deploy

The build runs `npm ci --omit=dev` inside `node:20-alpine` (about a minute). Then watch
the logs:

```text
[health] health endpoint listening on 0.0.0.0:10000 (/, /health, /ready, /metrics)
[boot]   ZAYN's bot starting (production)
[boot]   registry ready: 48 command(s), 6 component route(s)
[boot]   logging in to Discord...
[ready]  logged in as ZAYNMachine#1234 - 42ms ping
```

The service flips to **Live** once the health check passes.

### One thing to do AFTER the first deploy

Slash commands are registered as **guild commands**, pushed by a script — *not* by the
running bot. Deploying the service does not publish them. From your machine:

```bash
git clone https://github.com/VenZ9/zayn-dc-bot.git
cd zayn-dc-bot
npm install
cp .env.example .env      # fill in DISCORD_TOKEN, CLIENT_ID, GUILD_IDS
npm run deploy            # per-guild registration → commands appear INSTANTLY
```

Re-run `npm run deploy` **whenever a command's name, description or arguments change** —
Discord caches definitions, so a renamed option keeps its old shape until you re-register.

---

## 5. About the health check path

The Blueprint sets:

```yaml
healthCheckPath: /health
```

`/health` is the right choice and `/ready` is the wrong one, which is worth understanding
because it is a common way to accidentally brick a deploy:

| Endpoint | Returns 200 when | Suitable as `healthCheckPath`? |
|---|---|---|
| `/` | Process alive | Yes (plain text summary) |
| **`/health`** | **Process alive and not shutting down** | ✅ **Yes — used here** |
| `/healthz` | Alias of `/health` | Yes |
| `/ready` | Logged in to Discord **and** a Supabase round-trip succeeds | ❌ **No** |
| `/metrics` | Process alive | Yes (Prometheus counters) |

The behaviour is deliberate and already implemented in `src/core/health.js`:

- **`/health` answers 200 as soon as the process is up — before the gateway handshake
  completes.** A liveness probe is asking "is this container alive?", so it should pass
  during startup. This is exactly what a keep-alive pinger needs too: the pinger's job is
  to prove *traffic arrived*, not that Discord is reachable.
- **`/ready` stays 503 until the bot is fully logged in and the database answers.** That
  makes it the right target for a *readiness* check or a monitoring alert — but as a
  `healthCheckPath` it would fail the deploy during the normal login window and, later,
  during any brief Supabase blip.

While shutting down, `/health` flips to 503 so Render drains the container cleanly on
redeploy instead of killing it mid-request.

---

## 6. Keep it awake (required)

Without this the bot sleeps after 15 idle minutes. Pick **one** of the free services below
and point it at your health URL.

Your health URL is:

```
https://zayn-dc-bot.onrender.com/health
```

> Use the exact hostname Render shows on the service page — if the name was already taken,
> Render appends a suffix (e.g. `zayn-dc-bot-a1b2.onrender.com`). **This domain is the one
> value in this guide you must copy from the dashboard rather than the file.**

### Option A — UptimeRobot (recommended)

1. Sign up free at <https://uptimerobot.com> (no card).
2. **Add New Monitor**
   - *Monitor Type*: **HTTP(s)**
   - *Friendly Name*: `ZAYN DC Bot`
   - *URL*: `https://zayn-dc-bot.onrender.com/health`
   - *Monitoring Interval*: **5 minutes**
3. Save. The free plan allows 50 monitors at 5-minute intervals — comfortably inside the
   15-minute window, with a 3× safety margin.

### Option B — cron-job.org

1. Sign up free at <https://cron-job.org>.
2. **Create cronjob**
   - *Title*: `ZAYN DC Bot keep-alive`
   - *URL*: `https://zayn-dc-bot.onrender.com/health`
   - *Schedule*: every **5 minutes** (`*/5 * * * *`)
3. Save. Enable **"Save responses in job history"** off to stay inside the free quota.

### Choosing an interval

| Interval | Verdict |
|---|---|
| 1 minute | Works, but needlessly noisy and burns free quota |
| **5 minutes** | ✅ **Recommended** — 3× margin under the 15-minute limit |
| 10 minutes | Works, but a single missed ping risks a sleep |
| 15+ minutes | ❌ Will not work — the service sleeps between pings |

**Verify it's working:** watch the Render log for a `GET /health` line every 5 minutes.
Then, after leaving the bot alone for 20 minutes, run any command in Discord — an instant
reply means it never slept.

---

## 7. Verify the deployment

```bash
# Liveness — 200 the moment the process is up.
curl https://zayn-dc-bot.onrender.com/health

# Readiness — 200 only once logged in to Discord AND Supabase answers.
# During the first ~30s this is 503. That is correct, not a bug.
curl https://zayn-dc-bot.onrender.com/ready

# Prometheus counters: uptime, guild count, gateway latency.
curl https://zayn-dc-bot.onrender.com/metrics
```

A healthy `/ready` response looks like:

```json
{
  "ok": true,
  "status": "ready",
  "discord": { "loggedIn": true, "user": "ZAYNMachine#1234", "ping": 42, "guilds": 2 },
  "database": { "configured": true, "ok": true, "latencyMs": 38 },
  "ready": true
}
```

In Discord: the bot shows **online**, `/ping` replies, and a prefix command like `.help`
works. Then confirm persistence with `/config view` — it should read from Supabase rather
than erroring.

---

## 8. Updating and redeploying

`autoDeployTrigger: commit` means **every push to `main` redeploys automatically**.

```bash
git add .
git commit -m "your change"
git push origin main        # Render builds and deploys on its own
```

Or force one from the dashboard: **service → Manual Deploy → Deploy latest commit**.

To change a command, push the code **and** re-run `npm run deploy` locally:

```bash
git push origin main && npm run deploy
```

---

## 9. Environment variables reference

Set these in the Render dashboard under **Environment**. The five marked `sync: false` in
`render.yaml` are entered during the first Blueprint apply; the rest carry sensible
defaults already committed.

| Variable | Secret? | Purpose |
|---|---|---|
| `DISCORD_TOKEN` | 🔒 yes | Bot token. Without it the bot cannot log in. |
| `CLIENT_ID` | 🔒 yes | Application ID, used to register slash commands. |
| `GUILD_IDS` | 🔒 yes | Comma-separated server IDs for instant per-guild command registration. |
| `SUPABASE_URL` | 🔒 yes | `https://ypxtcocassjoaandbjxo.supabase.co` |
| `SUPABASE_KEY` | 🔒 yes | **`service_role`** key — bypasses RLS so the bot can write. |
| `NODE_ENV` | no | `production` |
| `HEALTH_ENABLED` | no | `true` — enables the HTTP listener the pinger needs. |
| `TASKS_ENABLED` | no | `true` — background scheduler (giveaways, reminders, tempbans). |
| `TASK_INTERVAL_SECONDS` | no | `30` — scheduler poll interval. |
| `LOG_LEVEL` | no | `info` (use `debug` when troubleshooting). |
| `BRAND_NAME` | no | `ZAYN` |
| `BRAND_DISCORD` | no | `ZAYN'S DC - whos.zayn_` |
| `BRAND_FOOTER` | no | `Built by ZAYN` |
| `DEFAULT_PREFIX` | no | `.` — prefix for servers that haven't run `/config prefix`. |
| `PREFIX_COMMANDS_ENABLED` | no | `true` |
| `BOT_ADMINS` | no | Optional comma-separated user IDs that skip permission checks. |
| `PORT` | 🚫 **never set** | Render injects it. Setting it by hand is the usual cause of *"no open ports detected"*. |

To add or change a secret after the fact: **service → Environment → Add Environment
Variable → Save** (triggers a redeploy). Render deliberately **ignores** `sync: false`
variables when re-applying an existing Blueprint, so add new secrets here, not in the file.

---

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Deploy fails: *"no open ports detected"* | You set `PORT` manually, or `HEALTH_ENABLED=false`. Remove the `PORT` var; the bot must bind Render's injected `PORT` on `0.0.0.0`. |
| Service is Live but the bot shows **offline** | The process is up but the gateway connection failed. Check the logs for `Failed to start:` — usually a bad `DISCORD_TOKEN`, or `CLIENT_ID` not being digits. |
| Bot replies, but the service **sleeps after 15 min** | No keep-alive pinger, or it's pointed at the wrong URL. Re-check step 6, and confirm the hostname matches the dashboard exactly. |
| Prefix commands do nothing, slash commands work | **Message Content Intent** is off. Developer Portal → Bot → *Privileged Gateway Intents* → enable **Message Content** *and* **Server Members**, then restart the Render service. The bot logs a warning at boot when an intent is missing. |
| Writes fail with a policy / permission error | You're using the `anon` key. Switch `SUPABASE_KEY` to the **`service_role`** key. |
| `Supabase unreachable` at startup | `SUPABASE_URL` / `SUPABASE_KEY` are wrong, or `schema.sql` was never run against that project. |
| Giveaways or reminders fire **twice** | More than one instance is running. Confirm `numInstances: 1`, and check there isn't a second service in the dashboard pointing at the same repo. |
| First command after a quiet spell takes ~50s | The container slept — the pinger isn't running or is too slow. Nothing in the code causes this. |
| `/ready` returns 503 while the bot works fine in Discord | Expected during startup and during a Supabase blip. `/ready` requires **both**; `/health` is the liveness check. |

Logs live under **service → Logs** in the dashboard, and can be streamed with the Render
CLI if you prefer. Set `LOG_LEVEL=debug` temporarily for more detail, then put it back.

---

## 11. Reference — the Blueprint, annotated

```yaml
services:
  - type: web                 # free tier needs a web service, not a worker
    name: zayn-dc-bot
    runtime: docker           # uses the existing production Dockerfile
    dockerfilePath: ./Dockerfile
    plan: free
    region: singapore         # closest free region to the Tokyo Supabase project
    branch: main
    autoDeployTrigger: commit # the modern replacement for `autoDeploy: true`
    numInstances: 1           # two would double-fire every scheduled task
    healthCheckPath: /health  # 200 as soon as the process is up
    envVars:
      - key: DISCORD_TOKEN
        sync: false           # prompted for at apply time, never committed
```

`autoDeployTrigger` is the current field name; `autoDeploy` is deprecated but still
accepted. `sync: false` is what keeps secrets out of the repository — Render prompts for
each one during the first Blueprint apply and stores it encrypted on the service.
