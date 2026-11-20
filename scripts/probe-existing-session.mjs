// One bounded status read using the existing app-channel identity. No controls,
// client-ID changes, retries, redirects, raw responses, or credential output.
import { createHmac, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export class ProbeError extends Error {
  constructor(stage, kind, httpStatus = null, lgCode = null, restriction = null) {
    super('session_probe_failed');
    Object.assign(this, { stage, kind, httpStatus, lgCode, restriction });
  }
}

// Classify only known provider messages; never expose arbitrary upstream text.
export function restrictionKind(result) {
  if (typeof result !== 'string') return null;
  if (/temporarily blocked for 24 hours/i.test(result)) return 'temporary_24h_block';
  if (/consider using the (official|native) API/i.test(result)) return 'official_api_required';
  return null;
}

export async function readJSON(stage, url, options, fetcher, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { ...options, redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) throw new ProbeError(stage, 'redirect', response.status);
    if (Number(response.headers.get('content-length')) > 524288) throw new ProbeError(stage, 'body_too_large');
    const reader = response.body?.getReader();
    if (!reader) throw new ProbeError(stage, 'missing_body');
    let size = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 524288) {
        controller.abort();
        throw new ProbeError(stage, 'body_too_large');
      }
      chunks.push(Buffer.from(value));
    }
    let json;
    try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ProbeError(stage, 'invalid_json', response.status); }
    const code = typeof json?.resultCode === 'string' && /^\d{4}$/.test(json.resultCode) ? json.resultCode : null;
    const restriction = restrictionKind(json?.result);
    if (!response.ok) throw new ProbeError(stage, 'http', response.status, code, restriction);
    if (stage !== 'token' && code !== '0000') throw new ProbeError(stage, 'lg_response', response.status, code, restriction);
    return stage === 'token' ? json : json.result;
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw new ProbeError(stage, controller.signal.aborted ? 'timeout' : 'transport');
  } finally { clearTimeout(timer); }
}

export async function probe(env, fetcher = fetch, now = Date.now) {
  const required = ['REFRESH_TOKEN', 'OAUTH_URL', 'USER_NUMBER', 'CLIENT_ID', 'DEVICE_ID', 'SABBATH_CTRL'];
  if (required.some(key => !env['THINQ_V2_' + key])) throw new ProbeError('config', 'missing');
  const expires = Date.parse(env.SESSION_PROBE_EXPIRES_AT);
  if (!Number.isFinite(expires) || now() >= expires || expires - now() > 2 * 3600000) throw new ProbeError('config', 'expired');
  if (env.GITHUB_RUN_ATTEMPT !== '1') throw new ProbeError('config', 'rerun_blocked');
  if (env.THINQ_V2_OAUTH_URL.replace(/\/$/, '') !== 'https://us.lgeapi.com') throw new ProbeError('config', 'oauth_origin');
  let spec;
  try { spec = JSON.parse(env.THINQ_V2_SABBATH_CTRL); } catch { throw new ProbeError('config', 'invalid_spec'); }
  if (typeof spec.onValue !== 'string' || typeof spec.offValue !== 'string' || spec.onValue === spec.offValue) throw new ProbeError('config', 'invalid_spec');

  const headers = () => ({ Accept: 'application/json', 'Content-type': 'application/json;charset=UTF-8',
    'x-api-key': 'VGhpblEyLjAgU0VSVklDRQ==', 'x-client-id': env.THINQ_V2_CLIENT_ID,
    'x-country-code': 'US', 'x-language-code': 'en-US', 'x-message-id': randomUUID(),
    'x-service-code': 'SVC202', 'x-service-phase': 'OP', 'x-thinq-app-level': 'PRD',
    'x-thinq-app-os': 'ANDROID', 'x-thinq-app-type': 'NUTS', 'x-thinq-app-ver': '5.0.1200' });
  const gateway = await readJSON('gateway', 'https://route.lgthinq.com:46030/v1/service/application/gateway-uri', { method: 'GET', headers: headers() }, fetcher);
  let base;
  try { base = new URL(gateway.thinq2Uri); } catch { throw new ProbeError('gateway', 'invalid_origin'); }
  if (base.protocol !== 'https:' || !/^[a-z0-9-]+\.lgthinq\.com$/.test(base.hostname)
      || !['', '46030'].includes(base.port) || !/^\/v1\/?$/.test(base.pathname)
      || base.username || base.password || base.search || base.hash) throw new ProbeError('gateway', 'invalid_origin');
  const path = '/oauth/1.0/oauth2/token';
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.THINQ_V2_REFRESH_TOKEN }).toString();
  const date = new Date(now()).toUTCString().replace('GMT', '+0000');
  const token = await readJSON('token', 'https://us.lgeapi.com' + path, { method: 'POST', body, headers: {
    Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded',
    'x-lge-appkey': 'LGAO221A02', 'x-lge-oauth-date': date,
    'x-lge-oauth-signature': createHmac('sha1', 'c053c2a6ddeb7ad97cb0eed0dcb31cf8').update(`${path}?${body}\n${date}`).digest('base64'),
  } }, fetcher);
  if (typeof token.access_token !== 'string' || !token.access_token) throw new ProbeError('token', 'token_missing');
  if (now() >= expires) throw new ProbeError('config', 'expired');
  const result = await readJSON('dashboard', base.toString().replace(/\/$/, '') + '/service/application/dashboard', {
    method: 'GET', headers: { ...headers(), 'x-emp-token': token.access_token, 'x-user-no': env.THINQ_V2_USER_NUMBER },
  }, fetcher);
  if (!Array.isArray(result?.item)) throw new ProbeError('dashboard', 'invalid_devices');
  const matches = result.item.filter(device => device.deviceId === env.THINQ_V2_DEVICE_ID);
  if (matches.length !== 1 || Number(matches[0].deviceType) !== 101) throw new ProbeError('dashboard', 'target_mismatch');
  const device = matches[0];
  const value = device.snapshot?.refState?.sabbathMode;
  const rawTime = device.snapshot?.timestamp;
  const timestamp = typeof rawTime === 'number' ? rawTime : typeof rawTime === 'string' ? Date.parse(rawTime) : NaN;
  return { status: 'read_complete', configuredIdMatched: true, online: device.online === true,
    reportedMode: value === spec.onValue ? 'on' : value === spec.offValue ? 'off' : 'unknown',
    snapshotAgeMs: Number.isFinite(timestamp) ? now() - timestamp : null,
    controlRequests: 0, identityChanges: 0, automationReady: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await probe(process.env))); }
  catch (error) {
    console.log(JSON.stringify({ status: 'read_failed', stage: error instanceof ProbeError ? error.stage : 'unknown',
      kind: error instanceof ProbeError ? error.kind : 'unknown', httpStatus: error instanceof ProbeError ? error.httpStatus : null,
      lgCode: error instanceof ProbeError ? error.lgCode : null,
      restriction: error instanceof ProbeError ? error.restriction : null,
      controlRequests: 0, identityChanges: 0, automationReady: false }));
    process.exitCode = 1;
  }
}
