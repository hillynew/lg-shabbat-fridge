// Pure one-shot controller. No catch-up loop and no guessed state.
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
      || !Number.isFinite(state.updatedAt) || state.updatedAt > now + 60000
      || now - state.updatedAt > 10 * 60000) throw new Error('state_unknown_or_stale');
  return state.on;
}

export async function reconcile({ schedule, now, clock = () => now, read, write,
  enabled = false, owner = '', hold = true, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const desired = scheduleAt(schedule, now); // invalid calendar ALWAYS blocks writes, including OFF
  if (hold) return { status: 'held', desired };
  const initial = await read();
  const current = knownState(initial, clock());
  if (current === desired) return { status: 'unchanged', desired };
  if (!enabled || owner !== 'cloudflare') return { status: 'shadow', desired, current };
  // Re-evaluate at the last possible moment. Never apply an expired/old decision.
  if (scheduleAt(schedule, clock()) !== desired) return { status: 'boundary_changed' };
  const writeStarted = clock();
  if (schedule.spans.some(span => [span.on, span.off].some(t => t > writeStarted && t - writeStarted < 30000))) return { status: 'boundary_near' };
  // Never retry a write: a network timeout can mean it already executed.
  let uncertain = false;
  try { await write(desired); } catch { uncertain = true; }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(1500);
    try {
      const observed = await read();
      if (knownState(observed, clock()) === desired && observed.updatedAt >= Math.max(initial.updatedAt, writeStarted)) {
        return { status: uncertain ? 'verified_after_uncertain_write' : 'verified', desired };
      }
    } catch { /* bounded readback, never another write */ }
  }
  throw new Error('write_unverified');
}
