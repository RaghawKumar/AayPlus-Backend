# Run the connected AayPlus system

The Flutter app and Next.js admin now read and write the same Node.js API and SQLite database. They refresh every 15 seconds, on app resume/tab visibility, and after their own changes. Manual refresh is also available. No mock fallback is used in the default entry points.

## 1. Start the backend

```sh
cd AayPlus-Backend
nvm use
npm ci
cp .env.example .env
npm run dev
```

If `.env` already exists, preserve it and check the settings instead of copying over it. The API listens on `http://127.0.0.1:8080`. Local development needs `APP_ENV=development`. `CORS_ORIGINS` should include `http://localhost:3000,http://localhost:7357` for the commands below.

The `.nvmrc` pins Node 20.19.6 to match the development setup. If you change Node versions, run `npm ci` under the selected version so the SQLite native module matches it.

## 2. Start the admin

```sh
cd AayPlus-Admin
npm install
npm run dev
```

Open `http://localhost:3000`. The default API address is `https://aayplus-backend.onrender.com/api/v1`. To override it, copy `.env.example` to `.env.local`, change `NEXT_PUBLIC_API_BASE_URL`, and restart Next.js.

Request a code using your phone number and sign in. The development server displays the generated six-digit code. A newly created account initially has no admin role, so the panel rejects access. From the backend folder, promote this account:

```sh
npm run admin:promote -- promote-admin +919876543210
```

Replace the example with the phone number you used. Request a new code and sign in again. The panel now shows actual database records. There are no pre-created accounts or listings.

## 3. Start the Flutter app

```sh
cd AayPlus-App
flutter pub get
flutter run
```

The default API address is `https://aayplus-backend.onrender.com/api/v1` on all platforms. You can override it:

```sh
flutter run --dart-define=API_BASE_URL=https://aayplus-backend.onrender.com/api/v1
```

For Flutter web with the default CORS settings:

```sh
flutter run -d chrome --web-hostname localhost --web-port 7357 \
  --dart-define=API_BASE_URL=https://aayplus-backend.onrender.com/api/v1
```

For a physical device, use the development computer's LAN address, start the backend with `HOST=0.0.0.0`, and permit local-network access on the device. Android debug builds permit local HTTP; release builds should use HTTPS. iOS permits local networking, but device/network policy may require additional configuration for a numeric LAN address. Prefer an HTTPS development endpoint for device testing.

## 4. Verify shared activity

1. Sign in to the app with a host phone number. Its account appears in **Admin → Members & verification**.
2. In the admin, click **Verify (development)** for that account. Refresh the app account screen or wait up to 15 seconds; it now shows verified status.
3. In the app's **Listings** tab, publish an item. It appears in the admin's listings table.
4. Sign out of the app and use a different renter phone number. Verify that account through the admin as well. Switching renter/host UI mode keeps the same identity; it does not impersonate another person.
5. In **Explore**, open the host's item, select future pickup/return times, check the server quote, and send a booking request. The renter sees a waiting-for-host confirmation. The booking also appears in the admin.
6. Sign in with the host account on another device/browser, or sign out/in on the same app. Under **Rentals → Hosting**, approve the request. The renter sees the new status after refresh.
7. Each account acknowledges the rental terms. Once pickup time arrives, the host can record pickup using notes and photos/videos from the camera or gallery. On return, the host records another inspection.
8. The host either completes the rental or files a damage claim. The renter can respond. Admin reviewers can open handover evidence and resolve the claim for a bounded amount. Both accounts then see the updated booking and accounting entries.
9. Archive a listing in the admin. It disappears from renter discovery and appears as archived in the host's inventory.

## What is connected

