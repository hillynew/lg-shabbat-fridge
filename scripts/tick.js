#!/usr/bin/env node
// The scheduled entry point — run on a schedule by the GitHub Actions
// workflow, covering every day of the week (Yom Tov can fall on any
// weekday, not just Friday/Saturday). Computes the real Hebrew-calendar
// Shabbos/Yom Tov spans for the configured location (src/hebcal.js), and
// converges the fridge to whichever state (ON/OFF) the current moment
// should be in. Stateless by design: it reads the fridge's CURRENT Sabbath
// state before acting and no-ops if it's already correct, so a missed run
// or the job simply running again later is always self-healing.

import { sabbathControlPath, setSabbathAuto, getCurrentSabbathState } from '../src/control.js';
import { upcomingSpans } from '../src/hebcal.js';

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

  const now = new Date();
  const { spans } = await upcomingSpans();
  const current = spans.find((s) => now >= s.on && now < s.off);

  console.log(`Now: ${now.toISOString()} · channel=${path} · ${spans.length} upcoming span(s) computed`);
  if (current) {
    console.log(`Currently inside a Shabbos/Yom Tov span: ${current.days.join(', ')} (ON ${current.on.toISOString()} → OFF ${current.off.toISOString()})`);
  }

  await flipIfNeeded(!!current);
}

main().catch((e) => {
  console.error('Shabbat tick failed:', e.message);
  process.exitCode = 1;
});
