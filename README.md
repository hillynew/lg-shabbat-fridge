# lg-shabbat-fridge

Turns an LG WiFi refrigerator's **Sabbath mode** on for every **Shabbos and
Yom Tov** — automatically, for free, with no server to run or pay for. It
runs entirely on a [GitHub Actions](https://github.com/features/actions)
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
app channel if the official one is read-only on your model.

### The schedule itself

`src/hebcal.js` computes the real schedule from
[Hebcal](https://www.hebcal.com)'s public Hebrew-calendar API — not a fixed
weekly rule — so it's correct for:

- **Every Shabbos** (every Saturday)
- **Every Yom Tov** (Diaspora scheduling): Rosh Hashana I–II, Yom Kippur,
  Sukkot I–II, Shmini Atzeret, Simchat Torah, Pesach I–II & VII–VIII,
  Shavuot I–II. Chol HaMoed, Rosh Chodesh, Chanukah, Purim, and fast days
  are correctly **excluded** (melacha is permitted on those).

**ON** happens at a fixed local clock time (`SHABBAT_ON_TIME`, default
`12:00` noon) on the Erev day before each span. **OFF** happens at real
**sunset + `SHABBAT_HAVDALAH_MINUTES`** (default 60) on the day the span
ends — computed from actual astronomical sunset for your location, not a
clock-time guess, so it's correct year-round as sunset drifts.

When spans run back-to-back on the calendar — a 2-day Yom Tov running
directly into Shabbos, or Yom Tov falling out on Shabbos itself — they
**merge into one continuous span automatically**. This isn't special-cased:
the engine just looks at which calendar dates are restricted (every
Saturday, union every Yom Tov date) and groups consecutive dates together,
so a 3-day yontif naturally stays on the whole time with no gap.

The scheduled job (`scripts/tick.js`) runs on a cron covering every day of
the week (Yom Tov isn't only Fri/Sat), fetches the current schedule, and
converges the fridge to whichever state (ON/OFF) the current moment should
be in. It's stateless: before flipping, it **reads the fridge's current
Sabbath state** and no-ops if it's already correct — so a missed run, a
manual flip, or the job simply running again later is always self-healing.

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

### Step 3 — add the secrets to this repo

GitHub repo → **Settings → Secrets and variables → Actions → New repository
secret**. Add whichever block step 1 or 2 printed (only ONE channel's worth
is needed — official takes priority if both happen to be set), **plus your
location**:

| Secret | Required? | Meaning |
|---|---|---|
| `SHABBAT_ZIP` | **Yes** (or use lat/long below) | US zip code — used for real sunset times |
| `SHABBAT_LATITUDE` + `SHABBAT_LONGITUDE` | Alternative to zip | Decimal coordinates, for non-US locations |
| `SHABBAT_TZID` | No — default `America/New_York` | IANA timezone name |
| `SHABBAT_ON_TIME` | No — default `12:00` | Local clock time to turn ON each Erev day |
| `SHABBAT_HAVDALAH_MINUTES` | No — default `60` | Minutes after sunset to turn OFF |
| `SHABBAT_ENABLED` | No — default `true` | Master kill switch for the whole automation |

### Step 4 — sanity-check the schedule

```bash
SHABBAT_ZIP=33016 npm run preview
```

Prints the next several months of computed ON/OFF times in plain English —
check a few against a Jewish calendar before trusting it live. (Once the
zip secret is saved to GitHub, the scheduled job reads it the same way;
this is just a local check.)

### Step 5 — enable Actions and test it

Actions are enabled by default on a new repo. Go to the **Actions** tab →
**Shabbat mode tick** → **Run workflow**, and pick `force: on` or
`force: off` to test a flip immediately without waiting for Shabbos. Check
the run's log — it prints exactly what channel it used and what it did.

After that, it just runs itself.

## The controller

A simple interactive menu for checking on things without digging through
GitHub's UI:

```bash
npm run control
```

`[1]` current fridge state + what the schedule says right now, `[2]` the
upcoming schedule, `[3]`/`[4]` force a flip. Reads the same secrets as the
scheduled job — set them as local environment variables first (see below).

## Manual local testing

```bash
npm run manual:on
npm run manual:off
npm run preview
npm run control
```

These read the same secrets as the scheduled job — export them as
environment variables locally, or use a `.env`-style loader of your choice
(a plain `.env` file is gitignored if you want one; this repo doesn't ship
a dotenv loader to stay dependency-free, so `export $(cat .env | xargs)` or
similar works fine for a quick local test).

## The schedule (`.github/workflows/shabbat-tick.yml`)

Since Yom Tov can fall on any day of the week (not just Friday/Saturday),
the job runs **every day**, in two narrow daily windows rather than around
the clock: a midday window (covers the fixed noon ON time under both DST
states) and an evening window (covers sunset+60 under both DST states,
padded for the earliest-December to latest-June range at ~26°N). That
keeps it at roughly 1200 runs/month — comfortably inside GitHub's 2000
free Actions minutes/month even on a private repo.

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
- Your zip code / coordinates are sent to Hebcal's public API on every run
  (needed to compute real sunset times) — no account, no auth, nothing else
  identifying is sent.

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
  history; the log always states the channel it detected, whether it
  computed itself to be inside a span, and what it did (or didn't).
- **Dates look wrong** — run `npm run preview` and compare against a Jewish
  calendar. If Hebcal's dates themselves look wrong, double check
  `SHABBAT_ZIP`/coordinates and that Diaspora (not Israel) scheduling is
  intended — this tool assumes Diaspora by default.

## Credits

The app-channel client is ported from
[ollo69/ha-smartthinq-sensors](https://github.com/ollo69/ha-smartthinq-sensors)
(`wideq/core_async.py`) and
[nVuln/homebridge-lg-thinq](https://github.com/nVuln/homebridge-lg-thinq) —
the most battle-tested open reverse-engineering of LG's private API. Every
constant in `src/thinqV2.js` (app keys, signature secret, header set) is
public, shipped inside LG's own Android app, and not a secret.

The Hebrew calendar and sunset-based times come from
[Hebcal](https://www.hebcal.com)'s public REST API.
