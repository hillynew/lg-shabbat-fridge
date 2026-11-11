import { createHash } from 'node:crypto';
import { reconcile, scheduleAt } from './reconcile.js';
import { createLG } from './lg.js';

export async function run(env, { clock = Date.now, clientFactory = createLG, log = console.log } = {}) {
  const started = clock();
  try {
    const raw = env.SHABBAT_SCHEDULE_JSON || '';
    if (!env.SHABBAT_SCHEDULE_SHA256 || createHash('sha256').update(raw).digest('hex') !== env.SHABBAT_SCHEDULE_SHA256) throw new Error('calendar_integrity_failed');
    const schedule = JSON.parse(raw);
    if (schedule?.validUntil - started < 45 * 86400000) log(JSON.stringify({ event: 'calendar_renewal_required', daysRemaining: Math.floor((schedule.validUntil - started) / 86400000) }));
    scheduleAt(schedule, started);
    const client = env.SHABBAT_HOLD === 'false' ? clientFactory(env) : {};
    const result = await reconcile({ schedule, now: started, clock, ...client,
      enabled: env.SHABBAT_WORKER_WRITES === 'true', owner: env.SHABBAT_WRITER,
      hold: env.SHABBAT_HOLD !== 'false' });
    log(JSON.stringify({ event: 'shabbat_tick', at: started, elapsedMs: clock() - started, ...result }));
    return result;
  } catch (error) {
    // Never log raw errors: LG can echo credentials/account data in its response.
    const safe = ['calendar_integrity_failed', 'calendar_invalid', 'state_unknown_or_stale', 'write_unverified', 'lg_config_missing', 'lg_control_invalid', 'lg_host_invalid', 'lg_response_error', 'lg_auth_failed', 'upstream_request_failed'];
    const code = safe.includes(error?.message) ? error.message : 'configuration_or_runtime_error';
    log(JSON.stringify({ event: 'shabbat_tick_failed', at: started, code }));
    throw new Error(code); // failed Cron invocation is visible, not a successful no-op
  }
}
export default {
  async scheduled(_controller, env) { await run(env); },
  async fetch() { return new Response('Not found', { status: 404 }); },
};
