import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, scheduleAt, knownState, dueAt } from '../worker/reconcile.js';
import { buildSchedule } from '../worker/calendar.js';
import { run, runScheduled } from '../worker/index.js';
import { createLG } from '../worker/lg.js';
import { requestJson } from '../worker/http.js';
import { zonedWallTimeToInstant } from '../src/hebcal.js';
import fs from 'node:fs';
const now = Date.parse('2026-11-13T18:00Z');
const schedule = { version: 1, validFrom: now - 100000, validUntil: now + 99999999, spans: [{ on: now - 1, off: now + 100000 }] };
const state = on => ({ on, updatedAt: now, online: true });
const base = { schedule, now, enabled: true, owner: 'cloudflare', hold: false, sleep: async () => {} };
const rawSchedule = JSON.stringify(schedule);
const workerEnv = {
  SHABBAT_SCHEDULE_JSON: rawSchedule,
  SHABBAT_SCHEDULE_SHA256: createHash('sha256').update(rawSchedule).digest('hex'),
  SHABBAT_HOLD: 'false',
};
test('ON and OFF boundaries are half open', () => {
  assert.equal(scheduleAt(schedule, now), true);
  assert.equal(scheduleAt(schedule, now + 100000), false);
});
test('invalid, expired, missing and overlapping calendars cannot cause OFF', async () => {
  for (const bad of [null, { ...schedule, validUntil: now }, { ...schedule, spans: [] }, { ...schedule, spans: [{ on: 3, off: 2 }] }, { ...schedule, spans: [...schedule.spans, ...schedule.spans] }]) {
    let writes = 0;
    await assert.rejects(reconcile({ ...base, schedule: bad, read: async () => state(true), write: async () => writes++ }));
    assert.equal(writes, 0);
  }
});
test('default shadow and writer gate never write', async () => {
  for (const gate of [{ enabled: false }, { owner: 'github' }]) {
    let writes = 0;
    const result = await reconcile({ ...base, ...gate, read: async () => state(false), write: async () => writes++ });
    assert.equal(result.status, 'shadow'); assert.equal(writes, 0);
  }
});
test('hold preserves manual overrides without reads or writes', async () => {
  assert.equal((await reconcile({ ...base, hold: true, read: () => assert.fail(), write: () => assert.fail() })).status, 'held');
});
test('unknown, offline, undated and future states fail closed; snapshot age alone does not', () => {
  assert.equal(knownState({ ...state(false), updatedAt: now - 6 * 3600000 }, now), false);
  assert.equal(knownState({ ...state(true), updatedAt: now + 60000 }, now), true);
  for (const value of [{ on: null }, { ...state(false), online: false }, { ...state(false), updatedAt: now + 60001 }, { on: true, online: true }]) assert.throws(() => knownState(value, now));
});
test('failed initial read stops before a command', async () => {
  let reads = 0;
  await assert.rejects(reconcile({ ...base, read: async () => { reads++; throw new Error('dashboard_failure'); }, write: () => assert.fail() }), /dashboard_failure/);
  assert.equal(reads, 1);
});
test('an old snapshot is acted on once and verified only by a newer one', async () => {
  const old = now - 74 * 60000;
  let reads = 0, writes = 0;
  const result = await reconcile({ ...base, read: async () => ++reads === 1 ? { ...state(false), updatedAt: old } : state(true), write: async () => { writes++; } });
  assert.equal(result.status, 'verified'); assert.equal(writes, 1); assert.equal(reads, 2);
});
const day = 86400000, hour = 3600000;
const week = { spans: [{ on: 10 * day, off: 11 * day + 7 * hour }, { on: 17 * day, off: 18 * day + 7 * hour }] };
test('the fridge is contacted only when a transition could be pending', () => {
  const [a, b] = week.spans;
  const hourly = t => { let n = 0; for (let i = 0; i < 20; i++) n += dueAt(week, t + i * 180000); return n; };
  assert.equal(dueAt(week, a.on - 1), false);                       // before the first span: never
  for (const edge of [a.on, a.off, b.on]) for (let t = edge; t < edge + 30 * 60000; t += 180000) assert.equal(dueAt(week, t), true); // every tick after a boundary
  assert.equal(hourly(a.on + 5 * hour), 1);                         // inside a span: once an hour
  assert.equal(hourly(a.off + 5 * hour), 1);                        // for a day after it ends: once an hour
  assert.equal(hourly(a.off + 25 * hour), 0);                       // ordinary days: never
  assert.equal(dueAt(week, b.on - 180000), false);
});
test('an idle tick makes no LG request and leaves a manual change alone', async () => {
  const idle = { ...schedule, validFrom: now - 4 * day, validUntil: now + 6 * day, spans: [{ on: now - 3 * day, off: now - 2 * day }, { on: now + 4 * day, off: now + 5 * day }] };
  const result = await reconcile({ ...base, schedule: idle, read: () => assert.fail(), write: () => assert.fail() });
  assert.deepEqual(result, { status: 'idle', desired: false });
});
test('single write followed by readback verification', async () => {
  let reads = 0, writes = 0, time = now;
  const result = await reconcile({ ...base, clock: () => time, sleep: async ms => { time += ms; },
    read: async () => ({ ...state(++reads > 1), updatedAt: time }),
    write: async on => { assert.equal(on, true); writes++; } });
  assert.equal(result.status, 'verified'); assert.equal(writes, 1); assert.equal(reads, 2);
});
test('uncertain write is not retried; readback resolves success', async () => {
  let reads = 0, writes = 0, time = now;
  const result = await reconcile({ ...base, clock: () => time, sleep: async ms => { time += ms; },
    read: async () => ({ ...state(++reads > 1), updatedAt: time }),
    write: async () => { writes++; throw new Error('timeout'); } });
  assert.equal(result.status, 'verified_after_uncertain_write'); assert.equal(writes, 1);
});
test('failed write/readback is a failed invocation after a bounded number of reads', async () => {
  let reads = 0, writes = 0;
  await assert.rejects(reconcile({ ...base, read: async () => { reads++; return state(false); }, write: async () => { writes++; throw new Error('failed'); } }), /write_unverified/);
  assert.equal(writes, 1); assert.equal(reads, 7);
});
test('access rejection stops further requests during a write or readback', async () => {
  const rejection = Object.assign(new Error('lg_request_rejected'), { accessRejected: true });
  for (const stage of ['write', 'readback']) {
    let reads = 0, writes = 0;
    await assert.rejects(reconcile({ ...base, read: async () => {
      if (++reads > 1) throw rejection;
      return state(false);
    }, write: async () => {
      writes++;
      if (stage === 'write') throw rejection;
    } }), /lg_request_rejected/);
    assert.equal(reads, stage === 'write' ? 1 : 2);
    assert.equal(writes, 1);
  }
});
test('boundary crossed while reading never applies old decision', async () => {
  const result = await reconcile({ ...base, clock: () => now + 100001, read: async () => state(false), write: () => assert.fail() });
  assert.equal(result.status, 'boundary_changed');
});
test('timeout bounds fetch and redacts upstream content', async () => {
  await assert.rejects(requestJson('https://example.com', {}, (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('secret')))), 5), /^Error: upstream_request_failed$/);
  await assert.rejects(requestJson('https://example.com', {}, async () => ({ ok: false, status: 500, json: () => ({ secret: 'secret' }) })), /upstream_request_failed/);
});
test('logs and thrown errors contain no upstream secret', async () => {
  const logs = [];
  await assert.rejects(run({ SHABBAT_SCHEDULE_JSON: JSON.stringify(schedule), SHABBAT_SCHEDULE_SHA256: createHash('sha256').update(JSON.stringify(schedule)).digest('hex'), SHABBAT_HOLD: 'false' }, { clock: () => now, clientFactory: () => { throw new Error('SECRET_ACCESS_TOKEN'); }, log: line => logs.push(line) }), /configuration_or_runtime_error/);
  assert.ok(!logs.join('').includes('SECRET_ACCESS_TOKEN'));
});
const cfg = { tzid: 'America/New_York', onTime: '12:00', havdalahMinutes: 60 };
function calendar(items, options = {}) {
  return buildSchedule({ items, cfg, start: '2026-10-25', end: '2026-11-22', validFrom: Date.parse('2026-11-02T00:00Z'), validUntil: Date.parse('2026-11-15T00:00Z'), requireAnnual: false, ...options });
}
const weekends = ['2026-10-31', '2026-11-07', '2026-11-14', '2026-11-21'].map(date => ({ category: 'havdalah', date: `${date}T18:00:00-05:00` }));
test('missing Havdalah never drops a restricted span', () => {
  assert.throws(() => calendar(weekends.filter(i => !i.date.startsWith('2026-11-07'))), /missing_havdalah/);
});
test('multi-day holiday adjoining Shabbos is continuous', () => {
  const result = calendar([...weekends, { category: 'holiday', yomtov: true, date: '2026-11-05' }, { category: 'holiday', yomtov: true, date: '2026-11-06' }]);
  assert.equal(result.spans[0].on, Date.parse('2026-11-04T17:00Z'));
  assert.equal(result.spans[0].off, Date.parse('2026-11-07T23:00Z'));
});
test('noon respects DST in both directions', () => {
  for (const [date, hour] of [['2026-03-06', 17], ['2026-03-13', 16], ['2026-10-30', 16], ['2026-11-06', 17]]) assert.equal(zonedWallTimeToInstant(date, '12:00', cfg.tzid).getUTCHours(), hour);
});
test('Saturday is a civil date even at UTC+14', () => {
  const items = weekends.map(i => ({ ...i, date: i.date.replace('-05:00', '+14:00') }));
  const result = calendar(items, { cfg: { ...cfg, tzid: 'Pacific/Kiritimati' } });
  assert.equal(result.spans[0].on, Date.parse('2026-11-06T12:00:00+14:00'));
});
test('annual successful but missing holiday data is rejected', () => {
  assert.throws(() => calendar(weekends, { requireAnnual: true, start: '2026-01-01', end: '2026-12-31' }), /incomplete_holidays/);
});
test('malformed timestamp, wrong timezone and padding rejected', () => {
  assert.throws(() => calendar([{ category: 'havdalah', date: 'oops' }]));
  assert.throws(() => calendar(weekends, { cfg: { ...cfg, tzid: 'bad/zone' } }));
  assert.throws(() => calendar(weekends, { validFrom: Date.parse('2026-10-25T00:00Z') }));
});
test('free configuration has no paid resources, endpoints or enabled writes', () => {
  const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'));
  assert.deepEqual(config.triggers.crons, ['*/3 * * * *']);
  assert.equal(config.vars.SHABBAT_WORKER_WRITES, 'false');
  assert.equal(config.vars.SHABBAT_HOLD, 'true');
  assert.equal(config.workers_dev, false);
  for (const key of ['kv_namespaces', 'durable_objects', 'r2_buckets', 'd1_databases', 'queues', 'services', 'routes']) assert.equal(config[key], undefined);
});
test('LG config rejects non-LG credential destinations', () => {
  const env = Object.fromEntries(['REFRESH_TOKEN', 'OAUTH_URL', 'USER_NUMBER', 'DEVICE_ID', 'CLIENT_ID', 'SABBATH_CTRL'].map(k => [`THINQ_V2_${k}`, 'x']));
  env.THINQ_V2_OAUTH_URL = 'https://attacker.example';
  assert.throws(() => createLG(env), /lg_host_invalid/);
});
function lgEnv() {
  return { THINQ_V2_REFRESH_TOKEN: 'FAKE_TOKEN', THINQ_V2_OAUTH_URL: 'https://oauth.lge.com', THINQ_V2_USER_NUMBER: 'FAKE_USER', THINQ_V2_DEVICE_ID: 'FAKE_DEVICE', THINQ_V2_CLIENT_ID: 'FAKE_CLIENT', THINQ_V2_SABBATH_CTRL: JSON.stringify({ controllable: true, onValue: 'ON', offValue: 'OFF', ctrl: { command: 'Set', ctrlKey: 'basicCtrl', templateKeys: ['sabbathMode', 'temperature'], path: ['refState'] } }) };
}
test('LG adapter preserves gateway base path, reuses token and writes only selected key', async () => {
  const calls = [];
  const client = createLG(lgEnv(), async (url, options) => {
    calls.push({ url, options });
    if (url.includes('gateway-uri')) return { resultCode: '0000', result: { thinq2Uri: 'https://aic.lgthinq.com:46030/v2' } };
    if (url.includes('oauth2/token')) return { access_token: 'FAKE_ACCESS' };
    if (url.endsWith('dashboard')) return { resultCode: '0000', result: { item: [{ deviceId: 'FAKE_DEVICE', online: true, snapshot: { timestamp: now, refState: { sabbathMode: 'OFF' } } }] } };
    return { resultCode: '0000', result: {} };
  });
  assert.deepEqual(await client.read(), state(false));
  await client.write(true);
  assert.equal(calls[2].url, 'https://aic.lgthinq.com:46030/v2/service/application/dashboard');
  assert.deepEqual(JSON.parse(calls[3].options.body).dataSetList, { refState: { sabbathMode: 'ON', temperature: 'IGNORE' } });
  assert.equal(calls.length, 4);
});
function rejecting(reject, status = 400) {
  const seen = [], logs = [];
  const client = createLG(lgEnv(), (url, options) => requestJson(url, options, async () => {
    if (url.includes('gateway-uri')) return Response.json({ resultCode: '0000', result: { thinq2Uri: 'https://aic.lgthinq.com/v2' } });
    if (url.includes('oauth2/token')) return Response.json({ access_token: 'FAKE_ACCESS' });
    const call = { id: options.headers['x-client-id'], write: options.method === 'POST' };
    seen.push(call);
    if (reject(call)) return Response.json({ resultCode: '9006', result: 'PRIVATE_RESPONSE' }, { status });
    return Response.json({ resultCode: '0000', result: { item: [{ deviceId: 'FAKE_DEVICE', online: true, snapshot: { timestamp: now, refState: { sabbathMode: 'OFF' } } }] } });
  }), line => logs.push(JSON.parse(line)));
  return { client, seen, logs };
}
test('LG 9006 in either HTTP form is retried once with a fresh client id, which is then kept', async () => {
  for (const status of [200, 400]) {
    const t = rejecting(call => call.id === 'FAKE_CLIENT', status);
    assert.equal((await t.client.read()).on, false);
    await t.client.write(true);
    assert.equal(t.seen.length, 3); assert.match(t.seen[1].id, /^[0-9a-f]{64}$/); assert.equal(t.seen[2].id, t.seen[1].id);
    assert.deepEqual(t.logs.filter(l => l.event !== 'lg_read_metadata'), [
      { event: 'lg_request_failed', stage: 'dashboard', reason: status === 400 ? 'http' : 'lg', httpStatus: status === 400 ? 400 : null, lgCode: '9006' },
      { event: 'lg_client_id_rotated', stage: 'dashboard', lgCode: '9006', rotations: 1 }]);
  }
});
test('a rejected write is repeated once with a new id; other failures are never repeated', async () => {
  const t = rejecting(call => call.write && call.id === 'FAKE_CLIENT');
  await t.client.write(true);
  assert.deepEqual(t.seen.map(c => c.write), [true, true]); assert.notEqual(t.seen[1].id, 'FAKE_CLIENT');
  let posts = 0;
  const plain = createLG(lgEnv(), async (url, options) => {
    if (url.includes('gateway-uri')) return { resultCode: '0000', result: { thinq2Uri: 'https://aic.lgthinq.com/v2' } };
    if (url.includes('oauth2/token')) return { access_token: 'FAKE_ACCESS' };
    posts++; throw Object.assign(new Error('timeout'), { kind: 'timeout' });
  });
  await assert.rejects(plain.write(true), /lg_write_request_failed/); assert.equal(posts, 1);
});
test('a persistent 9006 is terminal after one retry and rotations are capped per invocation', async () => {
  const t = rejecting(() => true);
  for (let i = 0; i < 3; i++) await assert.rejects(t.client.read(), { message: 'lg_dashboard_request_failed', accessRejected: true });
  assert.equal(t.seen.length, 6);
  await assert.rejects(t.client.read(), { accessRejected: true }); assert.equal(t.seen.length, 7);
  assert.ok(!JSON.stringify(t.logs).includes('PRIVATE_RESPONSE'));
});
test('held schedule needs no LG credentials', async () => {
  const result = await run({ SHABBAT_SCHEDULE_JSON: JSON.stringify(schedule), SHABBAT_SCHEDULE_SHA256: createHash('sha256').update(JSON.stringify(schedule)).digest('hex') }, { clock: () => now, log: () => {} });
  assert.equal(result.status, 'held');
});
test('runtime rejects a missing weekly span and uncovered far edge', () => {
  assert.throws(() => scheduleAt({ ...schedule, validUntil: now + 15 * 86400000 }, now), /calendar_invalid/);
});
test('a desired-state snapshot no newer than the one read before the command cannot verify it', async () => {
  for (const updatedAt of [now - 1000, now]) {
    let calls = 0;
    await assert.rejects(reconcile({ ...base, read: async () => ++calls === 1 ? state(false) : { ...state(true), updatedAt }, write: async () => {} }), /write_unverified/);
    assert.equal(calls, 7);
  }
});
test('writes near next boundary are deferred', async () => {
  const result = await reconcile({ ...base, schedule: { ...schedule, spans: [{ on: now - 1, off: now + 20000 }] }, read: async () => state(false), write: () => assert.fail() });
  assert.equal(result.status, 'boundary_near');
});
test('damaged artifact cannot silently omit a holiday', async () => {
  await assert.rejects(run({ SHABBAT_SCHEDULE_JSON: JSON.stringify(schedule), SHABBAT_SCHEDULE_SHA256: 'incorrect' }, { clock: () => now, log: () => {} }), /calendar_integrity_failed/);
});

