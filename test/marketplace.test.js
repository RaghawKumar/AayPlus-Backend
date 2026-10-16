import { testService } from '../test-support/service.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Marketplace, ApiError, id } from '../src/service.js';

let service, directory, owner, renter, stranger, admin;
async function user(role = 'member', verified = true) {
  const uid = id();
  await service.db.prepare('INSERT INTO users(id,phone,name,role,kyc_status,created_at) VALUES (?,?,?,?,?,?)').run(uid, uid, 'Test member', role, verified ? 'verified' : 'unverified', 1);
  return await service.row('users', uid);
}
const listingData = { title: 'Camera kit', category: 'Cameras', description: 'Camera with lens and battery.', location: 'Noida', hourly_paise: 12000, daily_paise: 60000, weekly_paise: 300000, deposit_paise: 300000, photos: ['https://example.com/camera.jpg'] };
async function listing() {return await service.createListing(owner, listingData);}
function dates(item, start = Date.now() + 86400000, hours = 4) {
  return { listing_id: item.id, start: new Date(start).toISOString(), end: new Date(start + hours * 3600000).toISOString() };
}
async function fails(fn, status) {await assert.rejects(fn, (error) => error instanceof ApiError && error.status === status);}
async function returnedBooking() {
  const booking = await service.createBooking(renter, dates(await listing()));
  await service.transition(owner, booking.id, 'approve');
  await service.transition(owner, booking.id, 'sign');
  await service.transition(renter, booking.id, 'sign');
  // Advance the fixture booking start instead of sleeping or changing the system clock.
  await service.db.prepare('UPDATE bookings SET start_at=? WHERE id=?').run(Math.floor(Date.now() / 1000) - 1, booking.id);
  const evidence = { notes: 'Inspection recorded', photos: ['https://example.com/evidence.jpg'] };
  await service.transition(owner, booking.id, 'pickup', evidence);
  await service.transition(owner, booking.id, 'return', evidence);
  return booking;
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'aayplus-test-'));
  service = await testService(join(directory, 'test.sqlite3'), { development: true });
  owner = await user();renter = await user();stranger = await user();admin = await user('admin');
});
afterEach(async () => {await service.close();rmSync(directory, { recursive: true, force: true });});

