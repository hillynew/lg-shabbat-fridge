// Weekday + HH:MM right now in America/New_York, computed with Intl so the
// EST/EDT transitions are handled correctly (no manual UTC-offset math,
// which is exactly the kind of bug that creeps in around DST changes).

const _etClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function nowETClock() {
  const parts = Object.fromEntries(_etClock.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { weekday: parts.weekday, time: `${parts.hour}:${parts.minute}` };
}
