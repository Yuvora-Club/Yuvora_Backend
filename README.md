# Yuvora_Backend

Express API for yuvora.org. Node >= 20, ES modules, deployed on Render at
https://yuvora-backend.onrender.com.

## Run locally

```bash
cd Backend
copy .env.example .env   # then fill FIREBASE_* from the Firebase console
npm install
npm run dev              # http://localhost:4000
npm test                 # unit tests for the money helpers (node:test)
```

## Environment

Copy `.env.example` and fill it in. The important groups:

| Group | Vars | Notes |
| --- | --- | --- |
| Server | `PORT`, `FRONTEND_URL` | `FRONTEND_URL` is a comma-separated CORS allow-list; must include the live domain. |
| Firebase | `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_DATABASE_URL` | Service-account credentials. NEVER commit `.env`. |
| Auth | `FIREBASE_WEB_API_KEY` | For password login + reset emails. |
| Payments | `UPI_ID`, `PAYEE_NAME`, `ENTRY_FEE_PER_TEAM`, `FEE_MODE`, `FEE_PER_PLAYER`, `MAX_TEAMS`, `ORDER_EXPIRY_HOURS`, `REFUND_NOTE` | See below. |
| Pay dashboard | `ADMIN_PASSWORD_HASH`, `PAY_ADMIN_SECRET` | See below. |
| CAPTCHA | `CAPTCHA_SITE_KEY`, `CAPTCHA_SECRET` | Cloudflare Turnstile. |

## Team entry-fee payments (manual UPI)

Sports-event teams pay an entry fee from the captain's team card on the Sports
page. There is no payment gateway: the captain creates an order, pays the club
UPI id, and pastes the 12-digit UTR. The crew confirms it in a standalone
dashboard at `/pay-admin` (linked from the admin portal sidebar).

The browser is never trusted for money. The server:

- computes the fee (per-sport fee → event entry fee → env fallback),
- allocates a unique paise value (₹x.01 … ₹x.99) so each transfer is
  identifiable in the bank statement,
- enforces an optional team cap and order expiry with atomic RTDB
  transactions,
- enforces UTR uniqueness,
- only flips the team's `paid` flag when a pay-admin confirms the order.

### Going live with real UPI (no code change)

Payments stay dormant while `UPI_ID` is `PLACEHOLDER_UPI_ID`: the captain UI
shows "Payments opening soon" and no UPI link or QR is built. To open them:

1. Set `UPI_ID` to the club's real UPI id and `PAYEE_NAME` to the account name
   on bank statements (Render → service → Environment, then redeploy).
2. Optionally set the fee fallbacks (`ENTRY_FEE_PER_TEAM`, `FEE_MODE`,
   `FEE_PER_PLAYER`), the global cap (`MAX_TEAMS`, 0 = no cap, per-event
   `maxTeams` overrides it), `ORDER_EXPIRY_HOURS` and `REFUND_NOTE`.
3. Optionally set `CAPTCHA_SITE_KEY` + `CAPTCHA_SECRET` (Cloudflare Turnstile).
   While the secret is a placeholder the check is skipped and the widget is
   hidden.

Per-event fees are set by admins on the event form (`entryFee`, per-sport
overrides, `maxTeams`) and always win over the env fallbacks.

### Payments dashboard password

The dashboard does NOT use the Firebase admin login — it has its own password:

```bash
npm run pay:pass            # prompts (hidden input), or:
npm run pay:pass -- "my secret"
```

Paste the printed `ADMIN_PASSWORD_HASH=scrypt$...` into the environment (local
`.env` and Render). Optionally set `PAY_ADMIN_SECRET` to a long random string;
by default the session signing key is derived from the hash. NEITHER value
goes in git.

Sessions are stateless HMAC tokens (8 h) returned by `POST /api/pay-admin/login`
and sent back as `Authorization: Bearer <token>` — a deliberate deviation from
cookie sessions because the frontend (yuvora.org) and API (onrender.com) are
cross-site with `credentials: false` CORS.

### Routes

Member (Firebase ID token):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/pay/config` | safe public bits (upi id presence, fee fallbacks, expiry) |
| GET | `/api/teams/:teamId/payment` | fee preview + this team's active order (captain sees it) |
| POST | `/api/teams/:teamId/order` | captain creates / revives the order (Turnstile-gated) |
| GET | `/api/pay/orders/:orderId` | load one order (its captain or an admin) |
| POST | `/api/pay/orders/:orderId/utr` | captain submits the 12-digit UTR |

Pay-admin (dashboard password token):

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/pay-admin/login` / `logout` | issue / drop a session token |
| GET | `/api/pay-admin/orders?status=` | order queue, newest first |
| GET | `/api/pay-admin/summary` | status counts + total collected |
| POST | `/api/pay-admin/orders/:orderId/status` | Confirm / Reject / NeedsRefund / Refunded |
| GET | `/api/pay-admin/orders.csv` | spreadsheet export |

Confirming an order sets `teams/{teamId}.paid = true` so the existing admin
team inspector shows it; moving it back off Confirmed clears the flag again.

### Expiry

Pending orders expire after `ORDER_EXPIRY_HOURS` — lazily whenever the order is
read, and in bulk via the optional cron:

```bash
npm run pay:expire
```

Both release the team slot and the unique paise, and clear the team→order
index.

### Storage (Realtime Database)

```
paymentOrders/{orderId}                order record (status, utr, amounts…)
paymentOrdersByTeam/{teamId}           -> orderId (one active order per team)
paymentOrdersByUtr/{utr}               -> orderId (UTR uniqueness)
paymentPaise/{1..99}                   -> orderId (unique-paise allocation)
paymentEventCounters/{eventId}/used    occupied team slots
payAudit/{pushId}                      dashboard action log
```

### Tests

`npm test` runs `node:test` against the pure helpers exported from
`src/routes/payments.js` (fee precedence, cap, UPI link amounts, id/path
guard, CSV escaping, password verification). The RTDB transaction paths
(paise allocation, UTR claims, slot cap, expiry) are exercised by the manual
smoke checklist, since they need live credentials.
