#!/usr/bin/env node
// Prints the upcoming computed Shabbos/Yom Tov schedule in plain English —
// run this to sanity-check the dates and times against a calendar before
// trusting the automation. Reads the same SHABBAT_ZIP (or
// SHABBAT_LATITUDE/LONGITUDE) config as the scheduled tick.
//
// Usage: node scripts/preview.js [--days N]
//   (or: npm run preview)

import { upcomingSpans } from '../src/hebcal.js';

function fmt(instant, tzid) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tzid, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(instant);
}

async function main() {
  const daysArgIdx = process.argv.indexOf('--days');
  const daysForward = daysArgIdx !== -1 ? Number(process.argv[daysArgIdx + 1]) : 120;

  const { spans, location, cfg } = await upcomingSpans({ daysForward });
  if (location) {
    console.log(`Location: ${location.title || location.city} (${location.latitude}, ${location.longitude})`);
  }
  console.log(`ON time: ${cfg.onTime} local · OFF: ${cfg.havdalahMinutes} min after sunset\n`);

  const now = new Date();
  if (!spans.length) {
    console.log('No spans found in this window — check SHABBAT_ZIP / SHABBAT_LATITUDE+LONGITUDE are set.');
    return;
  }

  for (const s of spans) {
    const status = now >= s.on && now < s.off ? '  ← ACTIVE NOW' : (s.off < now ? ' (past)' : '');
    const label = s.days.length > 1 ? `${s.days.length}-day span (${s.days.join(', ')})` : s.days[0];
    console.log(`${label}${status}`);
    console.log(`  ON:  ${fmt(s.on, cfg.tzid)}`);
    console.log(`  OFF: ${fmt(s.off, cfg.tzid)}`);
    console.log('');
  }
}

main().catch((e) => {
  console.error('Preview failed:', e.message);
  process.exitCode = 1;
});
