# Control restored in a one-time test — November 16, 2026

Automatic scheduling is **still off**. This records one successful, owner-authorized ON/OFF test.

## Result

[Run 43889368364](https://github.com/hillynew/lg-shabbat-fridge/actions/runs/43889368364), commit `9b0688e`, 9:47 AM EST:

| Step | Outcome |
| --- | --- |
| Initial dashboard read | LG 9006, then accepted after one client-id rotation. Fridge online, Sabbath OFF. |
| ON command | LG 9006, then accepted after a second rotation. A newer snapshot reporting ON arrived within about 5 seconds. |
| OFF command | Accepted first time. A newer snapshot reporting OFF arrived within about 5 seconds. |

Two control requests were sent in total and the fridge was left OFF. "Verified" means LG's cloud returned a newer snapshot with the expected state; nobody looked at the fridge.

## What this establishes

- The existing credentials can still read and control the fridge on the app channel.
- The failures since November 13 came from code that stopped on 9006 instead of rotating the client id and repeating the request, as `src/thinqV2.js` and upstream wideq do.
- A freshly rotated id was itself rejected once (on the first control request), so a controller needs the retry on every request, not a single rotation at start-up.
- The dashboard snapshot timestamp is not a heartbeat: it was 74 minutes old before the test and updated within seconds of each command.

## Not done

- The Cloudflare Worker (`feat/free-worker-shadow`) still keeps the client id fixed and remains held with no cron.
- `Shabbat mode tick` remains disabled.
- No failure alerting exists.

The test workflow `retry-cycle-once.yml` is retired with a false job gate.
