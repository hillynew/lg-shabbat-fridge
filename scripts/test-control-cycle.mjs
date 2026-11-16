// Temporary commissioning test; never used by a scheduler. Only an OFF fridge
// is eligible. Turn ON once, require a newer readback, then restore OFF once.
//
// LG answers some app-channel requests with 9006/9012 ("consider using the
// official API"). As in the original controller (src/thinqV2.js) and upstream
// wideq, such a rejection is answered by minting a fresh client id and
// repeating that one request once. Rotations are capped per run.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readJSON, ProbeError } from './probe-existing-session.mjs';

export function controlSpec(value) {
  let spec;
  try { spec = JSON.parse(value); } catch { throw new Error('invalid_control_spec'); }
  const c = spec?.ctrl;
  const safe = key => typeof key === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) && !['constructor', 'prototype', '__proto__'].includes(key);
  if (spec?.controllable !== true || c?.command !== 'Set' || c?.ctrlKey !== 'basicCtrl'
    || !Array.isArray(c.path) || !c.path.length || c.path.length > 4 || !c.path.every(safe)
    || !Array.isArray(c.templateKeys) || !c.templateKeys.includes('sabbathMode') || !c.templateKeys.every(safe)
    || typeof spec.onValue !== 'string' || typeof spec.offValue !== 'string'
    || spec.onValue === spec.offValue || spec.onValue.length > 64 || spec.offValue.length > 64) throw new Error('invalid_control_spec');
  return spec;
}
export function controlPayload(spec, on) {
  let data = Object.fromEntries(spec.ctrl.templateKeys.map(key => [key, key === 'sabbathMode' ? (on ? spec.onValue : spec.offValue) : 'IGNORE']));
  for (const key of [...spec.ctrl.path].reverse()) data = { [key]: data };
  return { ctrlKey: 'basicCtrl', command: 'Set', dataSetList: data };
}

export const MAX_ROTATIONS = 3;
export async function createClient(env, fetcher = fetch, now = Date.now, observe = () => {}) {
  for (const key of ['REFRESH_TOKEN', 'OAUTH_URL', 'USER_NUMBER', 'CLIENT_ID', 'DEVICE_ID', 'SABBATH_CTRL']) {
    if (!env['THINQ_V2_' + key]) throw new Error('config_missing');
  }
  const spec = controlSpec(env.THINQ_V2_SABBATH_CTRL);
  if (env.THINQ_V2_OAUTH_URL.replace(/\/$/, '') !== 'https://us.lgeapi.com') throw new Error('oauth_origin_invalid');
  let clientId = env.THINQ_V2_CLIENT_ID;
  let rotations = 0;
  const headers = () => ({ Accept: 'application/json', 'Content-type': 'application/json;charset=UTF-8',
    'x-api-key': 'VGhpblEyLjAgU0VSVklDRQ==', 'x-client-id': clientId,
    'x-country-code': 'US', 'x-language-code': 'en-US', 'x-message-id': randomUUID(),
    'x-service-code': 'SVC202', 'x-service-phase': 'OP', 'x-thinq-app-level': 'PRD',
    'x-thinq-app-os': 'ANDROID', 'x-thinq-app-type': 'NUTS', 'x-thinq-app-ver': '5.0.1200' });
  const gateway = await readJSON('gateway', 'https://route.lgthinq.com:46030/v1/service/application/gateway-uri', { method: 'GET', headers: headers() }, fetcher);
  const base = new URL(gateway.thinq2Uri);
  if (base.protocol !== 'https:' || !/^[a-z0-9-]+\.lgthinq\.com$/.test(base.hostname)
    || !['', '46030'].includes(base.port) || !/^\/v1\/?$/.test(base.pathname)
    || base.username || base.password || base.search || base.hash) throw new Error('gateway_origin_invalid');
  const path = '/oauth/1.0/oauth2/token';
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.THINQ_V2_REFRESH_TOKEN }).toString();
  const date = new Date(now()).toUTCString().replace('GMT', '+0000');
  const token = await readJSON('token', 'https://us.lgeapi.com' + path, { method: 'POST', body, headers: {
    Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded',
    'x-lge-appkey': 'LGAO221A02', 'x-lge-oauth-date': date,
    'x-lge-oauth-signature': createHmac('sha1', 'c053c2a6ddeb7ad97cb0eed0dcb31cf8').update(`${path}?${body}\n${date}`).digest('base64'),
  } }, fetcher);
  if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('token_missing');
  const authenticated = () => ({ ...headers(), 'x-emp-token': token.access_token, 'x-user-no': env.THINQ_V2_USER_NUMBER });
  const origin = base.toString().replace(/\/$/, '');
  let writes = 0;
  let identified = false;
  // One request; on an explicit 9006/9012 rejection (which means LG did not
  // act on it) rotate the client id and repeat it exactly once.
  const call = async (stage, url, options) => {
    try { return await readJSON(stage, url, options(), fetcher); } catch (error) {
      if (!(error instanceof ProbeError) || !['9006', '9012'].includes(error.lgCode) || rotations >= MAX_ROTATIONS) throw error;
      rotations++;
      clientId = createHash('sha256').update(String(env.THINQ_V2_USER_NUMBER) + String(now()) + randomUUID()).digest('hex');
      observe({ event: 'identity_rotated', stage, lgCode: error.lgCode, rotations });
      return await readJSON(stage, url, options(), fetcher);
    }
  };
  const stateOf = d => {
    const raw = d.snapshot?.timestamp, mode = d.snapshot?.refState?.sabbathMode;
    return { on: mode === spec.onValue ? true : mode === spec.offValue ? false : null, online: d.online === true,
      updatedAt: typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : NaN };
  };
  return {
    async read() {
      const result = await call('dashboard', origin + '/service/application/dashboard', () => ({ method: 'GET', headers: authenticated() }));
      const matches = result?.item?.filter(d => d.deviceId === env.THINQ_V2_DEVICE_ID) || [];
      if (matches.length !== 1 || Number(matches[0].deviceType) !== 101) throw new Error('target_mismatch');
      identified = true;
      return stateOf(matches[0]);
    },
    async write(on) {
      if (++writes > 2 || on !== (writes === 1)) throw new Error('additional_control_blocked');
      await call('control', origin + '/service/devices/' + encodeURIComponent(env.THINQ_V2_DEVICE_ID) + '/control-sync', () => ({
        method: 'POST', headers: { ...authenticated(), 'x-thinq-security-key': 'nuts_securitykey' }, body: JSON.stringify(controlPayload(spec, on)),
      }));
    },
  };
}

