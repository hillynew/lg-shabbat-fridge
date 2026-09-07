// LG's official open API (ThinQ Connect, launched Dec 2024):
//   Base:  https://api-aic.lgthinq.com   (aic = Americas region; US accounts)
//   Auth:  Authorization: Bearer <PAT>   (Personal Access Token generated
//          once at https://connect-pat.lgthinq.com with an LG account — the
//          same login as the ThinQ phone app)
//   Plus LG's required envelope headers: x-api-key is a fixed public value
//   published in LG's own SDK (github.com/thinq-connect/pythinqconnect),
//   x-client-id is any UUID, x-message-id is a 22-char base64url nonce.
//
// Whether sabbathMode is WRITABLE over this API varies by fridge model —
// some panels only allow the physical Freezer+WiFi button combo. Never
// assume: probeDevice() reads the device's profile and reports whether the
// property is writable, and what ON/OFF actually look like on the wire.

import crypto from 'node:crypto';

const BASE = 'https://api-aic.lgthinq.com';
// Public constant from LG's official SDK — identifies the ThinQ Connect
// service tier, not a secret.
const THINQ_API_KEY = 'v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3';

export function officialConfigFromEnv() {
  return {
    pat: process.env.THINQ_PAT || null,
    clientId: process.env.THINQ_CLIENT_ID || crypto.randomUUID(),
    deviceId: process.env.THINQ_DEVICE_ID || null,
    onValue: process.env.THINQ_SABBATH_ON_VALUE || null,
    offValue: process.env.THINQ_SABBATH_OFF_VALUE || null,
  };
}

// True once a probe has confirmed this model lets the official API write
// Sabbath mode (env has a PAT, a device, and both probed values).
export function officialWritable(cfg) {
  return !!(cfg.pat && cfg.deviceId && cfg.onValue && cfg.offValue);
}

async function thinqRequest(method, path, { pat, clientId, body } = {}) {
  if (!pat) throw new Error('THINQ_PAT not set');
  const headers = {
    Authorization: `Bearer ${pat}`,
    'x-country': 'US',
    'x-message-id': crypto.randomBytes(16).toString('base64url').slice(0, 22),
    'x-client-id': clientId || crypto.randomUUID(),
    'x-api-key': THINQ_API_KEY,
    'x-service-phase': 'OP',
    'Content-Type': 'application/json',
  };
  // Conditional control = LG rejects the command instead of queueing it
  // when the appliance is unreachable, so failures surface immediately.
  if (method === 'POST' && path.endsWith('/control')) headers['x-conditional-control'] = 'true';
  const res = await fetch(`${BASE}/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    const err = data?.error;
    const detail = err ? `${err.code || ''} ${err.message || ''}`.trim() : text.slice(0, 200);
    if (res.status === 401 || res.status === 403) {
      throw new Error(`LG ThinQ rejected the token (${res.status}${detail ? `: ${detail}` : ''}). Re-generate the PAT at connect-pat.lgthinq.com.`);
    }
    throw new Error(`LG ThinQ ${path}: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  // Responses are wrapped: { messageId, timestamp, response: <payload> }
  return data?.response ?? data;
}

export async function listDevices(cfg) {
  const r = await thinqRequest('GET', 'devices', cfg);
  const arr = Array.isArray(r) ? r : [];
  return arr.map((d) => ({
    device_id: d.deviceId,
    alias: d.deviceInfo?.alias || d.deviceInfo?.modelName || d.deviceId,
    type: d.deviceInfo?.deviceType || '',
    model: d.deviceInfo?.modelName || '',
    reportable: !!d.deviceInfo?.reportable,
  }));
}

// Depth-first search for a property spec keyed `name` anywhere in the
// device profile. Fridge profiles nest properties under "property" and can
// wrap location-scoped chunks in arrays, so walk generically instead of
// hardcoding a path.
function findPropertySpec(node, name) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findPropertySpec(item, name);
      if (hit) return hit;
    }
    return null;
  }
  if (node[name] && typeof node[name] === 'object') return node[name];
  for (const v of Object.values(node)) {
    const hit = findPropertySpec(v, name);
    if (hit) return hit;
  }
  return null;
}

// Derive { writable, onValue, offValue } from a sabbathMode property spec.
// LG expresses writability as mode:['r','w'] or a value.w array; the value
// type is either boolean or an ON/OFF enum depending on model.
function sabbathSpecFromProfile(profile) {
  const spec = findPropertySpec(profile, 'sabbathMode');
  if (!spec) return { present: false, writable: false };
  const writableValues = Array.isArray(spec.value?.w) ? spec.value.w : null;
  const writable = (writableValues && writableValues.length > 0)
    || (Array.isArray(spec.mode) && spec.mode.includes('w'));
  let onValue = true;
  let offValue = false;
  const type = String(spec.type || '').toLowerCase();
  if (writableValues && typeof writableValues[0] === 'string') {
    onValue = writableValues.find((v) => /on/i.test(v)) ?? writableValues[0];
    offValue = writableValues.find((v) => /off/i.test(v)) ?? writableValues[writableValues.length - 1];
  } else if (type === 'enum') {
    onValue = 'ON'; offValue = 'OFF';
  }
  return { present: true, writable, type: spec.type || null, onValue, offValue };
}

// Fetch a device's profile and extract the Sabbath-mode capability.
export async function probeDevice(deviceId, cfg) {
  const profile = await thinqRequest('GET', `devices/${deviceId}/profile`, cfg);
  return sabbathSpecFromProfile(profile);
}

// Flip Sabbath mode. Refuses to guess if the device was never probed.
export async function setSabbathMode(on, cfg) {
  if (!cfg.deviceId) throw new Error('THINQ_DEVICE_ID not set');
  if (!cfg.onValue || !cfg.offValue) throw new Error('THINQ_SABBATH_ON_VALUE / THINQ_SABBATH_OFF_VALUE not set — rerun `npm run setup:official`');
  const value = on ? cfg.onValue : cfg.offValue;
  await thinqRequest('POST', `devices/${cfg.deviceId}/control`, {
    ...cfg,
    body: { sabbath: { sabbathMode: value } },
  });
  return { device_id: cfg.deviceId, sabbathMode: value };
}

// Read back the device state (sanity check / idempotency guard).
export async function getSabbathState(cfg) {
  if (!cfg.deviceId) throw new Error('THINQ_DEVICE_ID not set');
  const state = await thinqRequest('GET', `devices/${cfg.deviceId}/state`, cfg);
  const flat = (function scan(n) {
    if (!n || typeof n !== 'object') return undefined;
    if (Array.isArray(n)) { for (const i of n) { const v = scan(i); if (v !== undefined) return v; } return undefined; }
    if ('sabbathMode' in n && typeof n.sabbathMode !== 'object') return n.sabbathMode;
    for (const v of Object.values(n)) { const hit = scan(v); if (hit !== undefined) return hit; }
    return undefined;
  })(state);
  return { sabbathMode: flat ?? null };
}
