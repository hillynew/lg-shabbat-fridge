import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSabbath, decodeSabbath, probe } from '../scripts/probe-official.mjs';
const env = { THINQ_PAT: 'PRIVATE_TOKEN', THINQ_CLIENT_ID: '5fa84b81-6b41-4e3a-bbab-03ae4027cc92', THINQ_V2_DEVICE_ID: 'PRIVATE_DEVICE' };
const spec = { type: 'enum', mode: ['r', 'w'], value: { r: ['ON', 'OFF'], w: ['OFF', 'ON'] } };
const profile = value => ({ property: { sabbath: { sabbathMode: value } } });
const devices = [{ deviceId: env.THINQ_V2_DEVICE_ID, deviceInfo: { deviceType: 'DEVICE_REFRIGERATOR', alias: 'PRIVATE_ALIAS' } }];
function mock(responses, calls = []) { return async (url, opts) => {
  calls.push({ url, opts });
  const response = responses.shift();
  return response instanceof Response ? response : Response.json({ response });
}; }
test('reports exact read/write modes and known enum pair without order guessing', () => {
  assert.deepEqual(inspectSabbath(profile(spec)), { present: true, readable: true, writable: true, enumPair: 'ON_OFF' });
  assert.equal(inspectSabbath(profile({ ...spec, value: { w: ['NORMAL', 'SABBATH'] } })).enumPair, null);
});
test('write-looking enum values never override a read-only mode', () => {
  assert.equal(inspectSabbath(profile({ ...spec, mode: ['r'] })).writable, false);
  assert.equal(inspectSabbath(profile('ON')).writable, false);
  assert.equal(inspectSabbath({ property: {} }).present, false);
});
test('does not recursively mistake unrelated Sabbath fields for device capabilities', () => {
  assert.equal(inspectSabbath({ property: {}, unrelated: { sabbathMode: spec } }).present, false);
  for (const value of [null, [], {}, { property: null }]) assert.throws(() => inspectSabbath(value));
  for (const mode of [[], ['write'], 'overwrite', null]) assert.throws(() => inspectSabbath(profile({ ...spec, mode })));
});
test('missing configuration performs no request', async () => {
  const result = await probe({}, () => assert.fail());
  assert.equal(result.reason, 'missing_official_configuration');
});
test('invalid configured IDs stop before credentials are transmitted', async () => {
  for (const patch of [{ THINQ_CLIENT_ID: 'invalid' }, { THINQ_DEVICE_ID: '../other?secret' }]) {
    assert.equal((await probe({ ...env, ...patch }, () => assert.fail())).stage, 'configuration');
  }
});
test('exact device matching prevents selecting a different appliance', async () => {
  for (const list of [[], [devices[0], devices[0]], [{ ...devices[0], deviceId: 'another-fridge' }]]) {
    const calls = [];
    const result = await probe(env, mock([list], calls));
    assert.equal(result.reason, 'configured_device_not_uniquely_found');
    assert.equal(calls.length, 1);
  }
});
test('a non-refrigerator with the same ID is rejected', async () => {
  const result = await probe(env, mock([[{ deviceId: env.THINQ_V2_DEVICE_ID, deviceInfo: { deviceType: 'DEVICE_OVEN' } }]]));
  assert.equal(result.reason, 'configured_device_not_refrigerator');
});
test('explicit read-only discovery inspects a sole fridge but never confirms a control target', async () => {
  const calls = [];
  const result = await probe({ ...env, THINQ_PROBE_DISCOVER: 'true' }, mock([
    [{ ...devices[0], deviceId: 'DIFFERENT_PRIVATE_ID' }], profile(spec), { sabbath: { sabbathMode: 'OFF' } }
  ], calls));
  assert.equal(result.status, 'read_complete');
  assert.equal(result.configuredIdMatched, false);
  assert.equal(result.refrigeratorCount, 1);
  assert.equal(result.automationReady, false);
  assert.equal(result.controlRequests, 0);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.opts.method === 'GET'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
test('discovery never picks among multiple fridges or trusts an unsafe discovered ID', async () => {
  for (const list of [[], [{ ...devices[0], deviceId: 'fridge1' }, { ...devices[0], deviceId: 'fridge2' }],
    [{ ...devices[0], deviceId: '../PRIVATE_UNSAFE' }], [devices[0], devices[0]]]) {
    const calls = [];
    const result = await probe({ ...env, THINQ_PROBE_DISCOVER: 'true' }, mock([list], calls));
    assert.equal(result.status, 'failed');
    assert.equal(calls.length, 1);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});
test('all live operations are GET to the fixed LG origin and public output is redacted', async () => {
  const calls = [];
  const result = await probe(env, mock([devices, profile(spec), { sabbath: { sabbathMode: 'ON' }, secret: env.THINQ_PAT }], calls));
  assert.equal(result.status, 'read_complete');
  assert.equal(result.reportedMode, 'on');
  assert.equal(result.automationReady, false);
  assert.equal(result.freshnessVerified, false);
  assert.equal(calls.length, 3);
  for (const { url, opts } of calls) {
    assert.equal(new URL(url).origin, 'https://api-aic.lgthinq.com');
    assert.equal(opts.method, 'GET'); assert.equal(opts.redirect, 'manual');
    assert.equal(opts.headers['x-client-id'], env.THINQ_CLIENT_ID);
    assert.equal(opts.body, undefined);
  }
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
test('unknown state is not treated as OFF', async () => {
  const result = await probe(env, mock([devices, profile(spec), { sabbath: { sabbathMode: 'PRIVATE_UNKNOWN' } }]));
  assert.equal(result.reportedMode, 'unknown');
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
test('official boolean Sabbath state decodes without granting write access', async () => {
  const booleanSpec = { type: 'boolean', mode: ['r'], value: { r: [false, true] } };
  for (const [value, expected] of [[true, 'on'], [false, 'off']]) {
    const result = await probe(env, mock([devices, profile(booleanSpec), { sabbath: { sabbathMode: value } }]));
    assert.equal(result.reportedMode, expected);
    assert.equal(result.capability.writable, false);
    assert.equal(result.controlRequests, 0);
    assert.equal(result.automationReady, false);
    assert.equal(result.freshnessVerified, false);
  }
});
test('state decoding rejects coercion, mismatched schemas and undeclared values', () => {
  const booleanSpec = { type: 'boolean', mode: ['r'], value: { r: [false, true] } };
  for (const value of ['true', 'false', 'ON', 'OFF', 1, 0, null, undefined, {}, []]) {
    assert.equal(decodeSabbath(profile(booleanSpec), { sabbath: { sabbathMode: value } }), 'unknown');
  }
  assert.equal(decodeSabbath(profile(spec), { sabbath: { sabbathMode: false } }), 'unknown');
  assert.equal(decodeSabbath(profile({ ...booleanSpec, value: { r: [true] } }), { sabbath: { sabbathMode: false } }), 'unknown');
  assert.equal(decodeSabbath(profile({ ...booleanSpec, mode: ['w'] }), { sabbath: { sabbathMode: true } }), 'unknown');
  assert.equal(decodeSabbath(profile('ON'), { sabbath: { sabbathMode: 'OFF' } }), 'unknown');
  assert.equal(decodeSabbath(profile('ON'), { sabbath: { sabbathMode: 'ON' } }), 'on');
  assert.equal(decodeSabbath({ property: {} }, {}), 'unknown');
});
test('model diagnostics use only a bounded manufacturer model, never private aliases or IDs', async () => {
  const getResult = info => probe(env, mock([[{ ...devices[0], deviceInfo: { ...devices[0].deviceInfo, ...info } }], profile(spec), {}]));
  assert.equal((await getResult({ modelName: 'LRFVC2406S.ASTCNA0' })).modelName, 'LRFVC2406S.ASTCNA0');
  for (const value of [undefined, null, '', 'private home address', 'secret\nline', 'x'.repeat(81), { private: true }]) {
    const result = await getResult({ modelName: value, serialNumber: 'PRIVATE_SERIAL' });
    assert.equal(result.modelName, null);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});
test('redirects and denial stop without retry, alternate identity or leaked response', async () => {
  for (const status of [302, 400, 401, 403, 429, 500]) {
    const calls = [];
    const result = await probe(env, mock([new Response('PRIVATE_TOKEN', { status, headers: { Location: 'https://untrusted.test' } })], calls));
    assert.equal(result.httpStatus, status); assert.equal(calls.length, 1);
    assert.equal(result.controlRequests, 0); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});
test('timeout covers fetch and a stalled response body', async () => {
  const hangingFetch = () => new Promise(() => {});
  const hangingBody = () => Promise.resolve(new Response(new ReadableStream({ start() {} })));
  for (const fetcher of [hangingFetch, hangingBody]) {
    assert.equal((await probe(env, fetcher, 10)).reason, 'request_timeout');
  }
});
test('oversized, malformed and application-error responses fail without raw output', async () => {
  for (const response of [new Response('x'.repeat(512 * 1024 + 1)), new Response('PRIVATE_NOT_JSON'),
    Response.json({ error: { message: 'PRIVATE_TOKEN' } }), Response.json({ response: null })]) {
    const result = await probe(env, mock([response]));
    assert.equal(result.status, 'failed'); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});

