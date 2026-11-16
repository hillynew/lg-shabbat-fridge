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
test('already ON, unknown, offline or old initial status sends nothing', async () => {
  for (const options of [{ initial: true }, { initial: null }, { online: false }, { timestamp: start - 31 * 60000 }]) {
    const m = setup(options); await assert.rejects(cycle(m.args), /initial_off_not_confirmed/); assert.equal(m.writes.length, 0);
  }
});
test('a stale dashboard can use one dedicated status query; stale results still block', async () => {
  for (const fresh of [true, false]) {
    const m = setup({ timestamp: start - 60 * 60000 });
    let detailReads = 0;
    m.args.client.readDetailed = async () => { detailReads++; return { on: false, online: true, updatedAt: fresh ? start - 1000 : start - 60 * 60000 }; };
    if (fresh) assert.equal((await cycle(m.args)).finalMode, 'off');
    else await assert.rejects(cycle(m.args), /initial_off_not_confirmed/);
    assert.equal(detailReads, 1); assert.deepEqual(m.writes, fresh ? [true, false] : []);
  }
});
test('an unverified ON stops without another command', async () => {
  for (const options of [{ update: false }, { readFails: true }]) {
    const m = setup(options); await assert.rejects(cycle(m.args), /on_unverified_stop/); assert.deepEqual(m.writes, [true]);
  }
});
test('stale matching readback cannot verify a command', async () => {
  let written = false;
  await assert.rejects(cycle({ expiresAt: start + 3600000, now: () => start, sleep: async () => {},
    client: { read: async () => ({ on: written, online: true, updatedAt: start - 60000 }), write: async () => { written = true; } } }), /on_unverified_stop/);
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
