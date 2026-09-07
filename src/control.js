// Picks whichever channel can actually flip Sabbath mode right now. The
// official ThinQ Connect API (thinqOfficial.js) is preferred when it's
// writable on this model; the v2 "app channel" (thinqV2.js) is the fallback
// for models that mark it read-only over the official API.

import { officialConfigFromEnv, officialWritable, setSabbathMode, getSabbathState } from './thinqOfficial.js';
import { v2ConfigFromEnv, v2Connected, v2SetSabbath, v2SabbathState } from './thinqV2.js';

export function sabbathControlPath() {
  if (officialWritable(officialConfigFromEnv())) return 'official';
  const v2 = v2ConfigFromEnv();
  if (v2Connected(v2) && v2.deviceId && v2.sabbathCtrl?.controllable) return 'app';
  return null;
}

export async function setSabbathAuto(on) {
  const path = sabbathControlPath();
  if (path === 'official') return { path, ...(await setSabbathMode(on, officialConfigFromEnv())) };
  if (path === 'app') return { path, ...(await v2SetSabbath(on, v2ConfigFromEnv())) };
  throw new Error('No controllable Sabbath channel configured — run `npm run setup:official` or `npm run setup:v2` first (see README).');
}

export async function getCurrentSabbathState() {
  const path = sabbathControlPath();
  if (path === 'official') return (await getSabbathState(officialConfigFromEnv())).sabbathMode;
  if (path === 'app') return (await v2SabbathState(v2ConfigFromEnv())).sabbathMode;
  return null;
}
