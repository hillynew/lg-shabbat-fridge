// LG ThinQ v2 ("app channel") client — the private API the ThinQ phone app
// uses. Plan B for Sabbath mode: some fridges declare sabbathMode read-only
// on the official ThinQ Connect API (thinqOfficial.js) but the phone app
// shows a working toggle — meaning the write exists on this channel. Ported
// from ollo69/ha-smartthinq-sensors (wideq/core_async.py), the most
// battle-tested open implementation; every constant below (app keys,
// signature secret, header set) comes from there verbatim and is public
// (shipped inside the ThinQ Android app), never secret.
//
// Auth model: sign in ONCE (email+password, or a browser hand-off for
// Google/Apple/Amazon/Facebook LG accounts) and keep only the resulting
// refresh token — no LG password is ever persisted anywhere. Access tokens
// are minted from the refresh token on demand.
//
// Control model: each device's "model JSON" (modelJsonUri from the
// dashboard) declares MonitoringValue.sabbathMode (enum mapping) and
// ControlWifi command templates. A Sabbath command is only ever sent after
// probing that the model JSON actually carries sabbathMode.

import crypto from 'node:crypto';

// ---- constants from wideq (all public, shipped in the ThinQ app) ----
const V2_API_KEY = 'VGhpblEyLjAgU0VSVklDRQ==';
const V2_CLIENT_ID_DEFAULT = 'c713ea8e50f657534ff8b9d373dfebfc2ed70b88285c26b8ade49868c0b164d9';
const V2_GATEWAY_URL = 'https://route.lgthinq.com:46030/v1/service/application/gateway-uri';
const V2_AUTH_PATH = '/oauth/1.0/oauth2/token';
const V2_USER_INFO = '/users/profile';
const V2_EMP_SESS_URL = 'https://emp-oauth.lgecloud.com/emp/oauth2/token/empsession';
const OAUTH_LOGIN_HOST = 'us.m.lgaccount.com';
const CLIENT_ID = 'LGAO221A02';
const OAUTH_CLIENT_KEY = 'LGAO722A02';
const OAUTH_SECRET_KEY = 'c053c2a6ddeb7ad97cb0eed0dcb31cf8';
const APPLICATION_KEY = '6V1V8H2BN5P9ZQGOI5DAQ92YZBDO3EK9';
const EMP_REDIRECT_URL = 'lgaccount.lgsmartthinq:/';
const SECURITY_KEY = 'nuts_securitykey';
const SVC_CODE = 'SVC202';
const THIRD_PART_LOGIN = { GGL: 'google', AMZ: 'amazon', FBK: 'facebook', APPL: 'apple' };
const COUNTRY = 'US';
const LANGUAGE = 'en-US';
const LABEL_ON = '@CP_ON_EN_W';
const LABEL_OFF = '@CP_OFF_EN_W';
const DEVICE_TYPE_REFRIGERATOR = 101;

