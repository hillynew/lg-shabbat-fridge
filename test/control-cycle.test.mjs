import test from 'node:test';
import assert from 'node:assert/strict';
import { cycle, controlSpec, controlPayload, createClient } from '../scripts/test-control-cycle.mjs';
import { ProbeError } from '../scripts/probe-existing-session.mjs';

const start = Date.parse('2026-11-15T23:00:00Z');
const spec = { controllable: true, onValue: 'ON', offValue: 'OFF', ctrl: { command: 'Set', ctrlKey: 'basicCtrl', path: ['refState'], templateKeys: ['sabbathMode', 'fridgeTemp'] } };
function setup({ initial = false, timestamp = start - 15 * 60000, online = true, failWrite = false, update = true, readFails = false } = {}) {
  let now = start, on = initial, updatedAt = timestamp;
  const writes = [];
  const client = { read: async () => { if (readFails && writes.length) throw Error('read'); return { on, updatedAt, online }; },
    write: async value => { writes.push(value); if (update) { on = value; updatedAt = now; } if (failWrite) throw Error('unknown outcome'); } };
  return { writes, args: { client, expiresAt: start + 3600000, now: () => now, sleep: async ms => { now += ms; } } };
}
test('only Sabbath changes; all other template fields are IGNORE', () => {
  assert.deepEqual(controlPayload(controlSpec(JSON.stringify(spec)), true), { ctrlKey: 'basicCtrl', command: 'Set', dataSetList: { refState: { sabbathMode: 'ON', fridgeTemp: 'IGNORE' } } });
});
test('rejects unsafe or ambiguous control configurations', () => {
  for (const change of [{ controllable: false }, { offValue: 'ON' }, { ctrl: { ...spec.ctrl, command: 'Reset' } },
    { ctrl: { ...spec.ctrl, path: ['__proto__'] } }, { ctrl: { ...spec.ctrl, templateKeys: ['fridgeTemp'] } }]) {
    assert.throws(() => controlSpec(JSON.stringify({ ...spec, ...change })));
  }
});
test('verifies ON then restores and verifies OFF with exactly two commands', async () => {
  const m = setup(); assert.equal((await cycle(m.args)).status, 'on_off_verified'); assert.deepEqual(m.writes, [true, false]);
});
test('uncertain write is resolved by readback, never resubmission', async () => {
  const m = setup({ failWrite: true }); assert.equal((await cycle(m.args)).finalMode, 'off'); assert.deepEqual(m.writes, [true, false]);
});
test('an explicit LG rejection stops without further reads or writes', async () => {
  let reads = 0, writes = 0;
  const rejection = new ProbeError('control', 'http', 400, '9006', 'official_api_required');
  await assert.rejects(cycle({ expiresAt: start + 3600000, now: () => start, sleep: async () => {},
    client: { read: async () => { reads++; return { on: false, online: true, updatedAt: start }; },
      write: async () => { writes++; throw rejection; } } }), e => e === rejection);
  assert.equal(reads, 1); assert.equal(writes, 1);
});
test('already ON, unknown, offline or undated initial status sends nothing', async () => {
  for (const options of [{ initial: true }, { initial: null }, { online: false }, { timestamp: NaN }]) {
    const m = setup(options); await assert.rejects(cycle(m.args), /initial_off_not_confirmed/); assert.equal(m.writes.length, 0);
  }
});
test('an old initial snapshot is accepted because verification needs a newer one', async () => {
  const m = setup({ timestamp: start - 6 * 3600000 }); assert.equal((await cycle(m.args)).status, 'on_off_verified'); assert.deepEqual(m.writes, [true, false]);
});
test('an unverified ON is followed by exactly one restoring OFF', async () => {
  for (const options of [{ update: false }, { readFails: true }]) {
    const m = setup(options); await assert.rejects(cycle(m.args), /on_unverified_off_unverified/); assert.deepEqual(m.writes, [true, false]);
  }
});
test('a rejected readback after ON still sends the restoring OFF, with one read each', async () => {
  const writes = []; let reads = 0;
  await assert.rejects(cycle({ expiresAt: start + 3600000, now: () => start, sleep: async () => {},
    client: { read: async () => { if (reads++) throw new ProbeError('dashboard', 'http', 503); return { on: false, online: true, updatedAt: start }; },
      write: async v => { writes.push(v); } } }), /on_unverified_off_unverified/);
  assert.deepEqual(writes, [true, false]); assert.equal(reads, 3);
});
test('stale matching readback cannot verify a command', async () => {
  const writes = [];
  await assert.rejects(cycle({ expiresAt: start + 3600000, now: () => start, sleep: async () => {},
    client: { read: async () => ({ on: writes.at(-1) ?? false, online: true, updatedAt: start - 60000 }), write: async v => { writes.push(v); } } }), /on_unverified_off_unverified/);
  assert.deepEqual(writes, [true, false]);
});
test('deadline blocks all requests when not enough time remains', async () => {
  const m = setup(); await assert.rejects(cycle({ ...m.args, expiresAt: start + 1000 }), /test_expired/); assert.equal(m.writes.length, 0);
});
test('adapter caches one token, retains identity and rejects a third write', async () => {
  const env = { THINQ_V2_REFRESH_TOKEN: 'refresh', THINQ_V2_OAUTH_URL: 'https://us.lgeapi.com', THINQ_V2_USER_NUMBER: 'user',
    THINQ_V2_CLIENT_ID: 'same-client', THINQ_V2_DEVICE_ID: 'device', THINQ_V2_SABBATH_CTRL: JSON.stringify(spec) };
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('gateway-uri')) return Response.json({ resultCode: '0000', result: { thinq2Uri: 'https://aic-service.lgthinq.com:46030/v1' } });
    if (url.includes('oauth2/token')) return Response.json({ access_token: 'token' });
    return Response.json({ resultCode: '0000', result: {} });
  };
  const c = await createClient(env, fetcher, () => start);
  await c.write(true); await c.write(false); await assert.rejects(c.write(false), /additional_control_blocked/);
  assert.equal(calls.length, 4); assert.equal(calls.filter(c => c.url.includes('oauth2/token')).length, 1);
  assert.ok(calls.filter(c => c.url.includes('control-sync')).every(c => c.options.headers['x-client-id'] === 'same-client'));
});

