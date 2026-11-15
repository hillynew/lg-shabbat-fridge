# Official connection recovery — November 15, 2026

## Verified result

LG's official API connection now succeeds. The account lists exactly one refrigerator. Its official device ID differs from the old unofficial configured ID. In an explicitly read-only discovery check, LG's profile reports Sabbath mode present and readable, but **not writable**. The diagnostic's ON/OFF-only decoder was missing LG's declared boolean representation. It now decodes true/false only when the official profile explicitly declares a readable boolean and includes the returned value. The latest API report is **OFF**; physical state and freshness remain independently unverified.

[Successful live check, November 15 at 12:17 PM Eastern](https://github.com/hillynew/lg-shabbat-fridge/actions/runs/43740294877), job 132891757504:

```json
{"status":"read_complete","controlRequests":0,"deviceCount":1,"refrigeratorCount":1,"configuredIdMatched":false,"modelName":"2RES1VE41PFA2","capability":{"present":true,"readable":true,"writable":false,"enumPair":null},"reportedMode":"off","freshnessVerified":false,"automationReady":false}
```

No fridge control command was sent. This is a successful diagnostic, not working automated Sabbath control. The official API cannot switch this reported read-only property. The earlier unofficial API rejected the November 13 ON attempt with HTTP 400 / LG 9006, before a control request. Do not evade that denial with client-ID rotation or network changes. The old one-time ON workflow is expired and disabled.

## Credentials and safeguards

After the owner's explicit approval, the existing LG token named Shabbat was saved as the encrypted GitHub Actions secret THINQ_PAT, together with a separately generated stable THINQ_CLIENT_ID. No credential values were added to source, PR text, or workflow logs. The official token has not been transferred to Cloudflare.

Verified November 15: GitHub's Shabbat tick and one-time ON workflows are disabled. Cloudflare remains SHABBAT_HOLD=true, SHABBAT_WORKER_WRITES=false, with no cron triggers and builds disabled. No new deployment, paid resource, or schedule activation occurred during recovery.

## Diagnostic implementation

The manual **Official LG read-only check** workflow pins diagnostic source and tests to immutable commit 97965ded61f1de5ab45540ad81b754c48a5ae3fb and verifies SHA-256 digests. It has no schedule and no GitHub token permissions. Credentials are available only in its final diagnostic step, after the downloaded diagnostic's tests pass.

The check makes at most three GET requests to LG's official US API. Each request has an 8-second deadline and a 512 KiB response bound; redirects and denials stop without retries. Normal operation requires the configured ID. THINQ_PROBE_DISCOVER=true permits reading the account's sole refrigerator if the old ID is absent. That diagnostic fallback does not confirm a control target, save its ID, or grant permission for future writes. Multiple refrigerators, duplicate matches, unsafe IDs, and mismatched appliance types stop.

Only normalized capability and state flags/counts and a bounded manufacturer model name are logged. Credentials, device IDs, aliases, raw profiles, and raw error messages are omitted. No enum order or unknown value is interpreted as OFF. automationReady and freshnessVerified always remain false.

All 17 diagnostic tests passed locally. [CI for the pinned source](https://github.com/hillynew/lg-shabbat-fridge/actions/runs/43740232263) passed all 47 tests and the Worker dry build. The live run on main commit 6b439a137106744f4db1f0613b6c77dffaed1a8b passed its source-digest checks and all 17 credential-free diagnostic tests before making three read-only requests.

## Next supported route

The owner confirmed on November 15 that Sabbath mode can still be turned on and off directly in the LG ThinQ phone app. The API reports internal model name `2RES1VE41PFA2`; its retail model mapping is unverified. Inspect the phone app's **Smart Sabbath** screen next. Phone-screen access from the Mac failed, so the current app settings are not available to this diagnostic. LG documents built-in Sabbath scheduling on some models; support and Shabbos/Yom Tov timing have not been verified for this refrigerator. Verify whether the available app schedule supports the required Friday/holiday noon start, end at local sunset plus 60 minutes, Diaspora Yom Tov, and continuous adjoining days. A weekly-only schedule does not establish Yom Tov coverage. Do not activate the custom controller based on a successful read-only diagnostic.

Official LG reference (model example, not confirmation of this household's model):
https://media.us.lg.com/m/245831b94781de3d/original/SRFVC2406S-Owners-Manual.pdf

If a future supported writable interface is available, activation still requires target confirmation, state freshness and read-back validation, an explicitly authorized safe control test, free-plan and production-limit checks, alerts, calendar renewal, and only one active controller.

Schema and request headers follow LG's official SDK:
- https://github.com/thinq-connect/pythinqconnect/blob/main/thinqconnect/thinq_api.py
- https://github.com/thinq-connect/pythinqconnect/blob/main/thinqconnect/devices/connect_device.py
- https://github.com/thinq-connect/pythinqconnect/blob/main/thinqconnect/devices/refrigerator.py
