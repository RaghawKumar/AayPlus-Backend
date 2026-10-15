import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Marketplace, ApiError, id } from '../src/service.js';

let service, directory, owner, renter, stranger, admin;
function user(role = 'member', verified = true) {
  const uid = id();
  service.db.prepare('INSERT INTO users(id,phone,name,role,kyc_status,created_at) VALUES (?,?,?,?,?,?)').run(uid, uid, 'Test member', role, verified ? 'verified' : 'unverified', 1);
  return service.row('users', uid);
}
const listingData = { title: 'Camera kit', category: 'Cameras', description: 'Camera with lens and battery.', location: 'Noida', hourly_paise: 12000, daily_paise: 60000, weekly_paise: 300000, deposit_paise: 300000, photos: ['https://example.com/camera.jpg'] };
function listing() { return service.createListing(owner, listingData); }
function dates(item, start = Date.now() + 86400000, hours = 4) {
  return { listing_id: item.id, start: new Date(start).toISOString(), end: new Date(start + hours * 3600000).toISOString() };
}
function fails(fn, status) { assert.throws(fn, error => error instanceof ApiError && error.status === status); }
function returnedBooking() {
  const booking = service.createBooking(renter, dates(listing()));
  service.transition(owner, booking.id, 'approve');
  service.transition(owner, booking.id, 'sign');
  service.transition(renter, booking.id, 'sign');
  // Advance the fixture booking start instead of sleeping or changing the system clock.
  service.db.prepare('UPDATE bookings SET start_at=? WHERE id=?').run(Math.floor(Date.now() / 1000) - 1, booking.id);
  const evidence = { notes: 'Inspection recorded', photos: ['https://example.com/evidence.jpg'] };
  service.transition(owner, booking.id, 'pickup', evidence);
  service.transition(owner, booking.id, 'return', evidence);
  return booking;
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aayplus-test-'));
  service = new Marketplace(join(directory, 'test.sqlite3'), { development: true });
  owner = user(); renter = user(); stranger = user(); admin = user('admin');
});
afterEach(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });

