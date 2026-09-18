#!/usr/bin/env node
// The scheduled entry point — run once an hour by the GitHub Actions
// workflow (offset away from :00 — the top of every hour is when GitHub's
// scheduler is most congested and most likely to delay/drop a run), then
// polls internally for the rest of the hour so the actual ON/OFF moment
// still gets caught within a few minutes without needing high-frequency
// external triggering.
//
// Earlier versions of this tool tried to get precise timing by having an
// external service (cron-job.org, then a Cloudflare Worker relay) call
// GitHub's workflow_dispatch API every few minutes. Both consistently got
// 404s from GitHub that were never explained — the exact same request
// succeeded reliably via a plain server-side curl, so it wasn't a
// credentials or URL problem; the leading theory is that GitHub
// deprioritizes/blocks traffic whose origin self-identifies as an edge/
// serverless network (cron-job.org's declared bot User-Agent, then
// Cloudflare Workers' automatic Cf-Worker/Cdn-Loop fingerprint headers).
// This version sidesteps that whole class of problem: nothing outside
// GitHub Actions' own infrastructure ever talks to GitHub's API.
//
// Computes the real Hebrew-calendar Shabbos/Yom Tov spans for the
// configured location (src/hebcal.js) ONCE per hourly run, then checks the
// current moment against those spans every few minutes for the rest of the
// run. Stateless by design: it reads the fridge's CURRENT Sabbath state
// before acting and no-ops if it's already correct, so a missed run, a
// manual flip, or the job simply running again later is always
// self-healing.

import { sabbathControlPath, setSabbathAuto, getCurrentSabbathState } from '../src/control.js';
import { upcomingSpans } from '../src/hebcal.js';

const POLL_INTERVAL_MS = 3 * 60 * 1000; // check every 3 minutes
const RUN_BUDGET_MS = 55 * 60 * 1000; // stop with headroom before the next hourly run

function envFlag(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v === '1' || /^true$/i.test(v);
}

function normalize(value) {
  if (value == null) return null;
  if (typeof value === 'boolean') return value ? 'ON' : 'OFF';
  return String(value).toUpperCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function flipIfNeeded(on) {
  let current = null;
  try {
    current = normalize(await getCurrentSabbathState());
  } catch (e) {
    console.log(`Could not read current state (${e.message}) — attempting the flip anyway.`);
  }
  if (current === (on ? 'ON' : 'OFF')) {
    console.log(`Sabbath mode already ${on ? 'ON' : 'OFF'} — no-op.`);
    return;
  }
  const r = await setSabbathAuto(on);
  console.log(`Sabbath mode ${on ? 'ON' : 'OFF'} via ${r.path} channel (device ${r.device_id}).`);
}

async function main() {
  if (!envFlag('SHABBAT_ENABLED', true)) {
    console.log('SHABBAT_ENABLED=false — nothing to do.');
    return;
  }

  const path = sabbathControlPath();
  if (!path) {
    console.log('No controllable Sabbath channel configured yet — run `npm run setup:official` or `npm run setup:v2` and add the printed secrets. See README.');
    return;
  }

  // Manual override from workflow_dispatch (see .github/workflows/shabbat-tick.yml).
  const force = (process.env.FORCE || '').toLowerCase();
  if (force === 'on' || force === 'off') {
    console.log(`Forced ${force.toUpperCase()} via workflow_dispatch.`);
    await flipIfNeeded(force === 'on');
    return;
  }

  const { spans } = await upcomingSpans();
  console.log(`channel=${path} · ${spans.length} upcoming span(s) computed for this run`);

  const startedAt = Date.now();
  let iteration = 0;
  for (;;) {
    iteration += 1;
    const now = new Date();
    const current = spans.find((s) => now >= s.on && now < s.off);
    console.log(
      `[check ${iteration}] ${now.toISOString()}${current ? ` · inside span through ${current.off.toISOString()}` : ' · no active span'}`,
    );
    await flipIfNeeded(!!current);

    if (Date.now() - startedAt + POLL_INTERVAL_MS >= RUN_BUDGET_MS) break;
    await sleep(POLL_INTERVAL_MS);
  }
  console.log('Run budget reached — exiting; next hourly run picks up from here.');
}

main().catch((e) => {
  console.error('Shabbat tick failed:', e.message);
  process.exitCode = 1;
});
