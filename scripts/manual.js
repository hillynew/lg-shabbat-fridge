#!/usr/bin/env node
// Manual test flip — "make sure it actually works before trusting Friday to
// it". Reads the same env vars/secrets as the scheduled tick.
//
// Usage: node scripts/manual.js on|off
//   (or: npm run manual:on / npm run manual:off)

import { setSabbathAuto } from '../src/control.js';

const arg = (process.argv[2] || '').toLowerCase();
if (arg !== 'on' && arg !== 'off') {
  console.error('Usage: node scripts/manual.js <on|off>');
  process.exit(1);
}

setSabbathAuto(arg === 'on')
  .then((r) => console.log(`Sabbath mode ${arg.toUpperCase()} via ${r.path} channel (device ${r.device_id}).`))
  .catch((e) => {
    console.error('Failed:', e.message);
    process.exitCode = 1;
  });
