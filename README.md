# lg-shabbat-fridge

Turns an LG WiFi refrigerator's **Sabbath mode** on every Friday and back
off Saturday night — automatically, for free, with no server to run or pay
for. It runs entirely on a [GitHub Actions](https://github.com/features/actions)
schedule in this repo; there's nothing else to host.

This was extracted from a larger internal business app it didn't belong in,
so it could stand on its own as a small, free, personal automation.

## How it works

LG exposes Sabbath mode two different ways, and which one is actually
*writable* varies by fridge model:

1. **Official ThinQ Connect API** (`api-aic.lgthinq.com`) — the documented,
   supported path. Auth is a Personal Access Token you generate once at
   [connect-pat.lgthinq.com](https://connect-pat.lgthinq.com). Some models
   report `sabbathMode` as **read-only** here even though the phone app can
   flip it.
2. **The "app channel"** — the private API the ThinQ phone app itself uses.
   Auth is a normal LG account sign-in (email+password, or a browser
   hand-off for Google/Apple/Amazon/Facebook LG accounts); only the
   resulting **refresh token** is ever kept, never the password.

This tool tries the official API first and automatically falls back to the
app channel if the official one is read-only on your model — same as the
original design. A scheduled job (`scripts/tick.js`) checks the real time in
`America/New_York` on every run and only acts on:

- **Friday, at or after `SHABBAT_ON_TIME`** (default `12:00`) → turn ON
- **Saturday, at or after `SHABBAT_OFF_TIME`** (default `22:00`) → turn OFF
  (skippable via `SHABBAT_OFF_ENABLED=false` if you'd rather flip it back
  on manually)

It's stateless: before flipping, it **reads the fridge's current Sabbath
state** and no-ops if it's already where it should be. That means a missed
run, a manual flip, or the job simply running again 15 minutes later can
never double-fire or drift out of sync — there's no "did I already run this
week" flag to get stuck.

## One-time setup

You need Node 20+ locally for this part (setup only — the scheduled job
runs on GitHub's infrastructure, not your machine).

```bash
npm install   # no dependencies today, but harmless / future-proof
```

### Step 1 — try the official API

```bash
npm run setup:official
```

Paste your PAT when asked, pick your fridge from the list, and it probes
whether Sabbath mode is writable. If it is, it prints the secrets to save
(see below) and **you're done** — skip step 2.

### Step 2 — app-channel fallback (only if step 1 said read-only)

```bash
npm run setup:v2
```

Choose email+password (works for native LG accounts) or the browser
paste-URL flow (needed for Google/Apple/Amazon/Facebook LG accounts — the
script prints a link, you sign in, then paste back the address of the
*error page* you land on afterward, which is expected). It then lists your
devices, probes the selected one, and prints the secrets to save.

### Step 3 — add the printed secrets to this repo

GitHub repo → **Settings → Secrets and variables → Actions → New repository
secret**. Add whichever block step 1 or 2 printed. You only need ONE
channel's worth of secrets — the tool auto-detects which one is configured
(official takes priority if both happen to be set).

Optional schedule secrets (defaults shown — only add these if you want to
change them):

| Secret | Default | Meaning |
|---|---|---|
| `SHABBAT_ENABLED` | `true` | Master on/off switch for the whole automation |
| `SHABBAT_ON_TIME` | `12:00` | Friday trigger time, ET, 24h `HH:MM` |
| `SHABBAT_OFF_ENABLED` | `true` | Whether the Saturday-night OFF flip runs at all |
| `SHABBAT_OFF_TIME` | `22:00` | Saturday trigger time, ET, 24h `HH:MM` |

### Step 4 — enable Actions and test it

Actions are enabled by default on a new repo. Go to the **Actions** tab →
**Shabbat mode tick** → **Run workflow**, and pick `force: on` or
`force: off` to test a flip immediately without waiting for Friday. Check
the run's log — it prints exactly what channel it used and what it did.

After that, it just runs itself.

## Manual local testing

```bash
npm run manual:on
npm run manual:off
```

These read the same secrets as the scheduled job — export them as
environment variables locally, or use a `.env`-style loader of your choice
(a plain `.env` file is gitignored if you want one; this repo doesn't ship
a dotenv loader to stay dependency-free, so `export $(cat .env | xargs)` or
similar works fine for a quick local test).

## The schedule (`.github/workflows/shabbat-tick.yml`)

The job runs every 15 minutes during the windows that can possibly contain
the Friday/Saturday triggers (accounting for both EST and EDT), and exits
instantly as a no-op outside of Friday/Saturday ET — so it costs almost
nothing even on GitHub's free Actions minutes. If you customize
`SHABBAT_ON_TIME` / `SHABBAT_OFF_TIME` to fall *outside* the covered UTC
windows, widen the cron lines in the workflow file to match.

Making the repo **public** removes any Actions-minutes limit entirely (free
and unlimited on public repos) if you'd rather not think about it — nothing
sensitive is ever committed to the repo itself, only referenced via GitHub
Secrets (which are encrypted at rest and never printed in logs).

## Security notes

- Your LG password is used once, in-memory, during `setup:v2` — it is
  never written to disk or printed, and isn't sent anywhere except LG's own
  login endpoint.
- Only the resulting refresh token (app channel) or PAT (official API) is
  persisted, and only as a GitHub Actions secret — encrypted at rest,
  never exposed in workflow logs, and readable only by workflows in this
  repo.
- `THINQ_V2_SABBATH_CTRL` is not a secret in the traditional sense (it's a
  probed capability description, not a credential) but is stored as a
  secret anyway for convenience since GitHub Secrets are simpler to manage
  as a single block than mixing Secrets and Variables.

## Troubleshooting

- **LG error 9006 / 9012 ("consider using the official API")** — the app
  channel occasionally flags a client id as suspicious. The code already
  rotates the client id and retries once per run automatically; if it keeps
  happening, rerun `setup:v2` to get a fresh token set.
- **`v2Gateway`/`route.lgthinq.com:46030` unreachable** — some sandboxed or
  restrictive network environments block this non-standard port. It works
  fine from GitHub Actions runners and typical home/office networks.
- **Probe says `controllable: false` on the app channel too** — paste the
  full probe JSON (printed by `setup:v2`) when asking for help; it shows
  exactly which commands and fields your model's `ControlWifi` block
  exposes, which is what a fix has to work with.
- **Nothing happens at the expected time** — check the Actions tab's run
  history for that Friday/Saturday; the log always states the channel it
  detected, the current ET clock, and why it did or didn't act.

## Credits

The app-channel client is ported from
[ollo69/ha-smartthinq-sensors](https://github.com/ollo69/ha-smartthinq-sensors)
(`wideq/core_async.py`) and
[nVuln/homebridge-lg-thinq](https://github.com/nVuln/homebridge-lg-thinq) —
the most battle-tested open reverse-engineering of LG's private API. Every
constant in `src/thinqV2.js` (app keys, signature secret, header set) is
public, shipped inside LG's own Android app, and not a secret.
