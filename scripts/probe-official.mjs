// Read-only diagnostic for LG ThinQ Connect. No control endpoint or POST exists here.
// Profile schema follows LG's thinq-connect/pythinqconnect SDK.
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const BASE = 'https://api-aic.lgthinq.com'; // US account, as configured for this household.
const API_KEY = 'v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3'; // Public LG SDK key, not a user credential.
const MAX_BYTES = 512 * 1024;
class ProbeError extends Error {
  constructor(reason, httpStatus = null) { super(reason); this.httpStatus = httpStatus; }
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function inspectSabbath(profile) {
  if (!object(profile) || !object(profile.property)) throw new ProbeError('invalid_profile');
  const spec = profile.property.sabbath?.sabbathMode;
  const absent = { present: false, readable: false, writable: false, enumPair: null };
  if (spec === undefined) return absent;
  if (typeof spec === 'string') return { ...absent, present: true, readable: true };
  if (!object(spec)) throw new ProbeError('invalid_sabbath_property');
  const modes = Array.isArray(spec.mode) ? spec.mode :
    ['r', 'w', 'rw', 'wr'].includes(spec.mode) ? [...spec.mode] : [];
  if (!modes.length || modes.some(mode => mode !== 'r' && mode !== 'w')) {
    throw new ProbeError('invalid_sabbath_modes');
  }
  const writable = modes.includes('w');
  const values = spec.value?.w;
  // Never infer ON/OFF from enum order or use a default value.
  const enumPair = spec.type === 'enum' && Array.isArray(values) &&
    values.length === 2 && values.includes('ON') && values.includes('OFF') ? 'ON_OFF' : null;
  return { present: true, readable: modes.includes('r'), writable,
    enumPair: writable ? enumPair : null };
}

// Decode only the representations declared by the official device profile.
// LG's refrigerator schema can use true/false, not only the app API's ON/OFF.
export function decodeSabbath(profile, state) {
  if (!inspectSabbath(profile).readable) return 'unknown';
  const spec = profile.property.sabbath.sabbathMode;
  const value = state?.sabbath?.sabbathMode;
  if (object(spec) && spec.type === 'boolean' && typeof value === 'boolean' &&
      Array.isArray(spec.value?.r) && spec.value.r.includes(value)) {
    return value ? 'on' : 'off';
  }
  if ((typeof spec === 'string' && value === spec) ||
      (object(spec) && spec.type === 'enum' && Array.isArray(spec.value?.r) && spec.value.r.includes(value))) {
    return value === 'ON' ? 'on' : value === 'OFF' ? 'off' : 'unknown';
  }
  return 'unknown';
}

function publicModelName(device) {
  // Manufacturer model only: never fall back to alias, ID, serial or arbitrary metadata.
  const name = device.deviceInfo?.modelName;
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(name) ? name : null;
}

export async function officialGet(path, cfg, fetcher = fetch, timeoutMs = 8000) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new ProbeError('request_timeout')); }, timeoutMs);
  });
  const operation = async () => {
    const res = await fetcher(BASE + path, {
      method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: { Authorization: `Bearer ${cfg.pat}`, 'x-country': 'US',
        'x-client-id': cfg.clientId, 'x-message-id': randomBytes(16).toString('base64url'),
        'x-api-key': API_KEY, 'x-service-phase': 'OP', Accept: 'application/json' }
    });
    if (!res.ok) {
      controller.abort();
      throw new ProbeError('http_rejected', Number.isInteger(res.status) ? res.status : null);
    }
    if (!res.body || Number(res.headers.get('content-length')) > MAX_BYTES) {
      controller.abort(); throw new ProbeError('invalid_response_size');
    }
    const reader = res.body.getReader(), chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) { controller.abort(); throw new ProbeError('invalid_response_size'); }
      chunks.push(Buffer.from(value));
    }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ProbeError('invalid_json'); }
    if (!object(payload) || payload.error || !Object.hasOwn(payload, 'response')) {
      throw new ProbeError('invalid_response');
    }
    return payload.response;
  };
  try { return await Promise.race([operation(), deadline]); }
  catch (error) {
    if (error instanceof ProbeError) throw error;
    throw new ProbeError('transport_failed'); // Never include upstream text, headers, IDs or credentials.
  } finally { clearTimeout(timer); controller.abort(); }
}

export async function probe(env, fetcher = fetch, timeoutMs = 8000) {
  let stage = 'configuration';
  const discovery = {};
  try {
    const cfg = { pat: env.THINQ_PAT?.trim(), clientId: env.THINQ_CLIENT_ID?.trim() };
    const id = env.THINQ_DEVICE_ID?.trim() || env.THINQ_V2_DEVICE_ID?.trim();
    if (!cfg.pat || !cfg.clientId || !id) throw new ProbeError('missing_official_configuration');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cfg.clientId)) {
      throw new ProbeError('invalid_client_id');
    }
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new ProbeError('invalid_device_id');
    stage = 'devices';
    const devices = await officialGet('/devices', cfg, fetcher, timeoutMs);
    if (!Array.isArray(devices)) throw new ProbeError('invalid_device_list');
    const refrigerators = devices.filter(device => device?.deviceInfo?.deviceType === 'DEVICE_REFRIGERATOR');
    discovery.deviceCount = devices.length;
    discovery.refrigeratorCount = refrigerators.length;
    const matches = devices.filter(device => device?.deviceId === id);
    let target = matches.length === 1 ? matches[0] : null;
    discovery.configuredIdMatched = target !== null;
    // Explicit diagnostic-only discovery may inspect the account's sole fridge.
    // It does not establish that this is the intended control target or save its ID.
    if (matches.length === 0 && env.THINQ_PROBE_DISCOVER === 'true' && refrigerators.length === 1) {
      target = refrigerators[0];
    }
    if (!target) throw new ProbeError('configured_device_not_uniquely_found');
    if (target.deviceInfo?.deviceType !== 'DEVICE_REFRIGERATOR') {
      throw new ProbeError('configured_device_not_refrigerator');
    }
    const targetId = target.deviceId;
    if (typeof targetId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(targetId)) {
      throw new ProbeError('invalid_discovered_device_id');
    }
    stage = 'profile';
    const profile = await officialGet(`/devices/${targetId}/profile`, cfg, fetcher, timeoutMs);
    const capability = inspectSabbath(profile);
    stage = 'state';
    const state = await officialGet(`/devices/${targetId}/state`, cfg, fetcher, timeoutMs);
    if (!object(state)) throw new ProbeError('invalid_state');
    return { event: 'official_probe', status: 'read_complete', controlRequests: 0,
      ...discovery, modelName: publicModelName(target), capability,
      reportedMode: decodeSabbath(profile, state),
      // A returned state has no established freshness guarantee. Do not use this as control authorization.
      freshnessVerified: false, automationReady: false };
  } catch (error) {
    return { event: 'official_probe', status: 'failed', stage, controlRequests: 0,
      ...discovery,
      reason: error instanceof ProbeError ? error.message : 'probe_failed',
      httpStatus: error instanceof ProbeError ? error.httpStatus : null };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await probe(process.env);
  console.log(JSON.stringify(result));
  if (result.status === 'failed') process.exitCode = 1;
}

