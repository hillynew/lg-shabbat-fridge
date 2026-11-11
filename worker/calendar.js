// Build-time only. The Worker never imports Intl calendar calculations.
import { zonedWallTimeToInstant } from '../src/hebcal.js';
const DAY = 86400000;
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
export const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
function localDate(instant, tzid) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tzid, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function buildSchedule({ items, cfg, start, end, validFrom, validUntil, generatedAt = Date.now(), requireAnnual = true }) {
  if (!Array.isArray(items) || !items.length || !dateOnly.test(start) || !dateOnly.test(end)
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.onTime) || cfg.havdalahMinutes !== 60) throw new Error('calendar_invalid');
  const restricted = new Set();
  const holidays = new Set();
  const havdalah = new Map();
  for (const item of items) {
    if (item.category === 'holiday' && item.yomtov === true) {
      if (!dateOnly.test(item.date) || item.date < start || item.date > end || holidays.has(item.date)) throw new Error('calendar_invalid');
      holidays.add(item.date); restricted.add(item.date);
    }
    if (item.category === 'havdalah') {
      if (!/T\d\d:\d\d.*(?:Z|[+-]\d\d:\d\d)$/.test(item.date)) throw new Error('calendar_invalid');
      const time = Date.parse(item.date);
      if (!Number.isFinite(time)) throw new Error('calendar_invalid');
      const date = localDate(time, cfg.tzid);
      if (havdalah.has(date)) throw new Error('calendar_invalid');
      // A sunset+60 endpoint must be after local noon and before next local noon.
      const noon = +zonedWallTimeToInstant(date, '12:00', cfg.tzid);
      if (time <= noon || time >= +zonedWallTimeToInstant(addDays(date, 1), '12:00', cfg.tzid)) throw new Error('calendar_invalid');
      havdalah.set(date, time);
    }
  }
  if (requireAnnual) {
    if (!start.endsWith('-01-01') || !end.endsWith('-12-31')) throw new Error('calendar_invalid');
    // Diaspora has 13 full Yom Tov dates per Gregorian year, spread across spring/fall.
    // Refuse suspicious successful-but-incomplete responses instead of silently dropping Yom Tov.
    for (let year = +start.slice(0, 4); year <= +end.slice(0, 4); year++) {
      if ([...holidays].filter(d => d.startsWith(String(year))).length !== 13) throw new Error('calendar_incomplete_holidays');
    }
  }
  for (let date = start; date <= end; date = addDays(date, 1)) {
    // Weekday belongs to the civil date, independent of location/UTC offset.
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === 6) restricted.add(date);
  }
  const dates = [...restricted].sort();
  const groups = [];
  for (const date of dates) {
    const last = groups.at(-1);
    if (last && addDays(last.at(-1), 1) === date) last.push(date);
    else groups.push([date]);
  }
  const spans = [];
  for (const days of groups) {
    const on = +zonedWallTimeToInstant(addDays(days[0], -1), cfg.onTime, cfg.tzid);
    const off = havdalah.get(days.at(-1));
    // Window-edge runs are excluded only if they cannot intersect usable coverage.
    if (on >= validUntil || (+new Date(`${addDays(days.at(-1), 2)}T00:00:00Z`)) <= validFrom) continue;
    if (!off || !Number.isFinite(on) || off <= on) throw new Error('calendar_missing_havdalah');
    spans.push({ on, off });
  }
  if (validFrom < Date.parse(`${addDays(start, 7)}T00:00:00Z`)
      || validUntil > Date.parse(`${addDays(end, -7)}T00:00:00Z`)) throw new Error('calendar_coverage_unpadded');
  return { version: 1, generatedAt, validFrom, validUntil, tzid: cfg.tzid,
    onTime: cfg.onTime, havdalahMinutes: cfg.havdalahMinutes, diaspora: true, spans };
}
