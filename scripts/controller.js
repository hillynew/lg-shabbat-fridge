#!/usr/bin/env node
// A simple interactive controller — one place to check on the fridge,
// preview the upcoming schedule, or force a flip, without digging through
// GitHub's Actions UI. Reads the same secrets/env as the scheduled tick.
//
// Usage: node scripts/controller.js
//   (or: npm run control)

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { sabbathControlPath, setSabbathAuto, getCurrentSabbathState } from '../src/control.js';
import { upcomingSpans } from '../src/hebcal.js';

async function prompt(q) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const a = await rl.question(q);
  rl.close();
  return a.trim();
}

function fmt(instant, tzid) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tzid, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(instant);
}

async function showStatus() {
  const path = sabbathControlPath();
  if (!path) {
    console.log('\nNot configured yet — run `npm run setup:official` or `npm run setup:v2` first.\n');
    return;
  }
  console.log(`\nChannel: ${path}`);
  try {
    const state = await getCurrentSabbathState();
    console.log(`Sabbath mode is currently: ${state == null ? 'unknown' : String(state).toUpperCase()}`);
  } catch (e) {
    console.log(`Could not read current state: ${e.message}`);
  }

  try {
    const { spans, cfg } = await upcomingSpans({ daysForward: 21 });
    const now = new Date();
    const current = spans.find((s) => now >= s.on && now < s.off);
    const next = spans.find((s) => s.on > now);
    if (current) {
      console.log(`Should be ON right now — inside a span through ${fmt(current.off, cfg.tzid)}.`);
    } else if (next) {
      console.log(`Next span: ON ${fmt(next.on, cfg.tzid)} → OFF ${fmt(next.off, cfg.tzid)}.`);
    } else {
      console.log('No upcoming span found in the next 21 days (check SHABBAT_ZIP is set).');
    }
  } catch (e) {
    console.log(`Could not compute schedule: ${e.message}`);
  }
  console.log('');
}

async function showPreview() {
  const { spans, cfg } = await upcomingSpans({ daysForward: 90 });
  const now = new Date();
  console.log('');
  for (const s of spans) {
    if (s.off < now) continue; // skip past spans in this compact view
    const active = now >= s.on && now < s.off ? '  ← ACTIVE NOW' : '';
    const label = s.days.length > 1 ? `${s.days.length}-day span (${s.days.join(', ')})` : s.days[0];
    console.log(`${label}${active}`);
    console.log(`  ON:  ${fmt(s.on, cfg.tzid)}`);
    console.log(`  OFF: ${fmt(s.off, cfg.tzid)}\n`);
  }
}

async function forceFlip(on) {
  try {
    const r = await setSabbathAuto(on);
    console.log(`\nSabbath mode ${on ? 'ON' : 'OFF'} via ${r.path} channel.\n`);
  } catch (e) {
    console.log(`\nFailed: ${e.message}\n`);
  }
}

async function main() {
  console.log('LG Shabbat Fridge — controller');
  console.log('-------------------------------');
  for (;;) {
    console.log('[1] Status   [2] Preview schedule   [3] Force ON   [4] Force OFF   [q] Quit');
    const choice = await prompt('> ');
    if (choice === '1') await showStatus();
    else if (choice === '2') await showPreview();
    else if (choice === '3') await forceFlip(true);
    else if (choice === '4') await forceFlip(false);
    else if (choice.toLowerCase() === 'q') break;
    else console.log('Not a valid option.\n');
  }
}

main().catch((e) => {
  console.error('Controller failed:', e.message);
  process.exitCode = 1;
});