// "%a, %d %b %Y %H:%M:%S +0000" — LG's oauth signature timestamp format.
function lgTimestamp() {
  const d = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

function oauthSignature(message, secret) {
  return crypto.createHmac('sha1', secret).update(message, 'utf8').digest('base64');
}

function thinq2Headers({ accessToken, userNumber, clientId } = {}) {
  const h = {
    Accept: 'application/json',
    'Content-type': 'application/json;charset=UTF-8',
    'x-api-key': V2_API_KEY,
    'x-client-id': clientId || V2_CLIENT_ID_DEFAULT,
    'x-country-code': COUNTRY,
    'x-language-code': LANGUAGE,
    'x-message-id': crypto.randomUUID(),
    'x-service-code': SVC_CODE,
    'x-service-phase': 'OP',
    'x-thinq-app-level': 'PRD',
    'x-thinq-app-os': 'ANDROID',
    'x-thinq-app-type': 'NUTS',
    'x-thinq-app-ver': '5.0.1200',
  };
  if (accessToken) h['x-emp-token'] = accessToken;
  if (userNumber) h['x-user-no'] = userNumber;
  return h;
}

// resultCode '0000' → result; anything else is an LG error worth showing.
function unwrapV2(json, what) {
  if (!json || json.resultCode === undefined) {
    throw new Error(`ThinQ v2 ${what}: unexpected response ${JSON.stringify(json).slice(0, 200)}`);
  }
  if (json.resultCode !== '0000') {
    const err = new Error(`ThinQ v2 ${what}: LG error ${json.resultCode} — ${typeof json.result === 'string' ? json.result : JSON.stringify(json.result || '').slice(0, 200)}`);
    err.lgCode = json.resultCode;
    throw err;
  }
  return json.result;
}

// LG flags long-lived unofficial client ids with 9006/9012 ("consider
// using the official API"). wideq's documented workaround: mint a fresh
// client id and retry — the id is just sha256(userNo + timestamp). This
// standalone tool doesn't persist the rotated id across runs (each run is
// short-lived and stateless); a single retry within one run is enough.
function rotateClientId(userNumber) {
  return crypto.createHash('sha256').update(String(userNumber) + String(Date.now()), 'utf8').digest('hex');
}

async function withClientIdRetry(fn, cfg) {
  try {
    return await fn(cfg);
  } catch (e) {
    if (e.lgCode === '9006' || e.lgCode === '9012') {
      cfg.clientId = rotateClientId(cfg.userNumber);
      return await fn(cfg);
    }
    throw e;
  }
}

async function fetchJson(url, opts, what) {
  const res = await fetch(url, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch {
    throw new Error(`ThinQ v2 ${what}: HTTP ${res.status}, non-JSON body ${text.slice(0, 150)}`);
  }
}

let _gatewayCache = null;
export async function v2Gateway() {
  if (_gatewayCache) return _gatewayCache;
  const json = await fetchJson(V2_GATEWAY_URL, { headers: thinq2Headers() }, 'gateway');
  const result = unwrapV2(json, 'gateway');
  _gatewayCache = {
    thinq2Uri: result.thinq2Uri,
    empSpxUri: result.empSpxUri,
    empTermsUri: result.empTermsUri,
    oauthUri: result.empOauthBaseUri || result.oauthUri,
  };
  return _gatewayCache;
}

// The browser login URL (homebridge-lg-thinq's Auth.ts getLoginUrl shape).
// Critical detail: redirect_uri/callback_url must be the app scheme
// `lgaccount.lgsmartthinq:/` — the SAME value the token exchange later
// sends — or LG 404s after sign-in. After login the browser lands on an
// unloadable app-scheme URL; that error page is EXPECTED and its address
// carries the code + oauth2_backend_url we need.
export async function v2LoginUrl() {
  const gw = await v2Gateway();
  const spx = new URL(gw.empSpxUri);
  const q = new URLSearchParams({
    country: COUNTRY,
    language: LANGUAGE,
    client_id: CLIENT_ID,
    svc_list: SVC_CODE,
    svc_integrated: 'Y',
    redirect_uri: EMP_REDIRECT_URL,
    show_thirdparty_login: 'LGE,MYLG,GGL,AMZ,FBK,APPL',
    division: 'ha:T20',
    callback_url: EMP_REDIRECT_URL,
    oauth2State: '12345',
    show_select_country: 'N',
  });
  return { login_url: `${spx.protocol}//${OAUTH_LOGIN_HOST}${spx.pathname.replace(/\/$/, '')}/login/signIn?${q}`, callback_hint: EMP_REDIRECT_URL };
}

// Signed POST to the oauth token endpoint (auth-code exchange + refresh).
async function authRequest(oauthUrl, data, what) {
  const body = new URLSearchParams(data).toString();
  const ts = lgTimestamp();
  const sig = oauthSignature(`${V2_AUTH_PATH}?${body}\n${ts}`, OAUTH_SECRET_KEY);
  const json = await fetchJson(`${oauthUrl.replace(/\/$/, '')}${V2_AUTH_PATH}`, {
    method: 'POST',
    headers: {
      'x-lge-appkey': CLIENT_ID,
      'x-lge-oauth-signature': sig,
      'x-lge-oauth-date': ts,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  }, what);
  if (!json.access_token) {
    throw new Error(`ThinQ v2 ${what}: ${json.error_description || json.error || JSON.stringify(json).slice(0, 200)}`);
  }
  return json;
}

// Native-LG-account third-party assist: email + pre-hashed token login via
// the EMP session flow (used when the callback carries user_thirdparty_token
// instead of an oauth code — i.e. Google/Apple/Amazon/Facebook sign-ins).
async function empUserLogin(userId, encryptedPwd, thirdPartyName) {
  const gw = await v2Gateway();
  const headers = {
    Accept: 'application/json',
    'X-Application-Key': APPLICATION_KEY,
    'X-Client-App-Key': CLIENT_ID,
    'X-Lge-Svccode': 'SVC709',
    'X-Device-Type': 'M01',
    'X-Device-Platform': 'ADR',
    'X-Device-Language-Type': 'IETF',
    'X-Device-Publish-Flag': 'Y',
    'X-Device-Country': COUNTRY,
    'X-Device-Language': LANGUAGE,
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
  };
  const spxBase = gw.empSpxUri.replace(/\/$/, '');
  const preLogin = await fetchJson(`${spxBase}/preLogin`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      user_auth2: encryptedPwd,
      log_param: `login request / user_id : ${userId} / third_party : null / svc_list : SVC202,SVC710 / 3rd_service : `,
    }).toString(),
  }, 'preLogin');
  headers['X-Signature'] = preLogin.signature;
  headers['X-Timestamp'] = preLogin.tStamp;

  const sessData = {
    user_auth2: preLogin.encrypted_pw,
    password_hash_prameter_flag: 'Y',
    svc_list: 'SVC202,SVC710',
  };
  if (thirdPartyName) sessData.third_party = thirdPartyName;
  const account_data = await fetchJson(
    `${gw.empTermsUri.replace(/\/$/, '')}/emp/v2.0/account/session/${encodeURIComponent(userId)}`,
    { method: 'POST', headers, body: new URLSearchParams(sessData).toString() },
    'emp session'
  );
  if (!account_data.account || account_data.error) {
    const e = account_data.error || {};
    throw new Error(`LG account login failed${e.code ? ` (${e.code})` : ''}: ${e.message || 'unknown error'}`);
  }
  const account = account_data.account;

  const secretRes = await fetch(`${spxBase}/searchKey?key_name=OAUTH_SECRETKEY&sever_type=OP`);
  const secretKey = JSON.parse(await secretRes.text()).returnData;

  const empData = {
    account_type: account.userIDType,
    client_id: CLIENT_ID,
    country_code: account.country,
    username: account.userID,
  };
  const ts = lgTimestamp();
  const reqUrl = `${new URL(V2_EMP_SESS_URL).pathname}?${new URLSearchParams(empData)}`;
  const tokenData = await fetchJson(V2_EMP_SESS_URL, {
    method: 'POST',
    headers: {
      'lgemp-x-app-key': OAUTH_CLIENT_KEY,
      'lgemp-x-date': ts,
      'lgemp-x-session-key': account.loginSessionID,
      'lgemp-x-signature': oauthSignature(`${reqUrl}\n${ts}`, secretKey),
      Accept: 'application/json',
      'X-Device-Type': 'M01',
      'X-Device-Platform': 'ADR',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(empData).toString(),
  }, 'emp token');
  if (tokenData.status !== 1 || !tokenData.access_token) {
    throw new Error(`LG token exchange failed: ${JSON.stringify(tokenData).slice(0, 200)}`);
  }
  return tokenData; // { access_token, refresh_token, expires_in, oauth2_backend_url }
}

async function getUserNumber(accessToken, oauthUrl) {
  const ts = lgTimestamp();
  const json = await fetchJson(`${oauthUrl.replace(/\/$/, '')}${V2_USER_INFO}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'X-Lge-Svccode': SVC_CODE,
      'X-Application-Key': APPLICATION_KEY,
      'lgemp-x-app-key': CLIENT_ID,
      'X-Device-Type': 'M01',
      'X-Device-Platform': 'ADR',
      'x-lge-oauth-date': ts,
      'x-lge-oauth-signature': oauthSignature(`${V2_USER_INFO}\n${ts}`, OAUTH_SECRET_KEY),
    },
  }, 'user profile');
  if (json.status !== 1 || !json.account?.userNo) {
    throw new Error('Failed to retrieve LG user number');
  }
  return json.account.userNo;
}

// Resolve a successful login into the values this tool needs persisted as
// GitHub secrets: refresh token + oauth url + user number + a stable
// client id derived from the user number. Unlike the original server-backed
// version, this never writes anywhere — the setup script prints these for
// the human to copy into repository secrets.
async function v2ResolveTokens(tokens) {
  const oauthUrl = tokens.oauth2_backend_url || (await v2Gateway()).oauthUri;
  const userNumber = tokens.user_number || await getUserNumber(tokens.access_token, oauthUrl);
  const clientId = crypto.createHash('sha256')
    .update(userNumber + new Date().toISOString().replace(/\D/g, '').slice(0, 14), 'utf8').digest('hex');
  return { refreshToken: tokens.refresh_token, oauthUrl, userNumber, clientId, accessToken: tokens.access_token };
}

// Primary path: direct email + password login. LG's EMP flow accepts the
// SHA-512 hash of the password (password_hash_prameter_flag: Y), so the
// plaintext is used only inside this call and never stored — only the
// refresh token survives, and only in whatever the caller does with it
// (here: printed once, for the human to paste into GitHub secrets).
export async function v2PasswordLogin(email, password) {
  const hashed = crypto.createHash('sha512').update(String(password), 'utf8').digest('hex');
  const tokens = await empUserLogin(String(email).trim(), hashed, null);
  return v2ResolveTokens(tokens);
}

// Alternate path: parse a pasted redirect URL (lgaccount.lgsmartthinq:/?...)
// from the browser flow — needed for Google/Apple/Amazon/Facebook LG
// accounts, which can't do the password login.
export async function v2CompleteLogin(callbackUrl) {
  let parsed;
  try { parsed = new URL(String(callbackUrl).trim()); } catch {
    throw new Error('That doesn\'t look like a URL — copy the FULL address of the error page you land on after signing in (it starts with lgaccount.lgsmartthinq:/)');
  }
  const q = Object.fromEntries(parsed.searchParams.entries());
  let tokens;

  if (q.refresh_token) {
    tokens = { access_token: q.access_token, refresh_token: q.refresh_token, oauth2_backend_url: q.oauth2_backend_url };
  } else if (q.code) {
    const oauthUrl = q.oauth2_backend_url || (await v2Gateway()).oauthUri;
    const out = await authRequest(oauthUrl, {
      code: q.code, grant_type: 'authorization_code', redirect_uri: EMP_REDIRECT_URL,
    }, 'code exchange');
    tokens = { ...out, oauth2_backend_url: out.oauth2_backend_url || q.oauth2_backend_url || oauthUrl };
    if (q.user_number) tokens.user_number = q.user_number;
  } else if (q.user_id && q.user_thirdparty_token && THIRD_PART_LOGIN[q.user_id_type]) {
    tokens = await empUserLogin(q.user_id, q.user_thirdparty_token, THIRD_PART_LOGIN[q.user_id_type]);
  } else {
    throw new Error(`No login data in that URL (params: ${Object.keys(q).join(', ') || 'none'}). Make sure you copied the address AFTER the login completed.`);
  }

  return v2ResolveTokens(tokens);
}

// ---------- runtime config + control (used by tick/manual scripts) ----------

export function v2ConfigFromEnv() {
  let sabbathCtrl = null;
  try { sabbathCtrl = process.env.THINQ_V2_SABBATH_CTRL ? JSON.parse(process.env.THINQ_V2_SABBATH_CTRL) : null; } catch { sabbathCtrl = null; }
  return {
    refreshToken: process.env.THINQ_V2_REFRESH_TOKEN || null,
    oauthUrl: process.env.THINQ_V2_OAUTH_URL || null,
    userNumber: process.env.THINQ_V2_USER_NUMBER || null,
    clientId: process.env.THINQ_V2_CLIENT_ID || V2_CLIENT_ID_DEFAULT,
    deviceId: process.env.THINQ_V2_DEVICE_ID || null,
    sabbathCtrl,
  };
}

export function v2Connected(cfg) {
  return !!cfg.refreshToken && !!cfg.oauthUrl;
}

async function v2AccessToken(cfg) {
  if (!cfg.refreshToken || !cfg.oauthUrl) throw new Error('LG app-channel login not completed — run `npm run setup:v2`');
  const out = await authRequest(cfg.oauthUrl, {
    grant_type: 'refresh_token', refresh_token: cfg.refreshToken,
  }, 'token refresh');
  return out.access_token;
}

async function v2Get(path, cfg) {
  return withClientIdRetry(async (c) => {
    const token = await v2AccessToken(c);
    const gw = await v2Gateway();
    const json = await fetchJson(`${gw.thinq2Uri.replace(/\/$/, '')}/${path}`, {
      headers: thinq2Headers({ accessToken: token, userNumber: c.userNumber, clientId: c.clientId }),
    }, path);
    return unwrapV2(json, path);
  }, cfg);
}

async function v2Post(path, payload, cfg) {
  return withClientIdRetry(async (c) => {
    const token = await v2AccessToken(c);
    const gw = await v2Gateway();
    const json = await fetchJson(`${gw.thinq2Uri.replace(/\/$/, '')}/${path}`, {
      method: 'POST',
      headers: {
        ...thinq2Headers({ accessToken: token, userNumber: c.userNumber, clientId: c.clientId }),
        'x-thinq-security-key': SECURITY_KEY,
      },
      body: JSON.stringify(payload),
    }, path);
    return unwrapV2(json, path);
  }, cfg);
}

export async function v2Devices(cfg) {
  const result = await v2Get('service/application/dashboard', cfg);
  const items = Array.isArray(result?.item) ? result.item : [];
  return items.map((d) => ({
    device_id: d.deviceId,
    alias: d.alias || d.modelName || d.deviceId,
    type: Number(d.deviceType),
    is_refrigerator: Number(d.deviceType) === DEVICE_TYPE_REFRIGERATOR,
    model_json_uri: d.modelJsonUri || d.modelJsonUrl || null,
    snapshot_sabbath: d.snapshot?.refState?.sabbathMode ?? null,
  }));
}

// Probe the model JSON: find the sabbathMode enum mapping + a ControlWifi
// command whose template carries sabbathMode. Returns the control spec that
// the setup script prints as THINQ_V2_SABBATH_CTRL — or controllable:false.
export async function v2ProbeSabbath(deviceId, cfg) {
  const devices = await v2Devices(cfg);
  const dev = devices.find((d) => d.device_id === deviceId);
  if (!dev) throw new Error('Device not found on the LG app channel');
  if (!dev.model_json_uri) throw new Error('Device has no model JSON — cannot inspect capabilities');
  const model = await fetchJson(dev.model_json_uri, {}, 'model JSON');

  const monitoring = model.MonitoringValue?.sabbathMode;
  const mapping = monitoring?.valueMapping || {};
  const keys = Object.keys(mapping);
  const byLabel = (label, re) => keys.find((k) => mapping[k]?.label === label) || keys.find((k) => re.test(k));
  const onValue = byLabel(LABEL_ON, /on/i);
  const offValue = byLabel(LABEL_OFF, /off/i);

  // Deep-search each ControlWifi command's data template for a node that
  // carries a sabbathMode key, at any depth — some models put it under a
  // dedicated command/root instead of basicCtrl's refState.
  const findSabbathPath = (node, path = []) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    if ('sabbathMode' in node) return { path, keys: Object.keys(node) };
    for (const [k, v] of Object.entries(node)) {
      const hit = findSabbathPath(v, [...path, k]);
      if (hit) return hit;
    }
    return null;
  };

  let ctrl = null;
  const controlWifi = model.ControlWifi || {};
  for (const [cmdName, cmd] of Object.entries(controlWifi)) {
    const data = cmd?.data;
    if (!ctrl && data && typeof data === 'object') {
      const hit = findSabbathPath(data);
      if (hit && hit.path.length >= 1) {
        ctrl = {
          command: cmd.command || 'Set',
          ctrlKey: cmd.ctrlKey || 'basicCtrl',
          cmdName,
          path: hit.path,
          root: hit.path[0],
          templateKeys: hit.keys,
          inTemplate: true,
        };
      }
    }
  }

  // No template carries sabbathMode — the common v2-fridge case is that
  // basicCtrl has NO data template at all (data: null) and wideq builds the
  // payload itself: dataSetList {refState:{<key>:<value>}}. Gate on the
  // enum existing in MonitoringValue so we never invent a key the model
  // doesn't declare.
  if (!ctrl && monitoring && controlWifi.basicCtrl) {
    ctrl = {
      command: controlWifi.basicCtrl.command || 'Set',
      ctrlKey: 'basicCtrl',
      cmdName: 'basicCtrl',
      path: ['refState'],
      root: 'refState',
      templateKeys: ['sabbathMode'],
      inTemplate: false,
    };
  }

  return {
    device_alias: dev.alias,
    present: !!monitoring,
    monitoring_keys: keys,
    controllable: !!(ctrl && onValue && offValue),
    onValue: onValue || null,
    offValue: offValue || null,
    ctrl,
    control_wifi_commands: Object.keys(controlWifi),
    snapshot_sabbath: dev.snapshot_sabbath,
  };
}

// Flip Sabbath mode over the app channel. Mirrors wideq's
// _prepare_command_v2: every other key in the command template goes to
// "IGNORE" so only sabbathMode changes.
export async function v2SetSabbath(on, cfg) {
  if (!cfg.deviceId) throw new Error('THINQ_V2_DEVICE_ID not set');
  const spec = cfg.sabbathCtrl;
  if (!spec?.controllable) {
    throw new Error('THINQ_V2_SABBATH_CTRL is missing or not controllable — rerun `npm run setup:v2`');
  }
  const value = on ? spec.onValue : spec.offValue;
  const dataSet = {};
  for (const k of spec.ctrl.templateKeys) dataSet[k] = k === 'sabbathMode' ? value : 'IGNORE';
  const path = Array.isArray(spec.ctrl.path) && spec.ctrl.path.length ? spec.ctrl.path : [spec.ctrl.root];
  let nested = dataSet;
  for (let i = path.length - 1; i >= 0; i--) nested = { [path[i]]: nested };
  const payload = {
    ctrlKey: spec.ctrl.ctrlKey,
    command: spec.ctrl.command,
    dataSetList: nested,
  };
  const result = await v2Post(`service/devices/${cfg.deviceId}/control-sync`, payload, cfg);
  return { device_id: cfg.deviceId, sabbathMode: value, lg_result: result ?? 'ok' };
}

// Current Sabbath value from the dashboard snapshot (read-back check).
export async function v2SabbathState(cfg) {
  if (!cfg.deviceId) throw new Error('THINQ_V2_DEVICE_ID not set');
  const devices = await v2Devices(cfg);
  const dev = devices.find((d) => d.device_id === cfg.deviceId);
  return { sabbathMode: dev?.snapshot_sabbath ?? null };
}