const env = { THINQ_V2_REFRESH_TOKEN: 'refresh', THINQ_V2_OAUTH_URL: 'https://us.lgeapi.com', THINQ_V2_USER_NUMBER: 'user',
  THINQ_V2_CLIENT_ID: 'same-client', THINQ_V2_DEVICE_ID: 'device', THINQ_V2_SABBATH_CTRL: JSON.stringify(spec) };
// reject(call) decides whether an authenticated request gets HTTP 400 / 9006.
function lgServer(reject) {
  const calls = [];
  const fetcher = async (url, options) => {
    if (url.includes('gateway-uri')) return Response.json({ resultCode: '0000', result: { thinq2Uri: 'https://aic-service.lgthinq.com:46030/v1' } });
    if (url.includes('oauth2/token')) return Response.json({ access_token: 'token' });
    const call = { kind: url.includes('control-sync') ? 'control' : 'dashboard', id: options.headers['x-client-id'], n: calls.length };
    calls.push(call);
    if (reject(call)) return Response.json({ resultCode: '9006', result: 'Please consider using the official API' }, { status: 400 });
    return Response.json({ resultCode: '0000', result: { item: [{ deviceId: 'device', deviceType: 101, online: true, snapshot: { timestamp: start, refState: { sabbathMode: 'OFF' } } }] } });
  };
  return { calls, fetcher };
}
test('a 9006 rejection is retried once with a fresh client id, which is then kept', async () => {
  const events = [];
  const s = lgServer(call => call.id === 'same-client');
  const c = await createClient(env, s.fetcher, () => start, e => events.push(e));
  assert.equal((await c.read()).on, false);
  await c.write(true);
  assert.deepEqual(s.calls.map(x => x.kind), ['dashboard', 'dashboard', 'control']);
  assert.match(s.calls[1].id, /^[0-9a-f]{64}$/); assert.equal(s.calls[2].id, s.calls[1].id);
  assert.deepEqual(events, [{ event: 'identity_rotated', stage: 'dashboard', lgCode: '9006', rotations: 1 }]);
});
test('a rejected control request is repeated once and still counts as one command', async () => {
  const s = lgServer(call => call.kind === 'control' && call.id === 'same-client');
  const c = await createClient(env, s.fetcher, () => start);
  await c.write(true); await c.write(false); await assert.rejects(c.write(false), /additional_control_blocked/);
  assert.equal(s.calls.length, 3);
});
test('a persistent rejection fails after one retry, and rotations are capped per run', async () => {
  const s = lgServer(() => true);
  const c = await createClient(env, s.fetcher, () => start);
  for (let i = 0; i < 3; i++) await assert.rejects(c.read(), e => e instanceof ProbeError && e.lgCode === '9006');
  assert.equal(s.calls.length, 6);
  await assert.rejects(c.read(), e => e.lgCode === '9006'); assert.equal(s.calls.length, 7);
});
