# Official connection recovery — 2026-11-15

The unofficial LG dashboard rejected the November 13 one-time ON attempt with HTTP 400 / LG 9006, before any control request. Do not work around that denial by rotating client IDs or changing networks. The old manual ON workflow is expired and disabled.

## Current safeguards

Verified November 15 in the dashboards: GitHub's Shabbat tick and one-time ON workflows are disabled. Cloudflare has SHABBAT_HOLD=true, SHABBAT_WORKER_WRITES=false, no cron triggers, and builds disabled. No fridge control command was sent during this recovery work.

## Read-only next step

The manual **Official LG read-only check** workflow downloads the diagnostic and its tests from immutable commit 0b9248e77f2d18ea9467d4793492cc94a891c1c1 and verifies both SHA-256 digests before running. It has no schedule and no GitHub token permissions.

The check uses only three GET requests to LG's official US API, with an 8-second deadline per request, a bounded response body, and no redirects or retries. It matches the configured device ID exactly, checks the refrigerator type, and reads the exact `property.sabbath.sabbathMode` profile. Write support requires an explicit write mode; enum order is never interpreted as ON/OFF. Its output omits credentials, device IDs, aliases, raw profiles, and raw upstream error messages.

Required encrypted GitHub Actions secrets:

- THINQ_PAT: the existing LG token for this project, subject to the owner's approval to transfer it to GitHub.
- THINQ_CLIENT_ID: one UUID generated once for this official API client; reuse it between requests and runs.
- THINQ_DEVICE_ID: optional, only if the official API uses a different device ID. Otherwise the check matches the existing THINQ_V2_DEVICE_ID. A missing match stops; it never selects another appliance automatically.

The existing token named Shabbat is visible in the authenticated LG portal, but it has not been copied or saved by this recovery work. No token value belongs in source, PR text, logs, or chat.

A successful read is **not** activation approval or proof of physical state: freshness remains unverified, and automationReady is always false. If LG exposes Sabbath as read-only, the official API cannot automate it; investigate that model's supported built-in Sabbath scheduling instead. Do not fall back to a blocked unofficial endpoint.

Before activating any replacement: establish actual capability, validate state freshness and read-back behavior, safely test an explicitly requested change, verify the free plan and production limits, configure alerts and calendar renewal, and use only one active controller.

## Validation

42 local tests passed: 30 existing Worker/calendar tests and 12 new diagnostic tests. The new tests cover exact target selection, read-only profiles, malformed profiles, unknown state, credential redaction, HTTP denial/redirects without retries, response limits, and deadlines through body consumption. Live official API access has not yet been tested.

Schema and request headers follow LG's official SDK:
- https://github.com/thinq-connect/pythinqconnect/blob/main/thinqconnect/thinq_api.py
- https://github.com/thinq-connect/pythinqconnect/blob/main/thinqconnect/devices/connect_device.py
- https://github.com/thinq-connect/pythinqconnect/blob/main/thinqconnect/devices/refrigerator.py
