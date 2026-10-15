# AayPlus: app screens and complete flow

The app, administrator panel and Node.js API share persistent marketplace records. UI mode changes never switch identities. The app refreshes data every 15 seconds and after writes.

## Screen map

| Screen | Details shown | Main actions |
| --- | --- | --- |
| Sign in | Mobile number, generated development code when enabled, profile name for new accounts | Request/resend code, verify, change number |
| Explore | Photo-led listing cards, category, pickup area, description preview, hourly/day pricing, refundable deposit and photo count | Text search, category filter, price sort, open listing |
| Listing details | Swipeable photos, title, host, pickup area, full description, hourly/daily/weekly rate comparison and deposit | Choose exact pickup/return dates and times, check quote, send request |
| Rentals → Renting | Your requested, approved, active and finished rentals | Open booking, follow progress |
| Rentals → Hosting | Requests and rentals for your own items | Approve/decline, acknowledge terms, record handovers and complete returns |
| Booking details | Five-stage progress, real booking status, host/renter names, schedule, rental/fee/deposit breakdown, signatures, inspections, claims and admin decisions | Actions available for the signed-in party and current server state |
| Listings | Own active/archived inventory, rates and active listing counts | Add an item, archive/reactivate |
| Create listing | Category, title, description, pickup area, three price packages, deposit, image previews | Select library photos, take photos, remove images, publish |
| Account | Real identity, mobile number, verification status, profile and own accounting entries | Edit profile, refresh, sign out |
| How it works | Renter, host and administrator workflows | Switch guide tabs; available from the top navigation |

## Renter journey

1. Sign in with a mobile OTP. New accounts provide a name.
2. Open Account to check identity verification. During development an administrator approves the account from the web panel's Members & verification screen.
3. Search or browse categories in Explore. Compare real listing descriptions, rates and deposits; distance, ratings and discounts are not fabricated.
4. Open a listing to see all available photos, host name, pickup area and the complete description.
5. Select future pickup and return dates/times. Request a server quote. The backend checks overlapping reservations and chooses the least expensive combination of hourly, daily and weekly packages, rounding duration up by hour.
6. Review rental charge, the ₹30 platform fee and refundable deposit. Send the booking request.
7. The request confirmation waits for the host; renters cannot approve their own requests. Before pickup time, either party can cancel a requested/approved booking.
8. Once the host approves, each party acknowledges rental terms from their own account.
9. At pickup time the host records condition notes and at least one evidence image reference. The booking becomes active.
10. Return the item. The host records the return inspection and completes the rental or files a damage claim.
11. Respond to any claim. An administrator reviews evidence and records a final settlement. The booking and each party's accounting intentions update together.

## Host journey

1. Sign in and complete account verification through the administrator.
2. Open Listings → List an item. Enter accurate details and all three rental prices in rupees.
3. Add up to 12 phone/camera photos, no larger than 8 MB each. Review previews and remove unwanted images. The first photo becomes the cover. Images upload when publishing and are normalized by the backend.
4. Publish. Other accounts can discover the listing; it also appears in the admin panel.
5. Open Rentals → Hosting to review incoming requests. Approve or decline each request.
6. Both accounts acknowledge the terms. Once pickup time arrives, record pickup notes and evidence.
7. Record the returned item's condition. Complete a clean return or file a damage claim within the deposit amount.
8. Read the renter's response and administrator decision. Archive/reactivate inventory as needed.

## Administrator journey

1. Sign in to the Next.js panel with an account granted admin access using the backend operator command.
2. Review members and grant/reject development verification. Account status becomes visible in the app after refresh.
3. Browse the same listings and bookings, archive inappropriate listings and inspect recorded handover evidence.
4. Review disputes with the host claim, renter response and inspection evidence. Record a settlement from zero to the claim amount, with notes.
5. View the audit trail and accounting intentions. Neither app nor admin implies that an actual payout/refund has occurred.

## Visual and interaction design

- Photo-led cards, category icons, a navy editorial banner, warm amber accents and consistent rounded panels.
- Short fade/slide entrances, animated tab changes, image fade-in and an animated quote reveal.
- No repeating decorative animations. Motion respects the device's reduced-motion setting.
- Verification notices appear before publishing; empty, loading and connection-error states remain explicit.
- A booking progress tracker shows request, agreement, pickup, return and completion. Cancelled/rejected bookings remain explicitly labeled.

## Current limits

SMS delivery, a real identity provider, payment capture/refunds, push notifications and legal e-signatures are not configured. OTP display and administrator verification are development features. Inspection evidence supports camera/gallery photo and video uploads with booking-scoped access; listing creation supports native photo uploads. Tokens stay in client memory. See `INTEGRATION.md` for running the system and `AayPlus-Backend/README.md` for the API contract.

## Pickup and return media

Open Rental details → Record pickup inspection / Record return inspection. Add notes, choose photos or take a photo, and choose a video or record a new one. Remove unwanted files before saving. At least one photo or video is required. The screen uploads evidence before advancing the booking; failed uploads retain the current selection for retry.

Limits: 12 photos at 8 MB each, two MP4/MOV videos at 60 seconds and 50 MB each. Video validation uses bundled FFprobe. Private inspection files can only be downloaded by the host, renter or an administrator. Rental history supports playback; the admin review dialog displays photos and playable videos. Listing photos remain public.

Restart the backend after installing dependencies (`npm install`), and stop/re-run Flutter fully so CocoaPods can install `video_player` and load the iOS microphone permission. Camera/video recording should be tested on a physical device.