test('OTP authenticates once, stores hashed tokens and logout revokes access', async () => {
  const phone = '+919876543210',otp = await service.requestOtp({ phone });
  await fails(async () => await service.requestOtp({ phone }), 429);
  const session = await service.verifyOtp({ phone, code: otp.developmentCode, name: 'Rahul' });
  assert.equal((await service.authenticate(session.token)).name, 'Rahul');
  assert.notEqual((await service.db.prepare('SELECT token_hash FROM sessions').get()).token_hash, session.token);
  await fails(async () => await service.verifyOtp({ phone, code: otp.developmentCode }), 401);
  await service.logout(session.token);
  await fails(async () => await service.authenticate(session.token), 401);
});
test('five failed OTP attempts lock the code and persist across failed requests', async () => {
  const phone = '+919876543210',otp = await service.requestOtp({ phone });
  const wrong = otp.developmentCode === '000000' ? '111111' : '000000';
  for (let n = 0; n < 5; n++) await fails(async () => await service.verifyOtp({ phone, code: wrong }), 401);
  await fails(async () => await service.verifyOtp({ phone, code: otp.developmentCode, name: 'Rahul' }), 401);
  assert.equal((await service.db.prepare('SELECT attempts FROM otps WHERE phone=?').get(phone)).attempts, 5);
});
test('expired OTPs and sessions are rejected', async () => {
  const phone = '+919876543210',otp = await service.requestOtp({ phone });
  await service.db.prepare('UPDATE otps SET expires_at=0').run();
  await fails(async () => await service.verifyOtp({ phone, code: otp.developmentCode, name: 'Rahul' }), 401);
});
test('restricted mode never exposes a development code or simulates KYC', async () => {
  service.development = false;
  await fails(async () => await service.requestOtp({ phone: '+919876543210' }), 503);
  await fails(async () => await service.reviewKyc(admin, renter.id, { status: 'verified' }), 503);
});
test('profile updates cannot grant admin or verified status', async () => {
  const member = await user('member', false);
  const updated = await service.updateAccount(member, { name: 'Updated', role: 'admin', kyc_status: 'verified' });
  assert.equal(updated.role, 'member');assert.equal(updated.kyc_status, 'unverified');
  await fails(async () => await service.reviewKyc(member, member.id, { status: 'verified' }), 403);
});
test('listings require verification, valid categories and integer prices', async () => {
  await fails(async () => await service.createListing(await user('member', false), listingData), 403);
  await fails(async () => await service.createListing(owner, { ...listingData, hourly_paise: 1.5 }), 400);
  await fails(async () => await service.createListing(owner, { ...listingData, category: 'Unknown' }), 400);
  const item = await listing();
  assert.deepEqual(item.photos, listingData.photos);
  await fails(async () => await service.setListingActive(stranger, item.id, { active: false }), 403);
  assert.equal((await service.setListingActive(owner, item.id, { active: false })).active, false);
  assert.equal((await service.listings()).items.length, 0);
});
test('pricing uses cheapest hourly/day/week packages and ignores client totals', async () => {
  const item = await listing();
  assert.equal((await service.createBooking(renter, dates(item), true)).rental_paise, 48000);
  assert.equal((await service.createBooking(renter, dates(item, Date.now() + 86400000, 23), true)).rental_paise, 60000);
  assert.equal((await service.createBooking(renter, dates(item, Date.now() + 86400000, 150), true)).rental_paise, 300000);
  const booking = await service.createBooking(renter, { ...dates(item), rental_paise: 1, deposit_paise: 0 });
  assert.equal(booking.rental_paise, 48000);assert.equal(booking.deposit_paise, 300000);
});
test('overlap is rejected across database connections; adjacent bookings are allowed', async () => {
  const item = await listing(),input = dates(item),booking = await service.createBooking(renter, input);
  const second = await new Marketplace(process.env.TEST_DATABASE_URL || join(directory, 'test.sqlite3')).initialize();
  try {await fails(() => second.createBooking(stranger, input), 409);} finally {await second.close();}
  const adjacent = { listing_id: item.id, start: new Date(booking.end_at * 1000).toISOString(), end: new Date((booking.end_at + 3600) * 1000).toISOString() };
  assert.equal((await service.createBooking(stranger, adjacent)).status, 'requested');
});
test('rejecting a request releases availability and only the host can approve', async () => {
  const item = await listing(),input = dates(item),booking = await service.createBooking(renter, input);
  await fails(async () => await service.transition(renter, booking.id, 'approve'), 403);
  await fails(async () => await service.transition(stranger, booking.id, 'approve'), 403);
  await service.transition(owner, booking.id, 'reject');
  assert.equal((await service.createBooking(stranger, input)).status, 'requested');
});
test('future dates, identity verification and self-booking are enforced', async () => {
  const item = await listing();
  await fails(async () => await service.createBooking(owner, dates(item)), 400);
  await fails(async () => await service.createBooking(await user('member', false), dates(item)), 403);
  await fails(async () => await service.createBooking(renter, dates(item, Date.now() - 86400000)), 400);
  await fails(async () => await service.createBooking(renter, { ...dates(item), start: '2026-10-15' }), 400);
});
test('handover enforces signatures, start time, inspection evidence and account isolation', async () => {
  const booking = await service.createBooking(renter, dates(await listing()));
  await fails(async () => await service.bookingDetails(stranger, booking.id), 403);
  await service.transition(owner, booking.id, 'approve');
  await fails(async () => await service.transition(owner, booking.id, 'pickup', {}), 409);
  await service.transition(owner, booking.id, 'sign');await service.transition(renter, booking.id, 'sign');
  await fails(async () => await service.transition(owner, booking.id, 'pickup', {}), 409);
  assert.equal((await service.row('bookings', booking.id)).status, 'approved');
  assert.equal((await service.collection(stranger, 'bookings')).items.length, 0);
});
test('completion records deposit release once and persists after reopening SQLite', async () => {
  const booking = await returnedBooking();
  assert.equal((await service.transition(owner, booking.id, 'complete')).status, 'completed');
  await fails(async () => await service.transition(owner, booking.id, 'complete'), 409);
  assert.equal((await service.collection(admin, 'ledger')).items.length, 3);
  await service.close();service = await new Marketplace(process.env.TEST_DATABASE_URL || join(directory, 'test.sqlite3'), { development: true }).initialize();
  const release = (await service.collection(renter, 'ledger')).items[0];
  assert.equal(release.kind, 'deposit_release_due');assert.equal(release.amount_paise, 300000);
  assert.equal((await service.bookingDetails(renter, booking.id)).inspections.length, 2);
});
test('dispute settlement is bounded, admin-only, atomic and cannot repeat', async () => {
  const booking = await returnedBooking();
  await fails(async () => await service.claim(owner, booking.id, { claim_paise: 300001, description: 'Damage' }), 400);
  const claim = await service.claim(owner, booking.id, { claim_paise: 200000, description: 'Lens damaged' });
  await fails(async () => await service.respond(owner, claim.id, { response: 'No' }), 403);
  assert.equal((await service.respond(renter, claim.id, { response: 'Pre-existing scratch' })).response, 'Pre-existing scratch');
  await fails(async () => await service.resolve(owner, claim.id, { settlement_paise: 100000, notes: 'Approved' }), 403);
  await fails(async () => await service.resolve(admin, claim.id, { settlement_paise: 200001, notes: 'Approved' }), 400);
  assert.equal((await service.collection(admin, 'ledger')).items.length, 0);
  await service.resolve(admin, claim.id, { settlement_paise: 100000, notes: 'Partial claim supported by inspection' });
  await fails(async () => await service.resolve(admin, claim.id, { settlement_paise: 100000, notes: 'Again' }), 409);
  const entries = (await service.collection(admin, 'ledger')).items;
  assert.equal(entries.length, 3);
  assert.equal(entries.find((e) => e.kind === 'deposit_release_due').amount_paise, 200000);
  assert.equal(entries.find((e) => e.kind === 'damage_due').amount_paise, 100000);
});
test('failed settlement rolls back every write', async () => {
  const booking = await returnedBooking();
  const claim = await service.claim(owner, booking.id, { claim_paise: 200000, description: 'Damage' });
  await service.db.prepare('INSERT INTO ledger VALUES (?,?,?,?,?,?)').run(id(), booking.id, owner.id, 'damage_due', 1, 1);
  await assert.rejects(async () => await service.resolve(admin, claim.id, { settlement_paise: 100000, notes: 'Review' }));
  assert.equal((await service.row('disputes', claim.id)).status, 'open');
  assert.equal((await service.row('bookings', booking.id)).status, 'disputed');
  assert.equal((await service.collection(admin, 'ledger')).items.length, 1);
});

