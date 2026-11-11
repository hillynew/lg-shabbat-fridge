# Direct Cloudflare Workers Free migration (shadow first)

This branch adds a separate, one-shot Worker. It does **not** replace or disable
`.github/workflows/shabbat-tick.yml`. It makes no GitHub API calls and has no
public control endpoint. Nothing deploys automatically. Existing scripts are unchanged.

## Cost and reliability limits

Use an account on **Workers Free only**, not Workers Paid. Wrangler configuration
cannot enforce the account's billing plan: verify it in the dashboard before any
deploy. Never upgrade the plan to make a failing test pass. The configuration
creates no KV, D1, R2, queues, Durable Objects, paid domains or other resources.
One `*/3 * * * *` Cron is 480 invocations/day, below Free's 100,000 daily requests
and 5 Cron triggers. Account-wide usage also counts. Each run makes about 3 LG
requests when unchanged (gateway, refresh, dashboard), more for write/readback;
LG may impose undocumented rate limits. Tokens are reused within a run, not stored.
Workers Free's **10 ms CPU limit per invocation** is a real activation gate.
Network waiting is not CPU, but crypto, parsing and headers are. Local timing
is not production CPU evidence. Free quotas fail rather than promise availability;
Cron scheduling has no exact-time guarantee or SLA. This is not a safety-certified
appliance controller and does not guarantee religious observance.

