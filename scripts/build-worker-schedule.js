import { createHash } from 'node:crypto';
// Writes location-specific derived times locally, never deploys or uploads.
import { writeFile } from 'node:fs/promises';
import { hebcalConfigFromEnv } from '../src/hebcal.js';
import { buildSchedule } from '../worker/calendar.js';
import { requestJson } from '../worker/http.js';
const cfg = hebcalConfigFromEnv();
if (!process.env.SHABBAT_TZID) throw new Error('Set the confirmed SHABBAT_TZID explicitly');
if (!cfg.zip && !(cfg.latitude && cfg.longitude)) throw new Error('Set the actual fridge location');
if (cfg.onTime !== '12:00' || cfg.havdalahMinutes !== 60) throw new Error('This migration preserves noon ON and sunset+60 OFF; review code before changing');
const now = new Date();
const validFrom = now.getTime();
const validUntil = validFrom + 366 * 86400000;
const start = `${now.getUTCFullYear() - 1}-01-01`;
const end = `${new Date(validUntil).getUTCFullYear() + 1}-12-31`;
const url = new URL('https://www.hebcal.com/hebcal');
for (const [key, value] of Object.entries({ v: 1, cfg: 'json', maj: 'on', min: 'off', mod: 'off', nx: 'off', ss: 'off', mf: 'off', c: 'on', i: 'off', m: 60, start, end })) url.searchParams.set(key, value);
if (cfg.zip) { url.searchParams.set('geo', 'zip'); url.searchParams.set('zip', cfg.zip); }
else { for (const [key, value] of Object.entries({ geo: 'pos', latitude: cfg.latitude, longitude: cfg.longitude, tzid: cfg.tzid })) url.searchParams.set(key, value); }
const data = await requestJson(url.toString());
if (data.location?.tzid !== cfg.tzid) throw new Error('Hebcal location timezone does not match confirmed timezone');
const schedule = buildSchedule({ items: data.items, cfg, start, end, validFrom, validUntil });
const output = JSON.stringify(schedule);
if (Buffer.byteLength(output) > 5000) throw new Error('Schedule exceeds conservative binding size limit');
const path = process.argv[2] || 'worker-schedule.local.json';
await writeFile(path, output, { mode: 0o600 });
console.log(`Created ${path}: ${schedule.spans.length} spans, ${Buffer.byteLength(output)} bytes, expires ${new Date(validUntil).toISOString()}. Review dates before installing.`);

console.log(`SHABBAT_SCHEDULE_SHA256=${createHash('sha256').update(output).digest('hex')}`);
