## Stick A Pin

Link: www.stickapin.app

## Adding Google + Apple Login/Registration (Implementation Guide)

This app already uses:
- `passport` + session auth (`express-session`, `connect-mongo`)
- a local email/password strategy in `config/passport-config.js`
- `/register` and `/login` routes in `server.js`

The cleanest path is to add **Passport OAuth strategies** for Google and Apple, then support provider-linked users in the `User` schema.

### 1) Install the OAuth strategy packages

```bash
npm install passport-google-oauth20 passport-apple
```

### 2) Extend the `User` model for social identities

In `config/models/user.js`, add optional identity fields so one account can be linked to local + social providers:

- `authProviders.google.id`
- `authProviders.apple.id`
- `avatarUrl`
- make `passwordHash` optional (or conditionally required) for OAuth-only users

Recommended schema shape:

```js
passwordHash: { type: String, default: null },
authProviders: {
  google: {
    id: { type: String, default: null, index: true },
    email: { type: String, default: null },
  },
  apple: {
    id: { type: String, default: null, index: true },
    email: { type: String, default: null },
  },
},
avatarUrl: { type: String, default: null },
```

Also add sparse unique indexes for provider IDs to prevent duplicates:

```js
UserSchema.index({ "authProviders.google.id": 1 }, { unique: true, sparse: true });
UserSchema.index({ "authProviders.apple.id": 1 }, { unique: true, sparse: true });
```

### 3) Keep local auth, add Google + Apple strategies

In `config/passport-config.js`:

1. Keep the existing `LocalStrategy`.
2. Add `GoogleStrategy` and `AppleStrategy`.
3. In each strategy callback:
   - normalize email
   - find existing user by provider ID first
   - if not found, try existing user by email and **link** provider ID
   - if no user exists, create one (set `emailVerified = true` for trusted providers)
4. Continue using the same session serialize/deserialize logic.

### 4) Add OAuth routes in `server.js`

Add endpoints:

- `GET /auth/google`
- `GET /auth/google/callback`
- `GET /auth/apple`
- `POST /auth/apple/callback` (Apple often posts back)

On success:
- call `req.logIn(user, ...)` via Passport callback flow
- redirect to `/dashboard.html`

On failure:
- redirect to `/login.html?error=sso_failed`

### 5) Add environment variables

Add the following env vars:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_CALLBACK_URL` (e.g. `https://your-domain.com/auth/google/callback`)
- `APPLE_TEAM_ID`
- `APPLE_KEY_ID`
- `APPLE_PRIVATE_KEY` (or `APPLE_PRIVATE_KEY_PATH`)
- `APPLE_CLIENT_ID` (Service ID)
- `APPLE_CALLBACK_URL` (e.g. `https://your-domain.com/auth/apple/callback`)

Also make sure:
- `SESSION_SECRET` is strong and set
- production has HTTPS enabled (required for secure session cookies and OAuth redirects)

### 6) Update login/register UI

In `public/login.html` and `public/register.html`, add buttons:

- “Continue with Google” → `/auth/google`
- “Continue with Apple” → `/auth/apple`

No frontend token handling is required since this app uses server sessions.

### 7) Handle account-linking edge cases

Recommended behavior:

- if provider email matches an existing local account, link it after a safe confirmation path
- if Apple returns private relay email, still store provider ID as primary stable key
- if a provider does not return email on subsequent logins (Apple can do this), rely on provider ID

### 8) Security checklist

- validate callback origins and exact redirect URIs
- set session cookies with `httpOnly`, `secure`, `sameSite=lax` (or stricter as compatible)
- add rate limits to OAuth initiation/callback routes
- log auth events (login success/failure, provider link/unlink)

### 9) Suggested rollout

1. Ship Google first (simpler provider behavior)
2. Add Apple once Google flow and account-linking are stable
3. Backfill existing users by linking accounts on next social login

---

If you want, the next step is to implement this directly in:
- `config/models/user.js`
- `config/passport-config.js`
- `server.js`
- `public/login.html`
- `public/register.html`

and wire a complete working version end-to-end.