References: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
[fetch ports](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#allow-custom-ports).
The compatibility date enables custom HTTPS ports such as LG's 46030. Actual LG
acceptance from the deployed Cloudflare network must still be tested read-only.

## Local checks

Node 24 is used in test CI (existing controller supports Node 20+).

```sh
npm ci
npm test
npm run worker:dry-run
node scripts/benchmark-worker.js
```

The benchmark uses fake credentials and fixtures only. It runs the actual bundle's
held scheduled handler under local workerd, then reports a Node CPU estimate for
shadow ticks including HMAC. It does not deploy, contact LG, or prove the 10 ms limit.
If the machine's default npm/Wrangler configuration directory is unwritable, choose
a writable cache with `npm --cache /tmp/npm-cache ...` and set
`XDG_CONFIG_HOME=/tmp/wrangler-config` for local Wrangler commands.

## Generate a reviewed schedule (at least annually)

The Worker imports no calendar library and performs no Intl/calendar computations.
The build-time generator fetches complete Gregorian years from Hebcal with explicit
Diaspora mode. It checks 13 distinct full Yom Tov dates per year, synthesizes every
Saturday from civil dates, merges contiguous dates, and requires Havdalah for every
relevant span. Incomplete success responses fail rather than silently dropping spans.
Sunset endpoints require timezone-aware timestamps; the Hebcal location timezone
must equal the explicitly confirmed timezone. No guessed user location is included.

Set the **actual confirmed** `SHABBAT_TZID` plus `SHABBAT_ZIP` or
`SHABBAT_LATITUDE`/`SHABBAT_LONGITUDE` in your local environment, then:

```sh
npm run worker:schedule
```

This writes the ignored, private `worker-schedule.local.json`, valid for 366 days,
and prints its SHA-256 digest. Defaults are noon on the preceding day, sunset+60 off.
The migration refuses other timings until explicitly reviewed. Review important
Shabbos/Yom Tov boundaries and the location against a trusted local calendar before
installation. This validator is not an independent astronomical/Hebrew-calendar
implementation and cannot detect all incorrect upstream data. The annual count is
appropriate for current-era Diaspora calendars; an unexpected count blocks generation.
A test New York fixture produced 54 spans and about 2.4 KB, below the conservative
5,000-byte per-binding limit. The real location needs its own generation and review.

Install the exact file bytes as secret `SHABBAT_SCHEDULE_JSON`, and the printed
checksum as `SHABBAT_SCHEDULE_SHA256`, in the same deployment. Do not copy a newline
into the JSON binding. The checksum detects accidental truncation/editing, including
a removed holiday span; it is not a signature against a malicious administrator.
Never commit a real location-specific schedule or credentials. Use the provider's
secure secret entry flow; do not paste tokens into shell arguments, logs or chat.

**Renew manually 45 days before expiry**, using this generator and the original
confirmed location, review again, replace JSON and digest together, and test a held
invocation. Do not rely on GitHub's scheduler for renewal. A warning event begins
45 days before expiry; after expiry every tick fails and makes **no change**, even
if Sabbath mode remains ON. Logs are not user notifications: before live activation,
set an independent renewal reminder and verify an independent missing-run/failure
alert reaches the owner. This repository does not create an alert account or promise
monitoring. There is no telemetry/heartbeat URL that transmits household data.

## Install held, then shadow

1. Verify Free plan and available quota; leave existing automation untouched.
2. Build and deploy only when authorized. The checked-in flags are
   `SHABBAT_WORKER_WRITES=false`, `SHABBAT_WRITER=github`, `SHABBAT_HOLD=true`.
   Install the reviewed schedule + checksum. A held tick validates the schedule but
   needs no LG credentials and makes no network request. Missing schedule is an
   explicit failed invocation, not a misleading successful tick.
3. Through secure secret storage install the existing six `THINQ_V2_*` configuration
   values used by the current app-channel controller: `REFRESH_TOKEN`, `OAUTH_URL`,
   `USER_NUMBER`, `CLIENT_ID`, `DEVICE_ID`, `SABBATH_CTRL`. This adapter intentionally
   uses only the already working app channel, not automatic official-API fallback.
4. Set `SHABBAT_HOLD=false`, retaining `SHABBAT_WORKER_WRITES=false` and writer `github`.
   Confirm LG gateway custom-port connectivity, authentication, model enums, and
   dashboard schema without issuing any appliance command.
5. **Activation blocked until real schema validation:** the adapter requires
   `device.online === true` and `device.snapshot.timestamp` as epoch milliseconds
   or a parseable date string. Confirm these fields exist and describe a device
   observation (not just a server cache time), with documented clock accuracy.
   Other formats/missing fields deliberately fail closed. Do not relax freshness
   to make it work. Add a redacted fixture and adapter tests if normalization is needed.
6. Watch actual production CPU, errors and cadence for a representative period,
   including cold starts, full dashboard payload, retries and readback path. Successful
   build/local tests do not satisfy this gate. Confirm CPU stays safely below Free's
   10 ms; otherwise stop and redesign rather than upgrade.

Logs contain event, timestamp, duration, status, booleans or fixed safe error codes,
not response bodies, credentials, device IDs or location. A failed invocation throws
and is visible in Cron/Worker logs. Dashboard snapshots are not physical confirmation.
Readback requires a timestamp at least as new as the initial snapshot **and command
start**; inspect the actual fridge for the first authorized transition.

## One-writer cutover (separate authorized step)

Only proceed after all gates above, independent alerts, renewal reminder and explicit
approval for live appliance changes. Choose a safe ordinary-day window.

1. Deploy `SHABBAT_HOLD=true` and wait at least 3 minutes for old invocations to drain.
2. Disable the GitHub workflow's scheduled automation and any other relay/controller.
   Cancel/drain **all running and queued** tick jobs, including their 55-minute loops.
   Simply changing a repository flag does not stop an already-running job.
3. Check actual fridge state. Change writer to `cloudflare` and writes to `true`,
   leaving hold true. Deploy, verify flags, then release hold in another deployment.
4. Observe the next ticks and the first explicitly authorized write/readback.

Flags establish ownership by operator procedure, not a distributed lock. Cloudflare
can overlap/retry invocations. Commands assign explicit ON/OFF values, not toggles;
same-state duplicate commands are idempotent, but execution is not serialized.
The schedule is rechecked immediately before a write, and writes within 30 seconds
before any boundary are deferred. LG can still apply an in-flight command late.
No exactly-once or transactional guarantee is claimed. Requests abort after 8 seconds;
uncertain writes are never repeated, only read back up to three times. One retry with
a rotated client ID is allowed only for LG's explicit rejection codes 9006/9012.
The next Cron reconciles failures rather than looping for an hour.

For a manual override: deploy hold true, wait 3 minutes and ensure all old writers
are stopped **before** manually changing the fridge. Hold has no automatic expiry;
explicitly release it when automation should resume. An LG-app manual change without
hold may be undone at the next tick. A binding change is not instantaneous cancellation.

Rollback: hold/disable Worker and drain it first, then re-enable exactly one previous
controller. The old GitHub implementation retains its existing missing-calendar and
readback weaknesses; rollback is not a promise of equivalent safety.

## Current validation boundary

No live account credentials, deployment, paid resources, appliance changes or GitHub
main-branch scheduling changes are part of this artifact. Production network/CPU,
actual LG timestamp semantics, owner alerts, real schedule and authorized live
readback remain prerequisites. See the PR test results for exact-head local/CI checks.
