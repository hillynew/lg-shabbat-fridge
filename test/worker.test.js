import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, scheduleAt, knownState } from '../worker/reconcile.js';
import { buildSchedule } from '../worker/calendar.js';
import { run } from '../worker/index.js';
import { createLG } from '../worker/lg.js';
import { requestJson } from '../worker/http.js';
import { zonedWallTimeToInstant } from '../src/hebcal.js';
import fs from 'node:fs';
const now = Date.parse('2026-11-13T18:00Z');
const schedule = { version: 1, validFrom: now - 100000, validUntil: now + 99999999, spans: [{ on: now - 1, off: now + 100000 }] };
const state = on => ({ on, updatedAt: now, online: true });
const base = { schedule, now, enabled: true, owner: 'cloudflare', hold: false, sleep: async () => {} };
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
test('unknown, offline, stale and future timestamps fail closed', () => {
  for (const value of [{ on: null }, { ...state(false), online: false }, { ...state(false), updatedAt: now - 600001 }, { ...state(false), updatedAt: now + 60001 }, { on: true, online: true }]) assert.throws(() => knownState(value, now));
});
test('single write followed by readback verification', async () => {
  let reads = 0, writes = 0;
  const result = await reconcile({ ...base, read: async () => state(++reads > 1), write: async on => { assert.equal(on, true); writes++; } });
  assert.equal(result.status, 'verified'); assert.equal(writes, 1); assert.equal(reads, 2);
});
test('uncertain write is not retried; readback resolves success', async () => {
  let reads = 0, writes = 0;
  const result = await reconcile({ ...base, read: async () => state(++reads > 1), write: async () => { writes++; throw new Error('timeout'); } });
  assert.equal(result.status, 'verified_after_uncertain_write'); assert.equal(writes, 1);
});
test('failed write/readback is a failed invocation after exactly three reads', async () => {
  let reads = 0, writes = 0;
  await assert.rejects(reconcile({ ...base, read: async () => { reads++; return state(false); }, write: async () => { writes++; throw new Error('failed'); } }), /write_unverified/);
  assert.equal(writes, 1); assert.equal(reads, 4);
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
test('explicit client ID rejection retries once, uncertain writes never retry', async () => {
  let rejected = 0;
  const ids = [];
  const client = createLG(lgEnv(), async (url, options) => {
    if (url.includes('gateway-uri')) return { resultCode: '0000', result: { thinq2Uri: 'https://aic.lgthinq.com/v2' } };
    if (url.includes('oauth2/token')) return { access_token: 'FAKE_ACCESS' };
    ids.push(options.headers['x-client-id']);
    rejected++;
    return { resultCode: '9006' };
  });
  await assert.rejects(client.read(), /lg_response_error/);
  assert.equal(rejected, 2); assert.notEqual(ids[0], ids[1]);
});
test('held schedule needs no LG credentials', async () => {
  const result = await run({ SHABBAT_SCHEDULE_JSON: JSON.stringify(schedule), SHABBAT_SCHEDULE_SHA256: createHash('sha256').update(JSON.stringify(schedule)).digest('hex') }, { clock: () => now, log: () => {} });
  assert.equal(result.status, 'held');
});
test('runtime rejects a missing weekly span and uncovered far edge', () => {
  assert.throws(() => scheduleAt({ ...schedule, validUntil: now + 15 * 86400000 }, now), /calendar_invalid/);
});
test('older desired-state snapshot cannot verify a write', async () => {
  let calls = 0;
  await assert.rejects(reconcile({ ...base, read: async () => ++calls === 1 ? state(false) : { ...state(true), updatedAt: now - 300000 }, write: async () => {} }), /write_unverified/);
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
