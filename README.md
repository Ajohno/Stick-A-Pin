# Stick A Pin — Release Notes

 
## v1.0.0 (MVP Public Launch)
 
### 🎉 Highlights
- Public MVP launch of Stick A Pin at **https://www.stickapin.app**.
- Core task planning workflow with board and calendar views.
- Focus sessions with duration tracking.
- Daily reflection email support and user notification preferences.
 
### ✅ Core Features Included
- Account registration and login with secure session-based authentication.
- Email verification flow for newly created accounts.
- Forgot-password and secure reset-password flow.
- Google OAuth sign-in support (when provider credentials are configured).
- Task CRUD (create, read, update, delete) operations.
- Board preferences (default sort and default view).
- Feedback reporting workflow with attachment support.
 
### 🔒 Security & Reliability
- CSRF protection for session-backed endpoints.
- Rate limiting on authentication, verification, reset, feedback, and webhook routes.
- HTTP-only session cookies with production HTTPS enforcement.
- Signed webhook verification for inbound Resend events.
- Request payload size limits and robust server-side validation.
 
### 🧩 Platform & Stack
- Node.js + Express backend.
- MongoDB with Mongoose models.
- Passport-based authentication (local + Google OAuth).
- Vercel-compatible deployment settings.
 


## Expo Go setup (mobile client)

A starter Expo app has been added in `mobile/`.

### 1) Start the backend API

From repo root:

```bash
npm install
npm start
```

### 2) Start the Expo app

From `mobile/`:

```bash
npm install
cp .env.example .env
# Set EXPO_PUBLIC_API_BASE_URL to your backend URL
npm run start
```

Then scan the Expo QR code in the Expo Go app.

### 3) Networking notes for real devices

- Do **not** use `localhost` for `EXPO_PUBLIC_API_BASE_URL` when testing on your phone.
- Use your machine's LAN IP (for example, `http://192.168.1.50:3000`) or a hosted backend URL.
- Keep your phone and computer on the same network for LAN testing.

