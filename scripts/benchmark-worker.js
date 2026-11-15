import { createHash } from 'node:crypto';
// Local workerd compatibility smoke test + Node CPU estimate, NOT production CPU evidence.
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createLG } from '../worker/lg.js';
import { run } from '../worker/index.js';
const now = Date.now();
const schedule = { version: 1, validFrom: now - 1, validUntil: now + 366 * 86400000,
  spans: Array.from({ length: 54 }, (_, i) => ({ on: now + i * 7 * 86400000, off: now + (i * 7 + 1) * 86400000 })) };
const bundle = await build({ entryPoints: ['worker/index.js'], bundle: true, format: 'esm', platform: 'neutral', external: ['node:crypto'], write: false });
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'fridge', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-11-01', compatibilityFlags: ['nodejs_compat'], bindings: { SHABBAT_SCHEDULE_JSON: JSON.stringify(schedule), SHABBAT_SCHEDULE_SHA256: createHash('sha256').update(JSON.stringify(schedule)).digest('hex') } }] }));
try {
  const worker = await mf.getWorker();
  await worker.scheduled({ scheduledTime: now, cron: '*/3 * * * *' });
  console.log('PASS: compiled Worker scheduled handler ran in local workerd, held and credential-free.');
} finally { await mf.dispose(); }
const env = { SHABBAT_SCHEDULE_JSON: JSON.stringify(schedule), SHABBAT_SCHEDULE_SHA256: createHash('sha256').update(JSON.stringify(schedule)).digest('hex'), SHABBAT_HOLD: 'false',
  THINQ_V2_REFRESH_TOKEN: 'FAKE', THINQ_V2_OAUTH_URL: 'https://oauth.lge.com', THINQ_V2_USER_NUMBER: 'FAKE', THINQ_V2_DEVICE_ID: 'FAKE', THINQ_V2_CLIENT_ID: 'FAKE',
  THINQ_V2_SABBATH_CTRL: JSON.stringify({ controllable: true, onValue: 'ON', offValue: 'OFF', ctrl: { command: 'Set', ctrlKey: 'basicCtrl', templateKeys: ['sabbathMode'], path: ['refState'] } }) };
async function request(url) {
  if (url.includes('gateway-uri')) return { resultCode: '0000', result: { thinq2Uri: 'https://aic.lgthinq.com/v2' } };
  if (url.includes('oauth2/token')) return { access_token: 'FAKE' };
  return { resultCode: '0000', result: { item: [{ deviceId: 'FAKE', online: true, snapshot: { timestamp: now, refState: { sabbathMode: 'OFF' } } }] } };
}
const count = 1000;
const start = process.cpuUsage();
for (let i = 0; i < count; i++) await run(env, { clock: () => now, clientFactory: e => createLG(e, request), log: () => {} });
const cpu = process.cpuUsage(start);
console.log(`Node local CPU estimate: ${((cpu.user + cpu.system) / 1000 / count).toFixed(3)} ms/tick over ${count} shadow ticks including HMAC, headers and fake responses. Excludes real fetch/JSON costs and cannot validate Workers Free 10ms production limit.`);
