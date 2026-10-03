# Deploying ZAYN'S DC BOT to Fly.io

A complete walkthrough, from an empty Fly account to a bot that stays online 24/7.

Fly.io is a good fit for this bot because it runs a **persistent machine** rather than
a request-driven function. A Discord bot holds a WebSocket open to the gateway and must
never be suspended — if the machine stops, the bot goes offline and misses every event.

---

## Why the config looks the way it does

Three decisions in `fly.toml` are deliberate and worth understanding before you change them.

**1. There is no `[http_service]` block.**
The bot has no public web surface, so it gets no public IP and no Anycast address. It is
reachable only over Fly's private 6PN network. The health endpoint still works — Fly probes
it directly on the machine, which is exactly what the top-level `[checks]` block does.

**2. `auto_stop_machines = false`, `min_machines_running = 1`.**
Fly's default is to suspend idle machines to save money. For a web app that is fine; for a
bot it is fatal. A suspended machine is an offline bot. These two settings keep it running.

**3. Exactly one machine.**
Two replicas would open two gateway sessions and **double-fire every scheduled task** —
two giveaway draws, two reminders, two tempban expiries. Keep it at one:

```bash
fly scale count 1
```

---

## Prerequisites

```bash
# Install the CLI
curl -L https://fly.io/install.sh | sh

# Authenticate (opens a browser)
fly auth login
```

You also need the bot's credentials ready:

| Value | Where to get it |
|---|---|
| `DISCORD_TOKEN` | Developer Portal → your app → **Bot** → Reset Token |
| `CLIENT_ID` | Developer Portal → your app → **General Information** → Application ID |
| `GUILD_IDS` | Discord → Developer Mode ON → right-click server → Copy Server ID |
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `SUPABASE_KEY` | Supabase → Project Settings → API → **service_role** key |

> Run `src/db/schema.sql` in the Supabase SQL editor **before** the first deploy, or the
> bot will start and immediately log `Supabase unreachable`.

---

## Step 1 — Create the app

The repository already contains `fly.toml`, so you do **not** need `fly launch` (which
would try to generate a new config and overwrite it). Create the app directly:

```bash
fly apps create zayn-dc-bot
```

If the name is taken, pick another and update the `app = "..."` line at the top of
`fly.toml` to match. The name must be globally unique across Fly.

> **Prefer `fly launch`?** Run `fly launch --no-deploy --copy-config --name zayn-dc-bot`.
> The `--copy-config` flag keeps the existing `fly.toml` instead of generating a new one.
> Answer **no** to "Would you like to deploy now?" and **no** to setting up Postgres —
> the database is Supabase, not Fly Postgres.

---

## Step 2 — Set the secrets

Secrets are encrypted at rest and injected as environment variables. **Never** put these
in `fly.toml` — that file is committed to git.

```bash
fly secrets set \
  DISCORD_TOKEN="your-bot-token" \
  CLIENT_ID="123456789012345678" \
  GUILD_IDS="111111111111111111,222222222222222222" \
  SUPABASE_URL="https://xxxxxxxxxxxx.supabase.co" \
  SUPABASE_KEY="your-service-role-key"
```

Optional extras:

```bash
fly secrets set BOT_ADMINS="your-user-id"          # bypass all permission checks
fly secrets set DEFAULT_PREFIX="."                  # prefix for new servers
fly secrets set BRAND_NAME="ZAYN" BRAND_DISCORD="ZAYN'S DC - whos.zayn_"
```

Verify what is set (values are never printed back):

```bash
fly secrets list
```

> Setting a secret restarts the machine. That is expected — do it before the first deploy
> and the restart is free.

---

## Step 3 — Deploy

```bash
fly deploy
```

Fly builds the `Dockerfile`, pushes the image, starts one machine, and waits for the
`/health` check to pass before considering the deploy successful.

A healthy first boot looks like this:

