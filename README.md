# AayPlus backend

Node.js, Express 5 and SQLite (`better-sqlite3`). The API stores users, sessions, listings, bookings, inspections, disputes, accounting intentions and an audit trail. Data survives server restarts.

Requires Node.js 20.19+ and npm. No Python runtime is used.

## Run locally

```sh
cd AayPlus-Backend
nvm use # optional; .nvmrc pins the development Node version
npm ci
cp .env.example .env
npm run dev
```

The API starts at `http://127.0.0.1:8080`. Check `GET /health`.

```sh
npm test
npm run check
npm start
```

The `.env` file is loaded by dotenv. Keep it out of Git. SQLite files live in `data/` by default; use a persistent disk for this directory. Tests use isolated temporary databases, never the development database.

## Create the first admin

1. Request a development OTP:

```sh
curl -X POST http://127.0.0.1:8080/api/v1/auth/otp \
  -H 'Content-Type: application/json' \
  -d '{"phone":"+919876543210"}'
```

2. Use the returned `data.developmentCode` to sign in. New users must provide a name:

```sh
curl -X POST http://127.0.0.1:8080/api/v1/auth/verify \
  -H 'Content-Type: application/json' \
  -d '{"phone":"+919876543210","code":"REPLACE_WITH_SIX_DIGIT_CODE","name":"Marketplace Admin"}'
```

3. Promote that account using the local operator command in another terminal:

```sh
npm run admin:promote -- promote-admin +919876543210
```

There is no public endpoint or signup field that grants administrator access. Existing sessions read the current role on every request. Store the returned token securely and send `Authorization: Bearer YOUR_TOKEN` on authenticated endpoints. Logout revokes the session immediately. Sessions expire after seven days.

4. For development testing, an admin can mark a member verified:

```sh
curl -X POST http://127.0.0.1:8080/api/v1/admin/users/USER_ID/kyc \
  -H 'Authorization: Bearer YOUR_ADMIN_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"status":"verified"}'
```

Members need verified identity to create listings and request bookings. A member can both rent items and host their own items; renter/host UI mode does not grant privileges. Resource ownership controls the available actions.

## API conventions

All routes below use `/api/v1`. Successful responses contain `{ "data": ... }`. Collections contain `{ "data": { "items": [], "limit": 50, "offset": 0 } }`; use `?limit=50&offset=0` with a maximum limit of 100. Errors contain `{ "error": { "message": "...", "requestId": "..." } }`.

Send `Content-Type: application/json` and a JSON object for POST/PATCH, including `{}` for actions without fields. Money uses **integer paise**, so ₹120 is `12000`. Currency is INR. Datetimes on creation use ISO 8601 with timezone; stored/output timestamps are Unix seconds in UTC. Prices are always calculated on the server, ignoring supplied client totals.

| Method | Route | Access / purpose |
| --- | --- | --- |
| POST | `/auth/otp` | Public; `{phone}` |
| POST | `/auth/verify` | Public; `{phone, code, name}`; name required for new users |
| POST | `/auth/logout` | Authenticated; revoke current token |
| GET | `/me/listings` | Authenticated host; own active and archived listings |
| GET / PATCH | `/me` | Current account; editable fields: `name`, `email` |
| GET | `/listings` | Public; filters: `q`, `category`, `location` |
| GET | `/listings/:id` | Public active listing |
| POST | `/uploads/videos?booking_id=:id` | Verified host; raw MP4/MOV, up to 50 MB and 60 seconds |
| GET | `/evidence/:name` | Booking host/renter or admin; private media, supports range requests |
| POST | `/uploads` | Verified member; raw image bytes with `Content-Type: application/octet-stream`, up to 8 MB |
| POST | `/listings` | Verified member; create owned listing |
| PATCH | `/listings/:id` | Owner/admin; `{active: false}` archives listing |
| POST | `/bookings/quote` | Verified renter; calculate price and check availability |
| POST | `/bookings` | Verified renter; create a reservation request |
| GET | `/bookings` | Account's bookings |
| GET | `/bookings/:id` | Renter, host or admin; includes inspection evidence |
| POST | `/bookings/:id/approve` | Host; approve pending request |
| POST | `/bookings/:id/reject` | Host; reject pending request |
| POST | `/bookings/:id/cancel` | Renter/host; before rental starts |
| POST | `/bookings/:id/sign` | Each party signs for their own account |
| POST | `/bookings/:id/pickup` | Host; `{notes, photos, videos}`; both signatures and start time required |
| POST | `/bookings/:id/return` | Host; `{notes, photos, videos}` |
| POST | `/bookings/:id/complete` | Host; close return without damage claim |
| POST | `/bookings/:id/claim` | Host; `{claim_paise, description}` after return |
| GET | `/disputes` | Account's disputes |
| POST | `/disputes/:id/response` | Renter; `{response}` |
| GET | `/ledger` | Account's accounting intentions |
| GET | `/admin/stats` | Admin; counts derived from database |
| GET | `/admin/users` | Admin; member accounts |
| GET | `/admin/listings` | Admin; active and archived listings |
| GET | `/admin/bookings` | Admin; all bookings |
| GET | `/admin/disputes` | Admin; all disputes |
| GET | `/admin/ledger` | Admin; accounting intentions |
| GET | `/admin/audit` | Admin; recorded operational actions |
| POST | `/admin/users/:id/kyc` | Admin; development-only `{status: "verified" or "rejected"}` |
| POST | `/admin/disputes/:id/resolve` | Admin; `{settlement_paise, notes}` |

