# PiTill backend

Node.js 18+ API for PiTill payment requests and Pi payments.

## Setup

1. Install Node.js 18 or later and MySQL.
2. Create the database and tables by running `schema.sql` (it creates/uses the `pitill` database).
3. Run `npm install`.
4. Copy `.env.example` to `.env`, then set your Pi server API key and database credentials. Keep `.env` private and never commit it.
5. Start with `npm start`.

The API listens on port 3000 by default. `APP_URL` is used to form payment links. For a separately hosted browser frontend, configure `CORS_ORIGINS` as a comma-separated allowlist; with no value, cross-origin browser requests are not enabled.

## Payment SDK integration requirement

When creating a Pi payment in the frontend, include the payment-request code in the Pi payment metadata:

```js
metadata: { public_code: requestCode }
```

The backend verifies that the payment's Pi user UID, amount, and metadata all match before approving it. This prevents a valid payment from being attached to another user's request or a different invoice.

Use the Pi SDK callbacks to call:

- `POST /api/payments/approve` with `{ "paymentId": "...", "code": "..." }` from the server-approval callback.
- `POST /api/payments/complete` with `{ "paymentId": "...", "txid": "..." }` from the server-completion callback.
- `POST /api/payments/cancel` with `{ "paymentId": "..." }` for a cancelled, not-yet-approved payment.

All authenticated routes require `Authorization: Bearer <Pi access token>`. The public payment lookup is `GET /api/requests/:code`.

## Notes

- Payment completion is authorized only for the payer recorded at approval, requires an approved payment, and marks the request paid in the same database transaction.
- Pi payment completion can take time; database row locks are held while the Pi completion request is in flight to prevent a second payment from marking the same request paid concurrently.
- Verify current Pi Developer Platform API response fields and SDK callback behavior against the official documentation before production deployment.
