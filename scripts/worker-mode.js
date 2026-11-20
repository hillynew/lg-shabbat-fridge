#!/usr/bin/env node
// Prints the mode wrangler.jsonc would deploy: held, shadow or live.
//   held   - the Worker contacts nobody.
//   shadow - reads the fridge near boundaries but never sends a command.
//   live   - the Worker is the controller and sends ON/OFF.
// Anything else (for example writes enabled under the wrong writer) is an error.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function workerMode(vars = {}) {
  const hold = vars.SHABBAT_HOLD, writes = vars.SHABBAT_WORKER_WRITES, writer = vars.SHABBAT_WRITER;
  if (![hold, writes].every(v => v === 'true' || v === 'false') || !['github', 'cloudflare'].includes(writer)) throw new Error('worker_flags_invalid');
  if (hold === 'true') return 'held';
  if (writes === 'true' && writer === 'cloudflare') return 'live';
  if (writes === 'false' && writer === 'github') return 'shadow';
  throw new Error('worker_flags_inconsistent');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(workerMode(JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8')).vars));
}