Create a listing:

```json
{
  "title": "Sony A7 camera kit",
  "category": "Cameras",
  "description": "Camera, lens, battery and carry bag.",
  "location": "Sector 62, Noida",
  "hourly_paise": 12000,
  "daily_paise": 60000,
  "weekly_paise": 300000,
  "deposit_paise": 300000,
  "photos": ["https://example.com/camera.jpg"]
}
```

Quote or create a booking:

```json
{
  "listing_id": "REPLACE_WITH_LISTING_ID",
  "start": "2027-01-15T09:00:00+05:30",
  "end": "2027-01-15T13:00:00+05:30"
}
```

Choose future dates when testing. Duration rounds up to the next hour. Pricing selects the cheapest combination of hourly, daily and weekly packages, including rounding up to a cheaper package, and adds a fixed ₹30 platform fee plus refundable deposit. Rental length is limited to 90 days. A quote does not reserve inventory; booking creation checks again inside an immediate SQLite transaction.

## Rental flow

```text
requested → approved → both parties sign → pickup → active
         ↘ rejected                            ↓ return
         ↘ cancelled                       return_review
                                             ↙       ↘
                                       complete      claim
                                          ↓            ↓
                                      completed     disputed
                                                       ↓ admin resolution
                                                   completed
```

The host and renter must use separate authenticated accounts. The renter creates a request and stays on a renter-facing confirmation screen; the host independently fetches requests and approves. Poll `GET /bookings` for changes until push notifications are added. The API rejects cross-account access and invalid state changes.

Pending requests reserve their selected interval until approved, rejected or cancelled. They currently do not expire automatically. Adjacent bookings are allowed. Overlaps with requested, approved, active, return-review or disputed bookings are blocked.

A damage claim cannot exceed the deposit. A settlement cannot exceed the claim. Settlement and completion write their accounting records in the same transaction as the state change. Repeated settlement cannot duplicate ledger entries.

## Connected clients

Both clients now use this API by default. See [the shared setup guide](../INTEGRATION.md) for the complete startup and verification flow.

- Flutter signs in through OTP, loads listings/bookings/account data, creates quotes and requests, manages host approvals/inspections/claims, and reads admin decisions from the shared backend.
- Next.js admin signs in with an administrator account and loads real database collections. Verification, listing archival and dispute resolution are API writes.
- Clients refresh every 15 seconds and after their own writes; changes are shared through SQLite rather than direct client-to-client messages.
- Bearer tokens stay in client memory. Restarting the app or reloading the admin tab requires sign-in. Accounts and marketplace records remain in SQLite.
- The old mock presentation files are retained as reference; the default entry points use the connected flows and do not import mock data. API errors show explicit error/retry states.

## Provider boundaries and deployment limits

This is a runnable backend foundation, not a configured payment or identity service.

- `APP_ENV=development` returns generated OTP codes in the response and permits admin verification for testing. It must not be exposed publicly. Outside development, OTP delivery and KYC review return HTTP 503 until real providers are integrated.
- No payment is captured. Ledger rows named `rental_due`, `damage_due` and `deposit_release_due` describe accounting intentions, **not completed payouts or refunds**. No escrow balance is claimed. A real gateway integration must add verified webhooks, idempotent captures/refunds and payment-state checks before rental fulfillment.
- Listing photos can be uploaded from the app camera or library. `POST /uploads` accepts authenticated raw image bytes (up to 8 MB), decodes and normalizes them to JPEG, strips metadata and resizes to a maximum of 1600 × 1600. It returns a relative `/media/<id>.jpg` reference. New listings may only attach uploaded references owned by their account; external HTTPS references remain supported. Files persist in `UPLOAD_DIRECTORY` (default `data/uploads`), which must be backed up with SQLite. Listing images are public. There is a 100-image/account/day upload limit. Object storage and orphan-file cleanup are not implemented.
- Agreement signing records account acknowledgements; it is not a legal e-signature integration. Cancellation has no monetary policy yet because there are no real payments.
- Request limits are per-process and keyed by socket IP. Configure a trusted reverse proxy deliberately; use a shared rate-limit store for multiple instances. TLS should terminate at the reverse proxy. The Express development server is not an internet-facing deployment configuration.
- Keep SQLite on one persistent host with backups. Use versioned migrations and a shared database before scaling across multiple API instances. Schema version 1 is initialized automatically; there is no upgrade migration runner yet.
- Add request expiration, notifications, refresh sessions, provider integrations and payment integrations before production use.

### Private inspection media

For inspection photos, use `POST /uploads?booking_id=BOOKING_ID`; for videos use `POST /uploads/videos?booking_id=BOOKING_ID`. Both accept raw `application/octet-stream` with bearer authentication. Only the verified booking host may upload for an approved/active handover. Responses return a `/api/v1/evidence/...` URL; render it against the API origin with the authenticated account's bearer header. These assets are not accessible via public `/media` routes. Old external HTTPS photo references remain readable for existing inspections.

Submit handovers as `{ "notes": "Condition checked", "photos": ["/api/v1/evidence/PHOTO.jpg"], "videos": ["/api/v1/evidence/VIDEO.mp4"] }`. Either array may be empty, but at least one piece of evidence is required. Videos are limited to two per inspection and validated for a video stream, container, supported encoding and duration using bundled FFprobe. SQL initialization adds the new inspection-video and upload-booking columns without discarding existing records. Back up SQLite and the upload directory together.
