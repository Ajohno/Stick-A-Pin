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

Backfill legacy users before relying exclusively on the versioned session lookup:

1. Run `npm run backfill-auth-version` against the intended database. The default
   dry run reports how many users have no stored `authVersion`.
2. Review the database target and backup, then run
   `npm run backfill-auth-version -- --apply`.
3. Re-run the dry run and require `remaining: 0` before completing rollout.

In production, apply additionally requires
`ALLOW_PRODUCTION_AUTH_VERSION_BACKFILL=1`. During the rolling deployment, a
version-zero session may match a legacy missing field and atomically persists it
as zero. Legacy ID-only sessions still fail closed. Password reset atomically
consumes its token and increments `authVersion`, so every earlier version is
revoked. Rollback must account for the serialized Passport identity shape; do
not roll back only the deserializer.

## Password reset and OAuth policy (#299)

Password reset requires an existing, nonempty local password hash:

- Local-only accounts may reset their password.
- Accounts with both a local password and Google linkage may reset their password.
- Google-only accounts cannot establish a local password through Forgot Password.
  They receive no reset token or reset email.
- Reset completion also checks eligibility, blocking previously issued tokens
  from establishing a password on Google-only accounts.

Validly formatted forgot-password requests receive the same generic public
acknowledgment regardless of account existence or authentication method.

A successful reset atomically replaces the password hash, clears the reset
token fields, and increments `authVersion`. Every earlier Stick A Pin session
then fails authentication on its next request, including sessions created
through Google. Old cookies receive `401` on protected APIs.

Google linkage remains intact. This does not revoke the user's Google account
session or provider tokens. The user may sign in again through Google, or
through the new local password, to obtain a valid Stick A Pin session.

## Password-reset security logging

After a successful reset, the server emits a structured
`password_reset_sessions_revoked` event containing:

- `timestamp`
- `userId` (internal account ID)
- `reason` (`password_reset`)
- `authVersion` (the resulting version)

The event excludes passwords, password hashes, reset tokens, token hashes,
cookies, email addresses, and request bodies.

Rejected reset attempts do not emit this success event.

## Local verification for #299

The developer's local PowerShell run of `npm test` reported 40 passed,
0 failed, and 0 skipped, with `TEST_MONGO_URI=mongodb://127.0.0.1:27018`
pointing to the isolated `stickapin-299-test-mongo` container (`mongo:7`).
The same full suite was rerun after formatting cleanup and again passed all
40 tests with no failures or skips.

Coverage includes:

- Generic account-action responses and worker reset eligibility for local,
  Google-only, and Google-linked accounts.
- Real reset-handler execution against MongoDB, legacy authentication-version
  backfill, token reuse rejection, Google-only reset rejection, and preservation
  of Google linkage during an eligible reset.
- A single structured success event containing only the documented fields,
  and no success event for a rejected reset.
- Two distinct HTTP session cookies working before reset and receiving `401`
  afterward; the old password failing login and the new password creating a
  working session.

The HTTP test uses an isolated Express server with the application's Passport
configuration, reset handler, and authentication guard, plus an in-memory
session store. It does not exercise the full deployed application's middleware,
MongoDB session storage, or a live Google OAuth exchange. These local results
do not establish CI or deployment verification.

## API and browser security changes

Focus Start returns `409` if an open session already exists or the unique-index
race is lost. Pause, Resume, and Stop return the same generic `409` when their
required state no longer matches. No database error detail is returned.

Registration, verification resend, and forgot-password requests with a validly
formatted email all write the same encrypted MongoDB outbox record and return
`202` with the same one-field response. Account lookup, token persistence, and
email-provider I/O happen only after that response. Vercel `waitUntil` handles
the immediate attempt, while the protected daily cron retries durable jobs. Set
`CRON_SECRET` in every deployed environment; Vercel sends it as a Bearer token.
Email-delivery failures are recorded only as generic operational codes, expired
jobs are removed, and verified accounts are never sent redundant verification
mail. Because production disables Mongoose auto-indexing, run
`npm run setup-account-action-jobs` as a dry run, then use
`npm run setup-account-action-jobs -- --apply`. Production apply additionally
requires `ALLOW_PRODUCTION_ACCOUNT_ACTION_INDEX_SETUP=1`. Verify that neither
`account_action_jobs_ready` nor `account_action_jobs_expiry` remains missing.

The script policy now allows scripts only from the application origin and blocks
all script attributes. Application startup must be smoke-tested after rollout by
loading Login, Registration, Dashboard, and Focus with the browser console open;
verify registration messaging, signed-out redirects, restored focus state, and
Start/Pause/Resume/Stop without CSP violations.
