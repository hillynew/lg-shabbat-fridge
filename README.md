# lg-shabbat-fridge

Turns an LG WiFi refrigerator's **Sabbath mode** on for every **Shabbos and
Yom Tov** — automatically, for free, with no server to run or pay for. The
code runs entirely on [GitHub Actions](https://github.com/features/actions)
in this repo, triggered by a free external cron ping (see "Reliable
triggering" below — GitHub's own scheduler isn't precise enough for this);
there's nothing to host yourself either way.

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

### Step 5 — test a manual run

Actions are enabled by default on a new repo. Go to the **Actions** tab →
**Shabbat mode tick** → **Run workflow**, and pick `force: on` or
`force: off` to test a flip immediately without waiting for Shabbos. Check
the run's log — it prints exactly what channel it used and what it did.

### Step 6 — set up reliable triggering (required)

**GitHub's own `schedule:` cron trigger is not used** — it's documented to
be delayed or dropped under load, and in practice on a low-traffic repo a
`*/15` schedule fires only a small, irregular fraction of its configured
times (confirmed live: gaps of hours between runs, landing outside the
intended windows entirely). That's not acceptable for a precise-time
religious-observance trigger, so this repo relies on an external, free,
purpose-built cron service instead to call the workflow on schedule — the
code still runs entirely on GitHub Actions, the external service just
triggers it reliably.

**Known issue: cron-job.org calling GitHub directly gets a 404.** Confirmed
live — the URL, headers, token, and body were all byte-verified correct
(the exact same request via plain `curl` succeeds with 204), yet cron-job.org's
own calls to `api.github.com` consistently 404, on both manual test runs and
real scheduled executions. Every likely self-inflicted cause was ruled out.
That leaves GitHub/Fastly quietly blocking cron-job.org's shared IP pool or
its self-identifying `User-Agent: ...cron-job.org...` — a known pattern where
GitHub serves a misleading 404 instead of an honest 403 for this kind of
block, so as not to confirm what it's blocking. **Fix: don't call GitHub
directly from cron-job.org — relay through a small Cloudflare Worker
(free, no server to maintain) that makes the real call server-side,** which
looks like an ordinary SaaS-to-GitHub integration instead of a cron pinger.

1. **Create a scoped GitHub token** — go to
   [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
   (fine-grained token):
   - Resource owner: your account
   - Repository access: **Only select repositories** → this repo
   - Permissions → Repository permissions → **Actions: Read and write**
   - Set an expiration (fine-grained tokens require one — a year is fine,
     just re-generate and update the Worker secret when it expires)
   - Generate, and copy the token (starts `github_pat_…`) — you won't see
     it again

2. **Deploy the relay Worker** (free Cloudflare account, dashboard only —
   no CLI, no `wrangler` install):
   - Sign up free at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)
   - Left sidebar → **Workers & Pages** → **Create** → **Create Worker** →
     give it any name (e.g. `lg-shabbat-relay`) → **Deploy** (deploys the
     default "Hello World" template — you'll replace it next)
   - Click **Edit code** → delete everything in the editor → paste in the
     full contents of [`cloudflare-worker/relay.js`](cloudflare-worker/relay.js)
     from this repo → **Deploy**
   - Back on the Worker's page → **Settings → Variables and Secrets** →
     **Add** two secrets (toggle "Encrypt" on for both):
     - `GITHUB_PAT` = the token from step 1
     - `RELAY_SECRET` = any random string you make up (this replaces the
       GitHub token as the thing cron-job.org authenticates with — pick
       something like a 20+ character password, it never needs to be typed
       by hand)
   - Copy the Worker's URL from the top of its page — looks like
     `https://lg-shabbat-relay.<your-subdomain>.workers.dev`

3. **Sign up free** at [cron-job.org](https://cron-job.org) (or any similar
   free HTTP-ping cron service).

4. **Create a cron job** that POSTs to your Worker (not GitHub) on this
   schedule:
   - **URL:** `https://lg-shabbat-relay.<your-subdomain>.workers.dev`
   - **Method:** `POST`
   - **Headers:**
     - `X-Relay-Secret: <the RELAY_SECRET you made up in step 2>`
   - **Schedule:** every 15 minutes, during:
     - Midday: `15:00`–`18:59` UTC (covers noon ET under both EDT/EST)
     - Evening: `21:00`–`02:59` UTC, crossing midnight (covers sunset+60 ET
       under both DST states across the year at ~26°N)

A successful ping returns HTTP 200 with a body like `GitHub responded 204
(no body — this is the expected success response)`. A wrong or missing
`X-Relay-Secret` gets a 404 (indistinguishable from a route that doesn't
exist, on purpose). If you ever want to sanity-check it's firing, watch the
**Actions** tab on this repo — a run should appear within a minute or two of
each scheduled ping, tagged "workflow_dispatch".

To force an immediate flip through the Worker without waiting for the
schedule (handy for testing from anywhere, e.g. a phone browser), add
`?force=on` or `?force=off` to the Worker URL and hit it with the same
`X-Relay-Secret` header.

After that, it just runs itself. (If you'd rather skip the Worker and try
cron-job.org → GitHub directly first, the old direct setup is still valid
config-wise — it's specifically cron-job.org's requests that GitHub seems to
reject, so it may work fine from a different pinger's IP range. The Worker
is the version confirmed to sidestep the problem.)

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
the external pinger (Step 6 above) fires **every day**, in two narrow daily
windows rather than around the clock: a midday window (covers the fixed
noon ON time under both DST states) and an evening window (covers
sunset+60 under both DST states, padded for the earliest-December to
latest-June range at ~26°N). That keeps it at roughly 1200 runs/month —
comfortably inside GitHub's 2000 free Actions minutes/month even on a
private repo.

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
