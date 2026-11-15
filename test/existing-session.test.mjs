import test from 'node:test';
import assert from 'node:assert/strict';
import { probe, readJSON } from '../scripts/probe-existing-session.mjs';

const now = Date.parse('2026-11-15T23:00:00Z');
const env = { THINQ_V2_REFRESH_TOKEN: 'private-refresh', THINQ_V2_OAUTH_URL: 'https://us.lgeapi.com',
  THINQ_V2_USER_NUMBER: 'private-user', THINQ_V2_CLIENT_ID: 'existing-client', THINQ_V2_DEVICE_ID: 'private-device',
  THINQ_V2_SABBATH_CTRL: JSON.stringify({ onValue: 'ON', offValue: 'OFF' }),
  SESSION_PROBE_EXPIRES_AT: '2026-11-16T00:00:00Z', GITHUB_RUN_ATTEMPT: '1' };
const ok = result => ({ resultCode: '0000', result });
const dashboard = value => ok({ item: [{ deviceId: env.THINQ_V2_DEVICE_ID, deviceType: 101, online: true,
  snapshot: { timestamp: now, refState: { sabbathMode: value } } }] });
function mock(last = dashboard('OFF')) {
  const calls = [];
  const responses = [ok({ thinq2Uri: 'https://aic-service.lgthinq.com:46030/v1' }), { access_token: 'private-access' }, last];
  return { calls, fetcher: async (url, opts) => {
    calls.push({ url, opts });
    const r = responses.shift();
    return r instanceof Response ? r : Response.json(r);
  } };
}
test('uses three bounded requests, the existing identity, and no appliance control', async () => {
  const m = mock(); const result = await probe(env, m.fetcher, () => now);
  assert.equal(result.reportedMode, 'off'); assert.equal(result.controlRequests, 0); assert.equal(m.calls.length, 3);
  assert.deepEqual(m.calls.map(c => c.opts.method), ['GET', 'POST', 'GET']);
  assert.ok(m.calls.every(c => c.opts.redirect === 'manual' && c.opts.signal));
  assert.equal(m.calls[2].opts.headers['x-client-id'], env.THINQ_V2_CLIENT_ID);
  assert.ok(m.calls[1].url.endsWith('/oauth/1.0/oauth2/token'));
  assert.ok(!JSON.stringify(result).includes('private-'));
});
test('HTTP 400 / LG 9006 ends without a retry or identity change', async () => {
  const m = mock(Response.json({ resultCode: '9006', result: 'private-error' }, { status: 400 }));
  await assert.rejects(probe(env, m.fetcher, () => now), e => e.kind === 'http' && e.lgCode === '9006' && !e.message.includes('private'));
  assert.equal(m.calls.length, 3);
});
test('successful HTTP response with LG rejection also ends without retry', async () => {
  const m = mock({ resultCode: '9012', result: 'private-error' });
  await assert.rejects(probe(env, m.fetcher, () => now), e => e.lgCode === '9012'); assert.equal(m.calls.length, 3);
});
test('expired, repeated, incomplete, and unsafe requests never leave the process', async () => {
  for (const overrides of [{ SESSION_PROBE_EXPIRES_AT: '2026-11-15T22:00:00Z' }, { GITHUB_RUN_ATTEMPT: '2' },
    { THINQ_V2_CLIENT_ID: '' }, { THINQ_V2_OAUTH_URL: 'https://us.lgeapi.com.evil.example' },
    { THINQ_V2_SABBATH_CTRL: '{}' }]) {
    await assert.rejects(probe({ ...env, ...overrides }, () => assert.fail('network attempted'), () => now));
  }
});
test('invalid gateway cannot receive the token', async () => {
  let count = 0;
  await assert.rejects(probe(env, async () => { count++; return Response.json(ok({ thinq2Uri: 'https://evil.example/v1' })); }, () => now));
  assert.equal(count, 1);
});
test('redirect stops without following it', async () => {
  const m = mock(new Response('', { status: 302, headers: { location: 'https://evil.example' } }));
  await assert.rejects(probe(env, m.fetcher, () => now), e => e.kind === 'redirect'); assert.equal(m.calls.length, 3);
});
test('unknown Sabbath values remain unknown', async () => {
  const m = mock(dashboard('UNRECOGNIZED')); assert.equal((await probe(env, m.fetcher, () => now)).reportedMode, 'unknown');
});
test('missing target cannot select a different fridge', async () => {
  const m = mock(ok({ item: [{ deviceId: 'different', deviceType: 101 }] }));
  await assert.rejects(probe(env, m.fetcher, () => now), e => e.kind === 'target_mismatch');
});
test('oversized and malformed responses stop with redacted errors', async () => {
  await assert.rejects(readJSON('dashboard', 'https://example.test', {}, async () => new Response('x'.repeat(524289))), e => e.kind === 'body_too_large');
  await assert.rejects(readJSON('dashboard', 'https://example.test', {}, async () => new Response('private-not-json')), e => e.kind === 'invalid_json' && !e.message.includes('private'));
});
test('deadline covers a stalled request', async () => {
  await assert.rejects(readJSON('dashboard', 'https://example.test', {}, async (_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new Error('private-timeout')));
  }), 10), e => e.kind === 'timeout');
});