test('US login origin is exact and does not broaden gateway destinations', async () => {
  const env = { ...lgEnv(), THINQ_V2_OAUTH_URL: 'https://us.lgeapi.com/' };
  const calls = [], logs = [];
  const client = createLG(env, async (url, options) => {
    calls.push({ url, options });
    if (url.includes('gateway-uri')) return { resultCode: '0000', result: { thinq2Uri: 'https://aic.lgthinq.com:46030/v2' } };
    if (url.includes('oauth2/token')) return { access_token: 'FAKE_ACCESS' };
    return { resultCode: '0000', result: { item: [{ deviceId: 'FAKE_DEVICE', online: true, snapshot: { timestamp: now, refState: { sabbathMode: 'ON' } } }] } };
  }, line => logs.push(line));
  assert.deepEqual(await client.read(), state(true));
  assert.equal(calls[1].url, 'https://us.lgeapi.com/oauth/1.0/oauth2/token');
  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(logs[0]).mode, 'on');
  assert.ok(!logs.join('').includes('FAKE_'));
  for (const url of ['http://us.lgeapi.com', 'https://us.lgeapi.com:444', 'https://us.lgeapi.com/path', 'https://user:pass@us.lgeapi.com', 'https://us.lgeapi.com?token=private', 'https://us.lgeapi.com#private', 'https://us.lgeapi.com.evil.example', 'https://evil.us.lgeapi.com', 'https://lgeapi.com']) {
    assert.throws(() => createLG({ ...env, THINQ_V2_OAUTH_URL: url }), /lg_host_invalid/);
  }
  const badGateway = createLG(env, async () => ({ resultCode: '0000', result: { thinq2Uri: 'https://evil.us.lgeapi.com' } }));
  await assert.rejects(badGateway.read(), /lg_host_invalid/);
});
test('LG connection errors name only their stage', async () => {
  for (const stage of ['gateway', 'token', 'dashboard']) {
    const client = createLG(lgEnv(), async url => {
      if ((stage === 'gateway' && url.includes('gateway-uri')) || (stage === 'token' && url.includes('oauth2/token')) || (stage === 'dashboard' && url.endsWith('dashboard'))) throw new Error('SECRET_RESPONSE');
      if (url.includes('gateway-uri')) return { resultCode: '0000', result: { thinq2Uri: 'https://aic.lgthinq.com/v2' } };
      return { access_token: 'FAKE_ACCESS' };
    });
    await assert.rejects(client.read(), new RegExp('^Error: lg_' + stage + '_request_failed$'));
  }
});
test('held runtime never constructs an LG client even with credentials', async () => {
  const raw = JSON.stringify(schedule);
  const result = await run({ ...lgEnv(), SHABBAT_HOLD: 'true', SHABBAT_SCHEDULE_JSON: raw, SHABBAT_SCHEDULE_SHA256: createHash('sha256').update(raw).digest('hex') }, { clock: () => now, clientFactory: () => assert.fail(), log: () => {} });
  assert.equal(result.status, 'held');
});
test('timed hold blocks all LG requests until expiry and a malformed timestamp fails closed', async () => {
  const until = '2026-11-13T18:00:00Z';
  const env = { ...workerEnv, SHABBAT_HOLD_UNTIL: until };
  const deps = { clock: () => now - 1, clientFactory: () => assert.fail(), log: () => {} };
  assert.equal((await run(env, deps)).status, 'held');
  assert.equal((await run(env, { ...deps, clock: () => now,
    clientFactory: () => ({ read: async () => state(false), write: () => assert.fail() }) })).status, 'shadow');
  for (const invalid of ['tomorrow', '2026-02-30T18:00:00Z', '2026-11-13T13:00:00-05:00']) {
    await assert.rejects(run({ ...env, SHABBAT_HOLD_UNTIL: invalid }, deps), /hold_until_invalid/);
  }
  assert.equal((await run({ ...env, SHABBAT_HOLD: 'true' }, { ...deps, clock: () => now + 1 })).status, 'held');
});