test('OTP authenticates once, stores hashed tokens and logout revokes access', () => {
  const phone = '+919876543210', otp = service.requestOtp({ phone });
  fails(() => service.requestOtp({ phone }), 429);
  const session = service.verifyOtp({ phone, code: otp.developmentCode, name: 'Rahul' });
  assert.equal(service.authenticate(session.token).name, 'Rahul');
  assert.notEqual(service.db.prepare('SELECT token_hash FROM sessions').get().token_hash, session.token);
  fails(() => service.verifyOtp({ phone, code: otp.developmentCode }), 401);
  service.logout(session.token);
  fails(() => service.authenticate(session.token), 401);
});
test('five failed OTP attempts lock the code and persist across failed requests', () => {
  const phone = '+919876543210', otp = service.requestOtp({ phone });
  const wrong = otp.developmentCode === '000000' ? '111111' : '000000';
  for (let n = 0; n < 5; n++) fails(() => service.verifyOtp({ phone, code: wrong }), 401);
  fails(() => service.verifyOtp({ phone, code: otp.developmentCode, name: 'Rahul' }), 401);
  assert.equal(service.db.prepare('SELECT attempts FROM otps WHERE phone=?').get(phone).attempts, 5);
});
test('expired OTPs and sessions are rejected', () => {
  const phone = '+919876543210', otp = service.requestOtp({ phone });
  service.db.prepare('UPDATE otps SET expires_at=0').run();
  fails(() => service.verifyOtp({ phone, code: otp.developmentCode, name: 'Rahul' }), 401);
});
test('restricted mode never exposes a development code or simulates KYC', () => {
  service.development = false;
  fails(() => service.requestOtp({ phone: '+919876543210' }), 503);
  fails(() => service.reviewKyc(admin, renter.id, { status: 'verified' }), 503);
});
test('profile updates cannot grant admin or verified status', () => {
  const member = user('member', false);
  const updated = service.updateAccount(member, { name: 'Updated', role: 'admin', kyc_status: 'verified' });
  assert.equal(updated.role, 'member'); assert.equal(updated.kyc_status, 'unverified');
  fails(() => service.reviewKyc(member, member.id, { status: 'verified' }), 403);
});
test('listings require verification, valid categories and integer prices', () => {
  fails(() => service.createListing(user('member', false), listingData), 403);
  fails(() => service.createListing(owner, { ...listingData, hourly_paise: 1.5 }), 400);
  fails(() => service.createListing(owner, { ...listingData, category: 'Unknown' }), 400);
  const item = listing();
  assert.deepEqual(item.photos, listingData.photos);
  fails(() => service.setListingActive(stranger, item.id, { active: false }), 403);
  assert.equal(service.setListingActive(owner, item.id, { active: false }).active, false);
  assert.equal(service.listings().items.length, 0);
});
test('pricing uses cheapest hourly/day/week packages and ignores client totals', () => {
  const item = listing();
  assert.equal(service.createBooking(renter, dates(item), true).rental_paise, 48000);
  assert.equal(service.createBooking(renter, dates(item, Date.now() + 86400000, 23), true).rental_paise, 60000);
  assert.equal(service.createBooking(renter, dates(item, Date.now() + 86400000, 150), true).rental_paise, 300000);
  const booking = service.createBooking(renter, { ...dates(item), rental_paise: 1, deposit_paise: 0 });
  assert.equal(booking.rental_paise, 48000); assert.equal(booking.deposit_paise, 300000);
});
test('overlap is rejected across database connections; adjacent bookings are allowed', () => {
  const item = listing(), input = dates(item), booking = service.createBooking(renter, input);
  const second = new Marketplace(join(directory, 'test.sqlite3'));
  try { fails(() => second.createBooking(stranger, input), 409); } finally { second.close(); }
  const adjacent = { listing_id: item.id, start: new Date(booking.end_at * 1000).toISOString(), end: new Date((booking.end_at + 3600) * 1000).toISOString() };
  assert.equal(service.createBooking(stranger, adjacent).status, 'requested');
});
test('rejecting a request releases availability and only the host can approve', () => {
  const item = listing(), input = dates(item), booking = service.createBooking(renter, input);
  fails(() => service.transition(renter, booking.id, 'approve'), 403);
  fails(() => service.transition(stranger, booking.id, 'approve'), 403);
  service.transition(owner, booking.id, 'reject');
  assert.equal(service.createBooking(stranger, input).status, 'requested');
});
test('future dates, identity verification and self-booking are enforced', () => {
  const item = listing();
  fails(() => service.createBooking(owner, dates(item)), 400);
  fails(() => service.createBooking(user('member', false), dates(item)), 403);
  fails(() => service.createBooking(renter, dates(item, Date.now() - 86400000)), 400);
  fails(() => service.createBooking(renter, { ...dates(item), start: '2026-10-15' }), 400);
});
test('handover enforces signatures, start time, inspection evidence and account isolation', () => {
  const booking = service.createBooking(renter, dates(listing()));
  fails(() => service.bookingDetails(stranger, booking.id), 403);
  service.transition(owner, booking.id, 'approve');
  fails(() => service.transition(owner, booking.id, 'pickup', {}), 409);
  service.transition(owner, booking.id, 'sign'); service.transition(renter, booking.id, 'sign');
  fails(() => service.transition(owner, booking.id, 'pickup', {}), 409);
  assert.equal(service.row('bookings', booking.id).status, 'approved');
  assert.equal(service.collection(stranger, 'bookings').items.length, 0);
});
test('completion records deposit release once and persists after reopening SQLite', () => {
  const booking = returnedBooking();
  assert.equal(service.transition(owner, booking.id, 'complete').status, 'completed');
  fails(() => service.transition(owner, booking.id, 'complete'), 409);
  assert.equal(service.collection(admin, 'ledger').items.length, 3);
  service.close(); service = new Marketplace(join(directory, 'test.sqlite3'), { development: true });
  const release = service.collection(renter, 'ledger').items[0];
  assert.equal(release.kind, 'deposit_release_due'); assert.equal(release.amount_paise, 300000);
  assert.equal(service.bookingDetails(renter, booking.id).inspections.length, 2);
});
test('dispute settlement is bounded, admin-only, atomic and cannot repeat', () => {
  const booking = returnedBooking();
  fails(() => service.claim(owner, booking.id, { claim_paise: 300001, description: 'Damage' }), 400);
  const claim = service.claim(owner, booking.id, { claim_paise: 200000, description: 'Lens damaged' });
  fails(() => service.respond(owner, claim.id, { response: 'No' }), 403);
  assert.equal(service.respond(renter, claim.id, { response: 'Pre-existing scratch' }).response, 'Pre-existing scratch');
  fails(() => service.resolve(owner, claim.id, { settlement_paise: 100000, notes: 'Approved' }), 403);
  fails(() => service.resolve(admin, claim.id, { settlement_paise: 200001, notes: 'Approved' }), 400);
  assert.equal(service.collection(admin, 'ledger').items.length, 0);
  service.resolve(admin, claim.id, { settlement_paise: 100000, notes: 'Partial claim supported by inspection' });
  fails(() => service.resolve(admin, claim.id, { settlement_paise: 100000, notes: 'Again' }), 409);
  const entries = service.collection(admin, 'ledger').items;
  assert.equal(entries.length, 3);
  assert.equal(entries.find(e => e.kind === 'deposit_release_due').amount_paise, 200000);
  assert.equal(entries.find(e => e.kind === 'damage_due').amount_paise, 100000);
});
test('failed settlement rolls back every write', () => {
  const booking = returnedBooking();
  const claim = service.claim(owner, booking.id, { claim_paise: 200000, description: 'Damage' });
  service.db.prepare('INSERT INTO ledger VALUES (?,?,?,?,?,?)').run(id(), booking.id, owner.id, 'damage_due', 1, 1);
  assert.throws(() => service.resolve(admin, claim.id, { settlement_paise: 100000, notes: 'Review' }));
  assert.equal(service.row('disputes', claim.id).status, 'open');
  assert.equal(service.row('bookings', booking.id).status, 'disputed');
  assert.equal(service.collection(admin, 'ledger').items.length, 1);
});
