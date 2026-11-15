# Existing-session recovery check — November 15, 2026

## Verified findings

The unchanged LG app-channel identity can still authenticate and read the configured refrigerator, but access is intermittent.

- At 6:05 PM Eastern, [status check 43772880277](https://github.com/hillynew/lg-shabbat-fridge/actions/runs/43772880277) succeeded. The configured ID matched exactly, the refrigerator reported online and Sabbath OFF, and its snapshot was about 15 minutes 50 seconds old. No controls, identity changes, or retries occurred.
- At 6:09 PM Eastern, [commissioning test 43773227647](https://github.com/hillynew/lg-shabbat-fridge/actions/runs/43773227647) stopped on its initial dashboard read with HTTP 400 / LG 9006. It never reached the first control attempt. **Zero appliance commands were sent.**
- Both live jobs passed their offline tests first. The combined suite has 19 tests covering request bounds, unchanged identity, redaction, control payload scope, command count, newer readback, and ON/OFF restoration logic.
- The temporary workflows are now explicitly inert (job condition false, no push or schedule triggers). Their source and logs are retained for review on recovery/existing-session-check.
- The main controller, held Cloudflare deployment, credentials, and production schedule were not modified. Automated control is not restored.

## Implications

A successful read does not establish working control. The former adapter's failure to expose LG's HTTP error response explains the missing error detail, but does not establish that restoring its client-ID rotation would provide dependable service. No identity rotation or access-denial workaround was attempted.

The commissioning code only permits an initially reported OFF refrigerator, allows at most one ON and one subsequent OFF command, and requires newer matching snapshots before advancing. Its initial 30-minute status allowance applies only to that deliberate test; production freshness rules were not changed. This behavior was tested offline, but no live control path ran because the initial dashboard request was rejected.

## Remaining action

Inspect the LG ThinQ phone app's Smart Sabbath scheduling screen. LG documents native scheduling on some models, but compatibility and calendar support are not confirmed for this refrigerator. Check Shabbos plus Diaspora Yom Tov, noon starts, sunset-plus-60-minute ends, and uninterrupted adjoining days before enabling a schedule.

Mac access was blocked by the locked screen. The user must unlock the Mac before phone-app inspection can continue. If native scheduling is absent or insufficient, renewed authorized LG access and successful bounded command/readback testing are required before deploying a custom scheduler.

No paid resources were created.
