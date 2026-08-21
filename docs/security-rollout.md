# Security rollout

## Focus-session uniqueness

The `uniq_open_focus_session_per_user` partial unique index is declared in the
Mongoose schema, but production auto-indexing is disabled. Roll out in this order:

1. Back up the `focussessions` collection and deploy neither the index nor the
   endpoint changes yet.
2. Run `npm run repair-focus-sessions` against the intended database. This is a
   dry run and prints every user/session ID, the session retained, and the exact
   deterministic final values for older sessions. The newest `startedAt` (then
   greatest `_id`) is retained; older sessions end when the retained session
   began, with active pauses closed at that timestamp.
3. Review the report. Run `npm run repair-focus-sessions -- --apply` only with
   an approved backup and database target.
4. Re-run the dry run; it must report no repairs. Then run
   `npm run repair-focus-sessions -- --apply --create-index`. The script refuses
   index creation while duplicates remain and never calls `syncIndexes()`.
5. Deploy the atomic endpoints. Monitor controlled `409` rates.

In production, an apply additionally requires `ALLOW_PRODUCTION_FOCUS_REPAIR=1`.
The script is never invoked by application startup. Rollback should keep the
repaired history and unique index where possible; dropping only the named index
restores the old write behavior, but should be reserved for an emergency because
it removes the database invariant.

## Authentication-version rollout

Existing sessions serialize only a user ID and therefore fail the new versioned
session check. Deployment intentionally forces a one-time login for every user.
Password reset atomically consumes its token and increments `authVersion`, which
revokes all sessions issued at an earlier version. Rollback must account for the
new serialized Passport identity shape; do not roll back only the deserializer.

## API and browser security changes

Focus Start returns `409` if an open session already exists or the unique-index
race is lost. Pause, Resume, and Stop return the same generic `409` when their
required state no longer matches. No database error detail is returned.

Registration, verification resend, and forgot-password requests with a validly
formatted email all return `202` and the same one-field response. Email-delivery
failures are recorded only as generic operational errors, and verified accounts
are never sent redundant verification mail.

The script policy now allows scripts only from the application origin and blocks
all script attributes. Application startup must be smoke-tested after rollout by
loading Login, Registration, Dashboard, and Focus with the browser console open;
verify registration messaging, signed-out redirects, restored focus state, and
Start/Pause/Resume/Stop without CSP violations.
