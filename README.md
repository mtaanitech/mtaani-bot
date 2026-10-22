# Mtaani Bot SaaS

A separate starter project for a multi-user WhatsApp Baileys bot dashboard. It does **not** modify MtaaniHost.

## Features included

- Email/password registration and login
- HTTP-only authentication cookie and admin role
- Admin user list, overview and suspend/activate actions
- Per-user Baileys session manager
- QR linking and phone-number pairing-code UI
- SQLite database with WAL and a persistent data directory
- Paystack monthly-plan checkout initialization
- Paystack webhook HMAC signature verification and server-side transaction verification
- Subscription status and 30-day access period after successful payment
- Credit wallet and idempotent monthly credit top-up on verified checkout
- GitHub repository/branch metadata linking (not arbitrary code execution)
- Basic `.menu` and `.ping` direct-message commands

## Important limitations before public launch

This is an MVP starter, not a production-audited multi-tenant hosting service.

1. **Paystack recurring billing:** configure a real monthly Plan Code in Paystack. Test with test keys first. This starter verifies the initial checkout and activates a 30-day access period after a verified successful charge. Before relying on automatic recurring renewals, add and test the matching renewal/invoice webhook events for the exact event payloads your Paystack account sends; do not assume every renewal uses the original checkout reference.
2. **Payment amount and credits:** `SUBSCRIPTION_AMOUNT_KES` is used for the server-side minimum amount check and display. Create the actual monthly plan in Paystack with the matching amount/currency. `MONTHLY_CREDITS` sets the credit amount granted after a verified successful checkout. Paystack's plan configuration is authoritative.
3. **Persistent storage:** mount a persistent disk and set `DATA_DIR` to a path on that disk. SQLite and WhatsApp auth credentials must survive redeploys.
4. **Single instance:** `useMultiFileAuthState` and this in-memory socket manager are intended for a single running instance. Do not scale to multiple instances without a distributed session lock/queue and a session-owning worker architecture.
5. **WhatsApp terms:** Baileys is an unofficial WhatsApp Web integration. Use it lawfully, avoid spam, and expect accounts may be logged out. For commercial customer messaging, evaluate the official WhatsApp Business Platform.
6. **Secrets:** never commit `.env`, Paystack secret keys, JWT secrets, pairing codes, QR images, or WhatsApp session files.
7. **GitHub linking:** the app only stores public repository URL and branch metadata. It does not clone or run customer code. Do not run arbitrary customer repositories in the web API process. Add isolated workers, quotas, sandboxing, egress policy, secret isolation, and build-time limits first.
8. **Security review:** add email verification, password reset, CSRF controls appropriate to your deployment, audit/alerting, backup/restore tests, monitoring, abuse controls, and independent security review before taking real customer payments.

## Run locally

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. Set a long random `JWT_SECRET`, `ADMIN_EMAIL`, and a strong `ADMIN_PASSWORD`.
4. Keep Paystack test credentials and a test monthly plan while developing.
5. Run:

   ```bash
   npm install
   npm start
   ```

6. Open `http://localhost:3000`.

The initial admin is created on first boot when `ADMIN_EMAIL` and `ADMIN_PASSWORD` are configured and the email does not already exist. If that admin email already exists, startup promotes it to admin; choose a unique admin email for a fresh database.

## Render deployment

- Create a new Web Service from this repository.
- Build command: `npm install`
- Start command: `npm start`
- Add environment variables from `.env.example`.
- Set `NODE_ENV=production`, `PUBLIC_URL=https://YOUR-SERVICE.onrender.com`, `COOKIE_SECURE=true`, and a random `JWT_SECRET`.
- Add a persistent disk and set `DATA_DIR` to its mount path, for example `/var/data`.
- Configure a Paystack monthly plan and use the live key only after successful test-mode validation.
- Configure Paystack webhook URL: `https://YOUR-SERVICE.onrender.com/api/payments/webhook`.

Do not deploy with placeholder secrets or test keys for live payments.

## Routes

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`
- `GET /api/wallet`
- `POST /api/payments/initialize`
- `GET /api/payments/verify/:reference`
- `POST /api/payments/webhook`
- `POST /api/whatsapp/start` with `{ "mode": "qr" }` or `{ "mode": "phone", "phoneNumber": "2547XXXXXXXX" }`
- `GET /api/whatsapp/status`
- `POST /api/whatsapp/stop`
- `POST /api/github/link` with `{ "repoUrl": "https://github.com/owner/repo", "branch": "main" }`
- `DELETE /api/github/link`
- `GET /api/admin/overview`
- `POST /api/admin/users/:id/status`
- `GET /api/admin/audit`

## Paystack webhook notes

The webhook uses the exact raw request body and validates `x-paystack-signature` with HMAC SHA-512. It processes a `charge.success` event for a payment reference created by this app, calls Paystack's verify endpoint, and checks currency, plan and minimum configured amount before changing subscription state. Payment references are unique and successful events are idempotent. Automatic recurring-renewal event mapping still needs to be implemented and tested against your Paystack account before production.

Test webhook delivery and recurring renewal/cancellation event shapes against your own Paystack dashboard before production.
