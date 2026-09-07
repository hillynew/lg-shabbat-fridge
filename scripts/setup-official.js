#!/usr/bin/env node
// One-time interactive setup for LG's OFFICIAL ThinQ Connect API. Run this
// locally (never in CI): it verifies a Personal Access Token, lists your
// devices, and probes whether the selected fridge lets this API WRITE
// Sabbath mode. If it does, it prints the values to save as GitHub Actions
// repository secrets. If the model reports Sabbath mode as read-only here
// (common), run `npm run setup:v2` instead — the phone-app channel can
// often write what this API can only read.
//
// Usage: node scripts/setup-official.js
//   (or: npm run setup:official)

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import crypto from 'node:crypto';
import { listDevices, probeDevice } from '../src/thinqOfficial.js';

async function prompt(q) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const a = await rl.question(q);
  rl.close();
  return a.trim();
}

async function main() {
  console.log('LG ThinQ Connect (official API) setup');
  console.log('--------------------------------------');
  const pat = process.env.THINQ_PAT || await prompt('Paste your Personal Access Token (generate one at https://connect-pat.lgthinq.com): ');
  if (!pat) throw new Error('A PAT is required.');
  const cfg = { pat, clientId: crypto.randomUUID() };

  console.log('\nVerifying token and listing devices…');
  const devices = await listDevices(cfg);
  if (!devices.length) {
    console.log('No devices found on this LG account. Double-check you generated the PAT with the account that owns the fridge.');
    return;
  }

  console.log('\nDevices on this account:');
  devices.forEach((d, i) => console.log(`  [${i}] ${d.alias} (${d.type || 'unknown type'}) — id ${d.device_id}`));

  const pick = devices.length === 1 ? 0 : Number(await prompt(`\nPick the refrigerator [0-${devices.length - 1}]: `));
  const dev = devices[pick];
  if (!dev) throw new Error('Invalid selection.');

  console.log(`\nProbing "${dev.alias}"…`);
  const spec = await probeDevice(dev.device_id, cfg);
  console.log('Probe result:', spec);

  if (!spec.present) {
    console.log('\nThis model does not expose sabbathMode over the official API at all.');
    console.log('Try `npm run setup:v2` (the phone-app channel) instead.');
    return;
  }
  if (!spec.writable) {
    console.log('\nSabbath mode is READ-ONLY on the official API for this model (this is common on LG fridges).');
    console.log('Try `npm run setup:v2` — the phone app can often write what this API can only read.');
    return;
  }

  console.log('\n✅ Writable! Add these as GitHub Actions repository secrets');
  console.log('   (Settings → Secrets and variables → Actions → New repository secret):\n');
  console.log(`  THINQ_PAT=${pat}`);
  console.log(`  THINQ_DEVICE_ID=${dev.device_id}`);
  console.log(`  THINQ_SABBATH_ON_VALUE=${spec.onValue}`);
  console.log(`  THINQ_SABBATH_OFF_VALUE=${spec.offValue}`);
  console.log('\n(THINQ_CLIENT_ID is optional — omit it and a fresh id is generated on every run.)');
}

main().catch((e) => {
  console.error('\nSetup failed:', e.message);
  process.exitCode = 1;
});
