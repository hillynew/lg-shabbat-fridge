#!/usr/bin/env node
// One-time interactive setup for the LG "app channel" (v2) — the fallback
// used when the official API marks Sabbath mode read-only. Run this
// locally (never in CI): the password is used once for the LG sign-in and
// is never stored — only the resulting refresh token is printed for you to
// save as a GitHub Actions repository secret.
//
// Usage: node scripts/setup-v2.js
//   (or: npm run setup:v2)

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  v2LoginUrl, v2PasswordLogin, v2CompleteLogin, v2Devices, v2ProbeSabbath,
} from '../src/thinqV2.js';

async function prompt(q) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const a = await rl.question(q);
  rl.close();
  return a.trim();
}

// Minimal masked password prompt — avoids pulling in an extra dependency
// just to hide keystrokes. Falls back to a plain (visible) prompt when
// stdin isn't a TTY (e.g. piped input).
function promptHidden(q) {
  if (!stdin.isTTY) return prompt(q);
  return new Promise((resolve) => {
    stdout.write(q);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\n' || ch === '\r' || ch === '') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(value.trim());
        return;
      }
      if (ch === '') { stdout.write('\n'); process.exit(1); }
      if (ch === '') { value = value.slice(0, -1); return; }
      value += ch;
    };
    stdin.on('data', onData);
  });
}

async function pickAndProbe(devices, cfg) {
  const fridges = devices.filter((d) => d.is_refrigerator);
  const list = fridges.length ? fridges : devices;
  console.log('\nDevices on the app channel:');
  list.forEach((d, i) => console.log(`  [${i}] ${d.alias}${d.is_refrigerator ? ' (refrigerator)' : ''} — id ${d.device_id}`));
  const idx = list.length === 1 ? 0 : Number(await prompt(`\nPick the refrigerator [0-${list.length - 1}]: `));
  const dev = list[idx];
  if (!dev) throw new Error('Invalid selection.');
  console.log(`\nProbing "${dev.alias}"…`);
  const spec = await v2ProbeSabbath(dev.device_id, cfg);
  return { dev, spec };
}

function printSecrets(tokens, dev, spec) {
  console.log('\nProbe result:', spec);
  console.log('\nAdd these as GitHub Actions repository secrets');
  console.log('(Settings → Secrets and variables → Actions → New repository secret):\n');
  console.log(`  THINQ_V2_REFRESH_TOKEN=${tokens.refreshToken}`);
  console.log(`  THINQ_V2_OAUTH_URL=${tokens.oauthUrl}`);
  console.log(`  THINQ_V2_USER_NUMBER=${tokens.userNumber}`);
  console.log(`  THINQ_V2_CLIENT_ID=${tokens.clientId}`);
  console.log(`  THINQ_V2_DEVICE_ID=${dev.device_id}`);
  console.log(`  THINQ_V2_SABBATH_CTRL=${JSON.stringify(spec)}`);

  if (!spec.controllable) {
    console.log('\n⚠️  The app-channel probe did NOT find a writable Sabbath control on this model either.');
    console.log('    Paste the probe result above when asking for help — it shows exactly what the model offers.');
  } else {
    console.log('\n✅ Controllable via the app channel.');
  }
}

async function main() {
  console.log('LG ThinQ app-channel (v2) setup');
  console.log('--------------------------------');
  const mode = await prompt('Sign in with (1) email + password, or (2) browser paste-URL flow? [1/2]: ');

  let tokens;
  if (mode === '2') {
    const { login_url } = await v2LoginUrl();
    console.log(`\nOpen this URL in a browser and sign in:\n  ${login_url}\n`);
    console.log("You'll land on an error page afterward — that's EXPECTED, it's the hand-off.");
    console.log('Copy its FULL address (starts with lgaccount.lgsmartthinq:/) and paste it below.');
    console.log("(If the page just freezes with no address change, copy the frozen tab's link anyway, or try a phone browser.)\n");
    const url = await prompt('Pasted address: ');
    tokens = await v2CompleteLogin(url);
  } else {
    const email = await prompt('LG account email: ');
    const password = await promptHidden('LG account password: ');
    tokens = await v2PasswordLogin(email, password);
  }

  console.log(`\nSigned in as user ${tokens.userNumber}. Looking up devices…`);
  const devices = await v2Devices(tokens);
  const { dev, spec } = await pickAndProbe(devices, tokens);
  printSecrets(tokens, dev, spec);
}

main().catch((e) => {
  console.error('\nSetup failed:', e.message);
  process.exitCode = 1;
});
