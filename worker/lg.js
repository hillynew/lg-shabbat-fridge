// Minimal runtime-only LG app-channel adapter. No login/password flow or process.env.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { requestJson } from './http.js';
const gatewayURL = 'https://route.lgthinq.com:46030/v1/service/application/gateway-uri';
const authPath = '/oauth/1.0/oauth2/token';
const publicAppKey = 'LGAO221A02';
const publicSigningKey = 'c053c2a6ddeb7ad97cb0eed0dcb31cf8';

function lgURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password
      || !['lgthinq.com', 'lge.com', 'lgecloud.com', 'lgaccount.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) throw new Error('lg_host_invalid');
  if (url.search || url.hash) throw new Error('lg_host_invalid');
  return url.toString().replace(/\/$/, '');
}
function oauthURL(value) {
  const url = new URL(value);
  if (url.hostname !== 'us.lgeapi.com') return lgURL(value);
  if (url.protocol !== 'https:' || url.port || url.pathname !== '/'
      || url.username || url.password || url.search || url.hash) throw new Error('lg_host_invalid');
  return url.origin;
}
function unwrap(json) {
  if (json?.resultCode !== '0000') {
    const error = new Error('lg_response_error');
    error.lgCode = json?.resultCode;
    throw error;
  }
  return json.result;
}
export function createLG(env, request = requestJson, observe = () => {}) {
  for (const key of ['THINQ_V2_REFRESH_TOKEN', 'THINQ_V2_OAUTH_URL', 'THINQ_V2_USER_NUMBER', 'THINQ_V2_DEVICE_ID', 'THINQ_V2_CLIENT_ID', 'THINQ_V2_SABBATH_CTRL']) {
    if (!env[key]) throw new Error('lg_config_missing');
  }
  const oauth = oauthURL(env.THINQ_V2_OAUTH_URL);
  const spec = JSON.parse(env.THINQ_V2_SABBATH_CTRL);
  const ctrl = spec?.ctrl;
  if (!spec?.controllable || spec.onValue == null || spec.offValue == null || spec.onValue === spec.offValue
      || !ctrl?.command || !ctrl?.ctrlKey || !Array.isArray(ctrl.templateKeys)
      || !ctrl.templateKeys.includes('sabbathMode') || !Array.isArray(ctrl.path) || !ctrl.path.length
      || [...ctrl.templateKeys, ...ctrl.path].some(k => typeof k !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(k))) throw new Error('lg_control_invalid');
  let session;
  let clientId = env.THINQ_V2_CLIENT_ID;
  const headers = () => ({ Accept: 'application/json', 'Content-type': 'application/json;charset=UTF-8',
    'x-api-key': 'VGhpblEyLjAgU0VSVklDRQ==', 'x-client-id': clientId,
    'x-country-code': 'US', 'x-language-code': 'en-US', 'x-message-id': randomUUID(),
    'x-service-code': 'SVC202', 'x-service-phase': 'OP', 'x-thinq-app-level': 'PRD',
    'x-thinq-app-os': 'ANDROID', 'x-thinq-app-type': 'NUTS', 'x-thinq-app-ver': '5.0.1200' });
  async function stageRequest(stage, url, options) {
    try { return await request(url, options); }
    catch (error) {
      observe(JSON.stringify({ event: 'lg_request_failed', stage,
        reason: ['transport', 'http', 'body', 'timeout'].includes(error?.kind) ? error.kind : 'unknown',
        httpStatus: Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? error.httpStatus : null }));
      throw new Error('lg_' + stage + '_request_failed');
    }
  }
  async function connect() {
    if (session) return session;
    const gateway = unwrap(await stageRequest('gateway', gatewayURL, { headers: headers() }));
    const base = lgURL(gateway.thinq2Uri);
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.THINQ_V2_REFRESH_TOKEN }).toString();
    const date = new Date().toUTCString().replace('GMT', '+0000');
    const token = await stageRequest('token', oauth + authPath, { method: 'POST', body, headers: {
      Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded',
      'x-lge-appkey': publicAppKey, 'x-lge-oauth-date': date,
      'x-lge-oauth-signature': createHmac('sha1', publicSigningKey).update(`${authPath}?${body}\n${date}`).digest('base64'),
    } });
    if (!token.access_token) throw new Error('lg_auth_failed');
    session = { base, token: token.access_token };
    return session;
  }
  async function api(path, payload, rotated = false) {
    const { base, token } = await connect();
    try { return unwrap(await stageRequest(payload ? 'write' : 'dashboard', `${base}/${path}`,  { method: payload ? 'POST' : 'GET',
      headers: { ...headers(), 'x-emp-token': token, 'x-user-no': env.THINQ_V2_USER_NUMBER,
        ...(payload ? { 'x-thinq-security-key': 'nuts_securitykey' } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}) }));
    } catch (error) {
      // Only explicit rejection codes permit one retry. Never retry uncertain writes.
      if (!rotated && ['9006', '9012'].includes(error.lgCode)) {
        clientId = createHash('sha256').update(env.THINQ_V2_USER_NUMBER + String(Date.now())).digest('hex');
        return api(path, payload, true);
      }
      throw error;
    }
  }
  return {
    async read() {
      const result = await api('service/application/dashboard');
      const device = result?.item?.find(d => d.deviceId === env.THINQ_V2_DEVICE_ID);
      const value = device?.snapshot?.refState?.sabbathMode;
      const rawTime = device?.snapshot?.timestamp;
      const updatedAt = typeof rawTime === 'number' ? rawTime : typeof rawTime === 'string' ? Date.parse(rawTime) : NaN;
      observe(JSON.stringify({ event: 'lg_read_metadata', deviceFound: !!device,
        onlineType: typeof device?.online, online: device?.online === true,
        modeType: typeof value, mode: value === spec.onValue ? 'on' : value === spec.offValue ? 'off' : 'unknown',
        timestampType: typeof rawTime, timestampValid: Number.isFinite(updatedAt),
        ageMs: Number.isFinite(updatedAt) ? Date.now() - updatedAt : null }));
      return { on: value === spec.onValue ? true : value === spec.offValue ? false : null,
        online: device?.online === true, updatedAt };
    },
    async write(on) {
      let data = Object.fromEntries(ctrl.templateKeys.map(k => [k, k === 'sabbathMode' ? (on ? spec.onValue : spec.offValue) : 'IGNORE']));
      for (const key of [...ctrl.path].reverse()) data = { [key]: data };
      await api(`service/devices/${encodeURIComponent(env.THINQ_V2_DEVICE_ID)}/control-sync`, {
        ctrlKey: ctrl.ctrlKey, command: ctrl.command, dataSetList: data,
      });
    },
  };
}