| Shared workflow | App | Admin |
| --- | --- | --- |
| Accounts | OTP sign-in, profile, sign-out | Admin OTP sign-in, member list |
| Verification | Reads server status | Writes development verification decision |
| Listings | Publish, list own inventory, archive/activate, discover | Browse, archive/activate |
| Bookings | Server quote, request, host approval/rejection, cancellation | Browse shared bookings |
| Handover | Party acknowledgements, host inspections with evidence URLs | Read recorded inspection evidence |
| Disputes | Host claim, renter response, read decision | Review evidence, write final settlement |
| Ledger | Own accounting intentions | All accounting intentions |

## Current boundaries

- Listing photos now support phone-library selection and camera capture, previews, removal and backend upload. Up to 12 photos per listing, 8 MB each; the first is the cover. Server storage is `UPLOAD_DIRECTORY` (default `data/uploads`). Restart the app after installing the new native image-picker plugin; hot reload is insufficient.
- SMS delivery, identity-provider checks, payment collection and refunds are not implemented. Development verification does not verify a real identity. Pickup/return inspections support camera/gallery photos and videos, private evidence upload and playback.
- Tokens remain in memory and are never stored in browser localStorage. Reloading/restarting requires a new OTP login; database records remain saved. Production needs an agreed browser cookie/device secure-storage session design.
- All prices use paise in the API and rupees in the UI. Neither client can set the booking's final calculated price.
- Polling is used rather than realtime push. A failed refresh keeps the last successful view and shows an error. Refresh/retry before making decisions from a stale view.
- Existing detailed demo screen files remain in the repository for reference. The app starts at `ConnectedGate` and the new connected marketplace screens; the admin page no longer imports mock datasets.

## Validation

```sh
cd AayPlus-Backend
npm test
npm run check

cd ../AayPlus-App
flutter test
flutter analyze --no-fatal-infos

cd ../AayPlus-Admin
npm run lint
npm run build
```

Backend tests include a cross-client flow using the admin's actual JavaScript API adapter against a temporary server: verification, listing publication, booking, host approvals, inspections, dispute response, admin resolution, ledger visibility and archival. Flutter tests check its HTTP adapter/provider, expired sessions, error handling and renter request UI.

## Development console logs

- **Flutter:** run `flutter run` in debug mode. The IDE Debug Console / Flutter terminal shows `[AayPlus][screen]`, `[action]`, `[api.request]` and `[api.response]` events. Responses include HTTP status, duration and bounded JSON data. Release/profile builds do not emit these logs.
- **Admin:** run `npm run dev`, then open the browser developer console. Enable the **Verbose/Debug** level to see `[AayPlus Admin]` screen, button and API events. Production builds disable these logs.
- **Backend:** set `APP_ENV=development` in the backend `.env` and restart the server. Its terminal shows `[AayPlus API]` entries with request ID, method, path, status, duration and sanitized request/response bodies. Other environments disable this request/response logger; existing server error reporting remains enabled.

Tokens, OTPs, authorization values, phone numbers, email addresses and photo data are redacted. Binary uploads are omitted. Arrays, nested objects and long strings are truncated to keep console output manageable. Headers and query strings are not logged. Large list responses show only their first ten records.

## Pickup and return media

Open Rental details → Record pickup inspection / Record return inspection. Add notes, choose photos or take a photo, and choose a video or record a new one. Remove unwanted files before saving. At least one photo or video is required. The screen uploads evidence before advancing the booking; failed uploads retain the current selection for retry.

Limits: 12 photos at 8 MB each, two MP4/MOV videos at 60 seconds and 50 MB each. Video validation uses bundled FFprobe. Private inspection files can only be downloaded by the host, renter or an administrator. Rental history supports playback; the admin review dialog displays photos and playable videos. Listing photos remain public.

Restart the backend after installing dependencies (`npm install`), and stop/re-run Flutter fully so CocoaPods can install `video_player` and load the iOS microphone permission. Camera/video recording should be tested on a physical device.

Pickup inspection follows the scheduled rental start time. Rental details show when it opens and enable the action after a server refresh confirms availability. The inspection form rechecks the booking before uploading evidence, preserves selected files if it is too early, and explains the opening time.
