// Pure one-shot controller. No catch-up loop and no guessed state.
// LG's snapshot timestamp only moves when the fridge reports a change (it was
// 74 minutes old, then updated within 5 s of each command, on 2026-11-16). So
// its age says nothing about liveness: `online` does. A command is verified
// by a snapshot strictly newer than the one read before it.
const futureToleranceMs = 60_000;
const readSpacingMs = 3_000;
const verifyReads = 6;
// LG is only contacted when a transition could be pending, so an ordinary-day
// manual change is left alone and LG sees a few dozen requests a day, not ~500.
const tickMs = 3 * 60_000; // must match the Cron cadence
const burstMs = 30 * 60_000; // every tick right after a boundary
const hourlyTicks = 20; // then one tick in 20
const offWatchMs = 24 * 3_600_000; // keep enforcing OFF this long after a span

// Whether this tick should contact the fridge at all.
export function dueAt(schedule, now) {
  let since = Infinity;
  let inside = false;
  for (const span of schedule.spans) {
    if (now >= span.on && now < span.off) { inside = true; since = now - span.on; }
    else if (now >= span.off) since = Math.min(since, now - span.off);
  }
  if (since < burstMs) return true;
  if (inside || since < offWatchMs) return Math.floor(now / tickMs) % hourlyTicks === 0;
  return false;
}

export function scheduleAt(schedule, now) {
  if (!schedule || schedule.version !== 1 || !Number.isFinite(now)
      || !Number.isFinite(schedule.validFrom) || !Number.isFinite(schedule.validUntil)
      || now < schedule.validFrom || now >= schedule.validUntil
      || schedule.validUntil - schedule.validFrom > 370 * 86400000
      || !Array.isArray(schedule.spans) || !schedule.spans.length) throw new Error('calendar_invalid');
  let end = null;
  let desired = false;
  for (const span of schedule.spans) {
    if (!Number.isFinite(span.on) || !Number.isFinite(span.off) || span.on >= span.off
        || (end !== null && span.on < end) || span.on - (end ?? schedule.validFrom) > 7 * 86400000 || span.off - span.on > 5 * 86400000) throw new Error('calendar_invalid');
    end = span.off;
    if (now >= span.on && now < span.off) desired = true;
  }
  if (schedule.validUntil - end > 7 * 86400000) throw new Error('calendar_invalid');
  return desired;
}

export function knownState(state, now) {
  if (typeof state?.on !== 'boolean' || state.online !== true
      || !Number.isFinite(state.updatedAt) || state.updatedAt > now + futureToleranceMs) throw new Error('state_unknown_or_stale');
  return state.on;
}

export async function reconcile({ schedule, now, clock = () => now, read, write,
  enabled = false, owner = '', hold = true, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const desired = scheduleAt(schedule, now); // invalid calendar ALWAYS blocks writes, including OFF
  if (hold) return { status: 'held', desired };
  if (!dueAt(schedule, now)) return { status: 'idle', desired };
  const initial = await read();
  const current = knownState(initial, clock());
  if (current === desired) return { status: 'unchanged', desired };
  if (!enabled || owner !== 'cloudflare') return { status: 'shadow', desired, current };
  // Re-evaluate at the last possible moment. Never apply an expired/old decision.
  const writeStarted = clock();
  if (scheduleAt(schedule, writeStarted) !== desired) return { status: 'boundary_changed' };
  knownState(initial, writeStarted);
  if (schedule.spans.some(span => [span.on, span.off].some(t => t > writeStarted && t - writeStarted < 30000))) return { status: 'boundary_near' };
  // Never retry a write: a network timeout can mean it already executed.
  let uncertain = false;
  try {
    await write(desired);
  } catch (error) {
    if (error?.accessRejected) throw error;
    uncertain = true;
  }
  for (let attempt = 0; attempt < verifyReads; attempt++) {
    await sleep(readSpacingMs);
    try {
      const observed = await read();
      if (knownState(observed, clock()) === desired && observed.updatedAt > initial.updatedAt) {
        return { status: uncertain ? 'verified_after_uncertain_write' : 'verified', desired };
      }
    } catch (error) {
      if (error?.accessRejected) throw error;
    }
  }
  throw new Error('write_unverified');
}
