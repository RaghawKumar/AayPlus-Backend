# Supabase database and media setup

The Express API runs on a Node host such as Render Free. Supabase provides
PostgreSQL and persistent object storage. Netlify can continue hosting the admin;
this change does not turn the API into a Netlify Function.

## 1. Environment

Use Node 20.19.6 (`nvm use`) and `npm ci` in the backend directory.
Keep the existing `.env` file; add these values without committing secrets:

```dotenv
APP_ENV=production
HOST=0.0.0.0
DATABASE_URL=postgresql://postgres.PROJECT_REF:ENCODED_PASSWORD@POOLER_HOST:5432/postgres?sslmode=require
SUPABASE_URL=https://PROJECT_REF.supabase.co
SUPABASE_SECRET_KEY=YOUR_SERVER_ONLY_SECRET_KEY
SUPABASE_LISTING_BUCKET=listing-images
SUPABASE_EVIDENCE_BUCKET=inspection-evidence
CORS_ORIGINS=http://localhost:3000,https://YOUR-ACTUAL-ADMIN.netlify.app
```

Copy the **Session pooler** URI from Supabase → Connect. Replace the password
placeholder with the database password, URL-encoded. This is not an API key.
Session pooling provides IPv4 access for a long-running Node service. Use the
TLS configuration recommended in the Connect panel; never disable certificate
verification as a workaround. See [Supabase connections](https://supabase.com/docs/guides/database/connecting-to-postgres).

`SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_JWKS_URL` are not needed by this API.
Existing AayPlus sessions are retained; this migration does not adopt Supabase Auth.
Never send the secret key or database URI to Flutter, browser code, or a
`NEXT_PUBLIC_` variable. DATABASE_PATH/UPLOAD_DIRECTORY remain local SQLite fallback
and import-source settings only. Partial Supabase configuration fails at startup
rather than silently saving production data on an ephemeral filesystem.

For the Render deployment, `CORS_ORIGINS` must contain the exact origin of each
admin client (scheme and host, without a path). For local admin development use
`http://localhost:3000`; add the deployed admin origin as another comma-separated
value. Update the environment variable in Render and redeploy/restart the service
after changing it.

## 2. Initialize once from your computer

```sh
npm run db:migrate
npm run storage:setup
```

The idempotent SQL migration creates the **aayplus** schema, enables RLS, and
revokes PUBLIC privileges. Connect as Supabase's database owner (`postgres` in the
pooler URI). Do not expose `aayplus` in the Supabase Data API schema settings or
grant access to anon/authenticated roles. To see tables in the dashboard, select
the aayplus schema. No user passwords or API keys are stored in the migration.

Both Storage buckets are **private** and have no browser upload policies. The
API serves listing images publicly through `/media/:name` after checking metadata;
inspection evidence additionally requires an authorized booking participant/admin.
No signed evidence URLs are exposed. Range requests are forwarded for video playback.
Files stream through the backend; short-lived local video files are used only for
FFprobe validation and removed afterwards. No persistent Render disk is required.
See [Supabase private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals).

### Optional: preserve existing SQLite records and media

Stop the old API and back up the SQLite database and uploads together. With
DATABASE_URL pointing to an **empty migrated target**, keep DATABASE_PATH and
UPLOAD_DIRECTORY pointing to the old local data, then run:

```sh
npm run db:import-sqlite
```

The importer copies IDs, accounts, sessions, bookings, accounting and upload files;
it never overwrites nonempty target tables or modifies the source. A database
failure rolls back its SQL transaction and attempts to remove copied objects.
If cleanup fails, inspect/remove orphan objects before retrying. Stop all old API
writers during import. This command is intended for small initial datasets.

## 3. Verify and deploy

```sh
npm run check
npm test
npm start
```

Open `/health`, then `/api/v1/listings`. In production, OTP requests still return
503 until a real SMS provider is integrated (unless explicit static test mode is
enabled). KYC supports the manual admin review mode described below; payments
remain a provider boundary. Do not set APP_ENV=development on a public service to bypass this.

In Render create a **Free Node Web Service**, build `npm ci`, start `npm start`,
health path `/health`. Use the backend repository root (or root directory
AayPlus-Backend in a monorepo). `render.yaml` includes the equivalent settings.
Copy the production environment variables into Render's dashboard; `.env` is local
and ignored by Git. Let Render provide PORT. Run schema/storage setup before the
first deploy, and rerun migrations explicitly for future schema changes.

Set admin NEXT_PUBLIC_API_BASE_URL and Flutter API_BASE_URL to
`https://aayplus-backend.onrender.com/api/v1`, then rebuild each client.

Render Free can sleep, so requests after idle periods can be slow. Free Supabase
storage/database/egress limits still apply, especially to inspection videos.
The API currently uses per-process rate limits keyed by socket IP. Proxy trust is
still disabled: behind Render, users may share a proxy's request budget. A deliberate
trusted-proxy/shared rate-limit configuration is separate from storage migration.

## PostgreSQL regression tests

Use a **disposable local database**, never the live Supabase project:

```sh
TEST_DATABASE_URL=postgresql://postgres@localhost:5432/aayplus_test npm run test:postgres
```

This creates the schema and **truncates its application records** between tests.
It runs the same HTTP/marketplace suite on PostgreSQL plus a two-connection
reservation race. Default `npm test` uses temporary SQLite databases and mocked
Storage responses. PostgreSQL mutations use a transaction-scoped advisory lock to
preserve SQLite BEGIN IMMEDIATE serialization for booking/settlement checks across
instances. This prioritizes correctness at initial scale; fine-grained locks and
shared rate limits are needed before increasing throughput.

## Temporary static OTP login

For the current testing period, set these on the **Render backend service**:

```dotenv
APP_ENV=production
AUTH_OTP_MODE=static
STATIC_OTP_CODE=123456
CORS_ORIGINS=https://aayplus-admin.netlify.app,http://localhost:3000,http://localhost:7357
```

Save the environment changes and redeploy the updated backend code. Local `.env`
changes do not update Render. Request a code normally in either client, then enter
123456 manually; no SMS is sent and the API does not return the shared code.
Codes still require a prior request, expire after five minutes, and lock after
five incorrect attempts. Requests retain their 60-second resend cooldown. The
same shared code can be requested again, so it does not prove phone ownership:
anyone knowing it can sign in as another phone number. Disable this mode before
real users join by setting AUTH_OTP_MODE=default and removing STATIC_OTP_CODE.
Without an SMS integration, restricted/default mode returns 503 as before.

The admin account must still be promoted with the operator command using the same
Supabase DATABASE_URL (`npm run admin:promote -- promote-admin +91YOUR_NUMBER`).
The static code does not grant administrator or KYC privileges. APP_ENV stays
production so development response logging and simulated KYC remain disabled.

## Manual member verification

Set `KYC_REVIEW_MODE=manual` on Render and redeploy the updated API to let authorized
administrators approve/reject members while keeping `APP_ENV=production`.
This is an administrator's manual decision, not an external identity-provider
check. Each decision records the reviewing administrator and `kyc.manual.verified`
or `kyc.manual.rejected` in the audit trail. Members cannot grant themselves verified
status. Set `KYC_REVIEW_MODE=disabled` to disable manual review outside development.
No database migration or client rebuild is needed for this setting.