export const VERIFY_ATTEMPTS = 19;
export const VERIFY_INTERVAL_MS = 5000;
export async function cycle({ client, expiresAt, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), observe = () => {} }) {
  const initialNow = now();
  if (!Number.isFinite(expiresAt) || expiresAt - initialNow < 120000 || expiresAt - initialNow > 2 * 3600000) throw new Error('test_expired');
  const initial = await client.read();
  observe({ event: 'initial_state', mode: initial.on === true ? 'on' : initial.on === false ? 'off' : 'unknown',
    online: initial.online === true, snapshotAgeMs: Number.isFinite(initial.updatedAt) ? now() - initial.updatedAt : null });
  // The snapshot timestamp only moves when the fridge reports, so its age is
  // logged but not required to be recent. Command verification below never
  // relies on it: it demands a snapshot newer than the one read here.
  if (initial.on !== false || initial.online !== true || !Number.isFinite(initial.updatedAt)) throw new Error('initial_off_not_confirmed');
  const rejected = error => error instanceof ProbeError && (error.kind === 'http' || error.kind === 'lg_response' || error.kind === 'redirect');
  let prior = initial;
  let commands = 0;
  const command = async desired => {
    commands++;
    observe({ event: 'control_attempt', desired: desired ? 'on' : 'off', commands });
    let accepted = true;
    try { await client.write(desired); } catch (error) {
      if (rejected(error)) throw error;
      accepted = false; // unknown outcome: resolved by readback, never resent
    }
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
      if (attempt) await sleep(VERIFY_INTERVAL_MS);
      try {
        const state = await client.read();
        if (state.on === desired && state.online === true && Number.isFinite(state.updatedAt) && state.updatedAt > prior.updatedAt) {
          prior = state;
          observe({ event: 'mode_verified', mode: desired ? 'on' : 'off', responseAccepted: accepted, commands, afterMs: attempt * VERIFY_INTERVAL_MS });
          return true;
        }
      } catch (error) {
        // A rejected read is not a reason to keep querying the blocked endpoint.
        if (rejected(error)) throw error;
      }
    }
    return false;
  };
  if (now() >= expiresAt - 60000) throw new Error('test_expired');
  if (!await command(true)) {
    // ON was sent but never confirmed. Send the single OFF anyway so the
    // fridge is not left in Sabbath mode on an ordinary day.
    let restored = false;
    try { restored = await command(false); } catch {}
    throw new Error(restored ? 'on_unverified_off_restored' : 'on_unverified_off_unverified');
  }
  await sleep(2000);
  if (!await command(false)) throw new Error('off_unverified_stop');
  return { status: 'on_off_verified', finalMode: 'off', controlRequests: commands, automationReady: false };
}

const allowed = new Set(['invalid_control_spec', 'config_missing', 'oauth_origin_invalid', 'gateway_origin_invalid', 'token_missing',
  'target_mismatch', 'test_expired', 'initial_off_not_confirmed', 'on_unverified_off_restored', 'on_unverified_off_unverified', 'off_unverified_stop', 'rerun_blocked']);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.env.GITHUB_RUN_ATTEMPT !== '1') throw new Error('rerun_blocked');
    const expiresAt = Date.parse(process.env.CONTROL_TEST_EXPIRES_AT);
    if (!Number.isFinite(expiresAt) || expiresAt - Date.now() < 120000 || expiresAt - Date.now() > 2 * 3600000) throw new Error('test_expired');
    const observe = event => console.log(JSON.stringify(event));
    const client = await createClient(process.env, fetch, Date.now, observe);
    console.log(JSON.stringify(await cycle({ client, expiresAt, observe })));
  } catch (error) {
    console.log(JSON.stringify({ status: 'test_failed', reason: allowed.has(error.message) ? error.message : error instanceof ProbeError ? 'lg_request_failed' : 'unknown',
      stage: error instanceof ProbeError ? error.stage : null, httpStatus: error instanceof ProbeError ? error.httpStatus : null,
      lgCode: error instanceof ProbeError ? error.lgCode : null,
      restriction: error instanceof ProbeError ? error.restriction : null, automationReady: false }));
    process.exitCode = 1;
  }
}