test('Static OTP retains request cooldown, failed-attempt lockout and expiry in restricted mode', async () => {
  service.development = false;
  service.staticOtpCode = '123456';
  const phone = '+919876543210';
  await service.requestOtp({ phone });
  await fails(() => service.requestOtp({ phone }), 429);
  for (let n = 0; n < 5; n++) await fails(() => service.verifyOtp({ phone, code: '000000' }), 401);
  await fails(() => service.verifyOtp({ phone, code: '123456', name: 'Test member' }), 401);
  await service.db.prepare('UPDATE otps SET attempts=0,expires_at=0 WHERE phone=?').run(phone);
  await fails(() => service.verifyOtp({ phone, code: '123456', name: 'Test member' }), 401);
});

test('Manual KYC in production requires admin and records actual reviewer and decision', async () => {
  service.development = false;
  service.manualKyc = true;
  await fails(() => service.reviewKyc(renter, stranger.id, { status: 'verified' }), 403);
  await fails(() => service.reviewKyc(admin, stranger.id, { status: 'invalid' }), 400);
  await fails(() => service.reviewKyc(admin, '000000000000000000000000', { status: 'verified' }), 404);
  const approved = await service.reviewKyc(admin, stranger.id, { status: 'verified' });
  assert.equal(approved.kyc_status, 'verified');
  assert.equal(approved.role, 'member');
  assert.equal((await service.reviewKyc(admin, stranger.id, { status: 'rejected' })).kyc_status, 'rejected');
  const audit = (await service.collection(admin, 'audit')).items;
  assert.equal(audit.length, 2);
  assert.ok(audit.every(row => row.actor_id === admin.id && row.resource_id === stranger.id));
  assert.deepEqual(audit.map(row => row.action).sort(), ['kyc.manual.rejected', 'kyc.manual.verified']);
  service.manualKyc = false;
  await fails(() => service.reviewKyc(admin, stranger.id, { status: 'verified' }), 503);
});
