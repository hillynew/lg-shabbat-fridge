// Real Hebrew-calendar scheduling: Sabbath mode should be ON for every
// Shabbos (every Saturday) and every Yom Tov (Rosh Hashana, Yom Kippur,
// Sukkot I-II, Shmini Atzeret, Simchat Torah, Pesach I-II & VII-VIII,
// Shavuot I-II — Diaspora scheduling, Chol HaMoed and minor holidays
// excluded), turning ON at noon on the Erev day and OFF at a fixed number
// of minutes after actual sunset on the day it ends. When spans run
// consecutive on the calendar (e.g. a 2-day Yom Tov running directly into
// Shabbos), they're merged into one continuous span automatically — no
// special-casing needed.
//
// Data source: Hebcal's public REST API (hebcal.com), which supplies both
// the real Hebrew calendar (which dates are Yom Tov, correctly handling
// leap years and Diaspora vs Israel scheduling) and real astronomical
// sunset-based times for a given location, with a `m=<minutes>` param that
// computes "N minutes after sundown" for EVERY Erev/Motzei — Shabbos and
// Yom Tov alike — so the same 60-minute rule applies uniformly by just
// asking Hebcal for it, rather than us re-deriving sunset ourselves.

const HEBCAL_BASE = 'https://www.hebcal.com/hebcal';

export function hebcalConfigFromEnv() {
  return {
    zip: process.env.SHABBAT_ZIP || null,
    latitude: process.env.SHABBAT_LATITUDE || null,
    longitude: process.env.SHABBAT_LONGITUDE || null,
    tzid: process.env.SHABBAT_TZID || 'America/New_York',
    onTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(process.env.SHABBAT_ON_TIME || '') ? process.env.SHABBAT_ON_TIME : '12:00',
    havdalahMinutes: Number.isFinite(Number(process.env.SHABBAT_HAVDALAH_MINUTES)) && process.env.SHABBAT_HAVDALAH_MINUTES
      ? Number(process.env.SHABBAT_HAVDALAH_MINUTES) : 60,
  };
}

function fmtDate(d) {
  // YYYY-MM-DD in UTC — used only for query range bounds, a day or two of
  // slop either way doesn't matter.
  return d.toISOString().slice(0, 10);
}

// Convert a "wall clock" date+time in a given IANA zone to an absolute
// instant, DST-correctly, using only Intl (no dependency).
export function zonedWallTimeToInstant(dateStr, hhmm, tzid) {
  const [Y, M, D] = dateStr.split('-').map(Number);
  const [h, m] = hhmm.split(':').map(Number);
  const guess = new Date(Date.UTC(Y, M - 1, D, h, m));
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(guess).map((p) => [p.type, p.value]));
  const hh = parts.hour === '24' ? 0 : Number(parts.hour);
  const asIfUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hh, Number(parts.minute), Number(parts.second));
  const offsetMs = asIfUTC - guess.getTime();
  return new Date(guess.getTime() - offsetMs);
}

// YYYY-MM-DD for an instant, as seen in a given IANA zone.
function localDateStr(instant, tzid) {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tzid, year: 'numeric', month: '2-digit', day: '2-digit' });
  return dtf.format(instant); // en-CA gives YYYY-MM-DD
}