```
[bot:boot]   ZAYN's bot starting (production)
[bot:boot]   registry ready: 48 command(s), 6 component route(s)
[bot:health] health endpoint listening on 0.0.0.0:8080 (/, /health, /ready, /metrics)
[bot:boot]   logging in to Discord...
[bot:ready]  logged in as YourBot#1234 (123456789012345678)
[bot:ready]  serving 2 guild(s) for 0 cached user(s)
[bot:ready]  Supabase reachable (48ms)
[bot:ready]  ready - 62ms ping | Built by ZAYN
```

---

## Step 4 — Register the slash commands

**This is the step people forget.** Deploying the bot does not register its commands.
Until you run this, `/ban` and friends will not appear in Discord.

Run it **from your machine**, not from Fly — it is a one-time push to Discord's API, not
part of the bot's steady state:

```bash
# Locally, with a .env file containing the same values
npm install
npm run deploy
```

Expected output:

```
Registering 48 command(s) in 2 guild(s)...
✔ 111111111111111111: registered 48 command(s).
✔ 222222222222222222: registered 48 command(s).
```

Commands appear **instantly** because they are registered per-guild. Re-run `npm run deploy`
whenever you change a command's name, description or arguments — Discord caches definitions.

> **No local Node?** Run it as a one-off machine instead:
> ```bash
> fly ssh console -C "node deploy-commands.js"
> ```

---

## Step 5 — Operate it

```bash
fly status          # machine state, region, image
fly logs            # live log stream
fly logs -i <id>    # logs for one machine
fly ssh console     # shell into the machine
fly apps restart zayn-dc-bot
fly scale count 1   # enforce the single-machine rule
fly scale show      # current VM size and count
```

### Health endpoints

The bot serves these on the machine's internal port (8080):

| Path | Meaning |
|---|---|
| `/` | One-line text summary — handy for `curl` |
| `/health` | `200` while alive, `503` once shutdown begins |
| `/ready` | `200` only when logged in **and** Supabase answers |
| `/metrics` | Prometheus-format counters |

Probe them from your machine over the private network:

```bash
fly ssh console -C "wget -qO- http://localhost:8080/health"
```

---

## Updating the bot

```bash
git push                 # if you deploy from a remote builder
fly deploy               # rebuild and roll the machine
npm run deploy           # only if commands changed
```

`[deploy] strategy = "rolling"` starts the new machine, waits for its health check, then
stops the old one — so the bot is never offline during a deploy.

---

## Cost control

One `shared-cpu-1x` machine with 512 MB runs comfortably inside Fly's free allowance for a
private bot. To confirm you are not paying for idle capacity:

```bash
fly scale show
fly machine list
```

If you ever see more than one machine, `fly scale count 1` fixes it.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Deploy fails on the health check | The bot crashed before binding the port. `fly logs` shows the real error — usually a missing secret. |
| `Invalid configuration` at boot | A required secret is missing or malformed. The message names the variable. |
| Bot is online but slash commands are missing | You never ran `npm run deploy`. See Step 4. |
| Bot goes offline after a while | `auto_stop_machines` got flipped back on, or a second machine is fighting for the gateway session. Check `fly status` and `fly scale count 1`. |
| Prefix commands and XP do nothing | **Message Content Intent** is off in the Developer Portal. |
| Join/leave logs and autorole are silent | **Server Members Intent** is off. |
| `Supabase unreachable` in the logs | Wrong `SUPABASE_URL`/`SUPABASE_KEY`, or `schema.sql` was never run. |
| Writes fail with a policy error | You used the `anon` key. Switch to **service_role**. |
| Giveaways or reminders fire twice | More than one machine is running. `fly scale count 1`. |
| `port 8080 is already in use` | Harmless — the bot logs a warning and runs without the health endpoint. |

---

## Quick reference

```bash
fly apps create zayn-dc-bot
fly secrets set DISCORD_TOKEN=... CLIENT_ID=... GUILD_IDS=... SUPABASE_URL=... SUPABASE_KEY=...
fly deploy
npm run deploy          # locally, once
fly logs
fly scale count 1
```
