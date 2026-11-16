import { createHash } from 'node:crypto';
import { reconcile, scheduleAt } from './reconcile.js';
import { createLG } from './lg.js';
import { createHeartbeat } from './heartbeat.js';

function isHeld(env, now) {
  if (env.SHABBAT_HOLD !== 'false') return true;
  const until = env.SHABBAT_HOLD_UNTIL;
  if (!until) return false;
  const expiry = Date.parse(until);
  if (typeof until !== 'string' || !Number.isFinite(expiry)
      || new Date(expiry).toISOString().replace('.000Z', 'Z') !== until) {
    throw new Error('hold_until_invalid');
  }
  return now < expiry;
}

export async function run(env, { clock = Date.now, clientFactory = createLG, log = console.log } = {}) {
  const started = clock();
  try {
    const raw = env.SHABBAT_SCHEDULE_JSON || '';
    if (!env.SHABBAT_SCHEDULE_SHA256 || createHash('sha256').update(raw).digest('hex') !== env.SHABBAT_SCHEDULE_SHA256) throw new Error('calendar_integrity_failed');
    const schedule = JSON.parse(raw);
    if (schedule?.validUntil - started < 45 * 86400000) log(JSON.stringify({ event: 'calendar_renewal_required', daysRemaining: Math.floor((schedule.validUntil - started) / 86400000) }));
    scheduleAt(schedule, started);
    const hold = isHeld(env, started);
    const client = hold ? {} : clientFactory(env, undefined, log);
    const result = await reconcile({ schedule, now: started, clock, ...client,
      enabled: env.SHABBAT_WORKER_WRITES === 'true', owner: env.SHABBAT_WRITER,
      hold });
    log(JSON.stringify({ event: 'shabbat_tick', at: started, elapsedMs: clock() - started, ...result }));
    return result;
  } catch (error) {
    // Never log raw errors: LG can echo credentials/account data in its response.
    const safe = ['calendar_integrity_failed', 'calendar_invalid', 'hold_until_invalid', 'state_unknown_or_stale', 'write_unverified', 'lg_config_missing', 'lg_control_invalid', 'lg_host_invalid', 'lg_auth_failed', 'lg_gateway_request_failed', 'lg_token_request_failed', 'lg_dashboard_request_failed', 'lg_write_request_failed'];
    const code = safe.includes(error?.message) ? error.message : 'configuration_or_runtime_error';
    log(JSON.stringify({ event: 'shabbat_tick_failed', at: started, code }));
    throw new Error(code); // failed Cron invocation is visible, not a successful no-op
  }
}

export async function runScheduled(env, dependencies = {}) {
  const { fetcher = fetch, log = console.log } = dependencies;
  const heartbeat = createHeartbeat(env.SHABBAT_HEALTHCHECKS_URL, fetcher, log);
  if (heartbeat) await heartbeat('start');
  let result;
  try {
    result = await run(env, dependencies);
  } catch (error) {
    if (heartbeat) await heartbeat('fail');
    throw error;
  }
  if (heartbeat) await heartbeat('success');
  return result;
}

export default {
  async scheduled(_controller, env) { await runScheduled(env); },
  async fetch() { return new Response('Not found', { status: 404 }); },
};