function addDaysStr(dateStr, n) {
  const [Y, M, D] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(Y, M - 1, D));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(dateStr, tzid) {
  const [Y, M, D] = dateStr.split('-').map(Number);
  // Noon UTC guess is safely inside the calendar date in any real-world tz offset.
  const instant = new Date(Date.UTC(Y, M - 1, D, 12, 0, 0));
  return new Intl.DateTimeFormat('en-US', { timeZone: tzid, weekday: 'short' }).format(instant);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Hebcal request failed: HTTP ${res.status}`);
  return res.json();
}

// Fetch raw Hebcal items for the window [startStr, endStr] (YYYY-MM-DD).
export async function fetchHebcalItems(cfg, startStr, endStr) {
  const geo = cfg.zip
    ? `geo=zip&zip=${encodeURIComponent(cfg.zip)}`
    : (cfg.latitude && cfg.longitude)
      ? `geo=pos&latitude=${encodeURIComponent(cfg.latitude)}&longitude=${encodeURIComponent(cfg.longitude)}&tzid=${encodeURIComponent(cfg.tzid)}`
      : null;
  if (!geo) throw new Error('No location configured — set SHABBAT_ZIP (or SHABBAT_LATITUDE + SHABBAT_LONGITUDE)');
  const url = `${HEBCAL_BASE}?v=1&cfg=json&maj=on&min=off&mod=off&nx=off&ss=off&mf=off&c=off`
    + `&m=${encodeURIComponent(cfg.havdalahMinutes)}&start=${startStr}&end=${endStr}&${geo}`;
  const data = await fetchJson(url);
  return { items: data.items || [], location: data.location || null };
}

// Turn raw Hebcal items into a sorted list of { on, off, days } spans —
// `on`/`off` are absolute Date instants, `days` is the list of restricted
// calendar dates (YYYY-MM-DD, in cfg.tzid) that make up the span.
export function computeSpans(items, cfg, windowStartStr, windowEndStr) {
  const tzid = cfg.tzid;

  // Which calendar dates are Yom Tov, per Hebcal's own yomtov flag —
  // exactly Rosh Hashana I-II, Yom Kippur, Sukkot I-II, Shmini Atzeret,
  // Simchat Torah, Pesach I-II & VII-VIII, Shavuot I-II. Chol HaMoed,
  // Rosh Chodesh, Chanukah, Purim, and fasts are never flagged.
  const yomtovDates = new Set(
    items.filter((it) => it.category === 'holiday' && it.yomtov === true).map((it) => it.date)
  );

  // Havdalah (already computed by Hebcal at cfg.havdalahMinutes after real
  // sunset) keyed by the local calendar date it falls on — this is the
  // OFF instant for whichever restricted date it concludes.
  const havdalahByDate = new Map();
  for (const it of items) {
    if (it.category === 'havdalah') {
      const instant = new Date(it.date);
      havdalahByDate.set(localDateStr(instant, tzid), instant);
    }
  }

  // Restricted dates = every Saturday in the window, union every Yom Tov date.
  const restricted = new Set(yomtovDates);
  for (let d = windowStartStr; d <= windowEndStr; d = addDaysStr(d, 1)) {
    if (weekdayOf(d, tzid) === 'Sat') restricted.add(d);
  }

  const sortedDates = [...restricted].sort();
  const spans = [];
  let run = [];
  for (const d of sortedDates) {
    if (run.length && addDaysStr(run[run.length - 1], 1) !== d) {
      spans.push(run);
      run = [];
    }
    run.push(d);
  }
  if (run.length) spans.push(run);

  return spans.map((days) => {
    const erev = addDaysStr(days[0], -1);
    const endDate = days[days.length - 1];
    const onInstant = zonedWallTimeToInstant(erev, cfg.onTime, tzid);
    const offInstant = havdalahByDate.get(endDate) || null;
    return { on: onInstant, off: offInstant, days, erev, endDate };
  }).filter((s) => s.off); // drop anything we couldn't find a havdalah time for (shouldn't happen; safety net)
}

// Convenience: fetch a window around "now" and return computed spans.
// daysBack/daysForward pad the query so an in-progress multi-day span
// (started a few days ago) and upcoming ones are both included.
export async function upcomingSpans({ daysBack = 3, daysForward = 60 } = {}) {
  const cfg = hebcalConfigFromEnv();
  const now = new Date();
  const startStr = fmtDate(new Date(now.getTime() - daysBack * 86400000));
  const endStr = fmtDate(new Date(now.getTime() + daysForward * 86400000));
  const { items, location } = await fetchHebcalItems(cfg, startStr, endStr);
  const spans = computeSpans(items, cfg, startStr, endStr);
  return { spans, location, cfg };
}
