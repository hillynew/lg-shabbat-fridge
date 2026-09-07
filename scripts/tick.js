#!/usr/bin/env node
// The scheduled entry point — run every 15 min by the GitHub Actions
// workflow. Stateless by design: instead of persisting "did we already
// flip this week" across ephemeral runners, it reads the fridge's CURRENT
// Sabbath state before acting and no-ops if it's already where it should
// be. That also makes a manual flip (or a missed run) self-healing.

import { nowETClock } from '../src/time.js';
import { sabbathControlPath, setSabbathAuto, getCurrentSabbathState } from '../src/control.js';

function envFlag(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v === '1' || /^true$/i.test(v);
}

function envTime(name, def) {
  const v = process.env[name];
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? v : def;
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

  const onTime = envTime('SHABBAT_ON_TIME', '12:00');
  const offTime = envTime('SHABBAT_OFF_TIME', '22:00');
  const offEnabled = envFlag('SHABBAT_OFF_ENABLED', true);
  // Manual override from workflow_dispatch (see .github/workflows/shabbat-tick.yml).
  const force = (process.env.FORCE || '').toLowerCase();

  const { weekday, time } = nowETClock();
  console.log(`Now: ${weekday} ${time} ET · channel=${path} · on@${onTime} Fri · off@${offEnabled ? offTime : 'disabled'} Sat`);

  if (force === 'on' || (weekday === 'Fri' && time >= onTime)) {
    await flipIfNeeded(true);
  } else if (force === 'off' || (offEnabled && weekday === 'Sat' && time >= offTime)) {
    await flipIfNeeded(false);
  } else {
    console.log('Nothing to do this tick.');
  }
}

main().catch((e) => {
  console.error('Shabbat tick failed:', e.message);
  process.exitCode = 1;
});