test('Workers HTTP uses manual redirects and rejects every redirect without parsing', async () => {
  for (const status of [301, 302, 303, 307, 308, 403]) {
    let calls = 0;
    await assert.rejects(requestJson('https://example.com', { redirect: 'follow' }, async (url, options) => {
      calls++;
      assert.equal(options.redirect, 'manual');
      return { ok: false, status, json: () => assert.fail('Must not parse rejected response') };
    }), error => error.message === 'upstream_request_failed' && error.kind === 'http' && error.httpStatus === status);
    assert.equal(calls, 1);
  }
});
test('rate limit and challenge are terminal LG responses', async () => {
  for (const response of [new Response(null, { status: 429 }),
    new Response('challenge', { status: 503, headers: { 'cf-mitigated': 'challenge' } })]) {
    await assert.rejects(requestJson('https://example.com', {}, async () => response),
      { message: 'upstream_request_failed', httpStatus: response.status, accessRejected: true });
  }
});

const heartbeatURL = 'https://hc-ping.com/d1665499-e827-441f-bf13-8f15e8f4c0b9';
test('scheduled heartbeat reports starts and distinct completion and failure signals', async () => {
  const env = { ...workerEnv, SHABBAT_HEALTHCHECKS_URL: heartbeatURL };
  const requests = [];
  const deps = { clock: () => now, log: () => {},
    fetcher: async (url, options) => {
      requests.push([url, options.method, options.redirect, options.body]);
      return { status: 200 };
    },
    clientFactory: () => ({ read: async () => state(false), write: () => assert.fail() }) };
  assert.equal((await runScheduled(env, deps)).status, 'shadow');
  await assert.rejects(runScheduled({ ...env, SHABBAT_SCHEDULE_SHA256: 'wrong' }, deps), /calendar_integrity_failed/);
  assert.deepEqual(requests, [heartbeatURL + '/start', heartbeatURL, heartbeatURL + '/start', heartbeatURL + '/fail']
    .map(url => [url, 'HEAD', 'manual', undefined]));
});
test('heartbeat is optional and a ping failure cannot mask the control result or leak its URL', async () => {
  const logs = [];
  const deps = { clock: () => now, log: line => logs.push(JSON.parse(line)), clientFactory: () => assert.fail() };
  const env = { ...workerEnv, SHABBAT_HOLD: 'true' };
  await runScheduled(env, { ...deps, fetcher: () => assert.fail() });
  let rejectedDestinations = 0;
  for (const invalid of ['https://other.example/ping', heartbeatURL + '?secret=test', heartbeatURL + '/fail']) {
    assert.equal((await runScheduled({ ...env, SHABBAT_HEALTHCHECKS_URL: invalid },
      { ...deps, fetcher: async () => { rejectedDestinations++; } })).status, 'held');
  }
  assert.equal(rejectedDestinations, 0);
  const withHeartbeat = { ...env, SHABBAT_HEALTHCHECKS_URL: heartbeatURL };
  const fetcher = async () => { throw new Error(heartbeatURL); };
  assert.equal((await runScheduled(withHeartbeat, { ...deps, fetcher })).status, 'held');
  assert.deepEqual(logs.filter(log => log.event === 'healthchecks_ping_failed').map(log => log.phase), ['start', 'success']);
  assert.ok(!JSON.stringify(logs).includes(heartbeatURL));
});
