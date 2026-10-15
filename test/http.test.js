import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { Marketplace } from '../src/service.js';

async function fixture(t, { development = true, logger = { error() {} } } = {}) {
  const service = new Marketplace(':memory:', { development });
  const uploadDirectory = mkdtempSync(join(tmpdir(), 'aayplus-uploads-'));
  const server = createApp(service, { logger, uploadDirectory }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.close(); rmSync(uploadDirectory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', body, token, headers = {} } = {}) {
    const response = await fetch(base + path, {
      method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.status === 204 ? null : await response.json();
    return { status: response.status, data, headers: response.headers };
  }
  async function login(phone, name) {
    const otp = await request('/api/v1/auth/otp', { method: 'POST', body: { phone } });
    const result = await request('/api/v1/auth/verify', { method: 'POST', body: { phone, name, code: otp.data.data.developmentCode } });
    assert.equal(result.status, 200);
    return result.data.data;
  }
  return { request, login, service, base };
}

test('HTTP: authentication, admin permissions, KYC, listing and booking request', async t => {
  const { request, login, service } = await fixture(t);
  const host = await login('+919876543210', 'Host');
  const renter = await login('+919876543211', 'Renter');
  assert.equal((await request('/api/v1/me')).status, 401);
  assert.equal((await request('/api/v1/admin/users', { token: renter.token })).status, 403);
  service.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(host.user.id);
  for (const user of [host.user, renter.user]) {
    assert.equal((await request(`/api/v1/admin/users/${user.id}/kyc`, { method: 'POST', token: host.token, body: { status: 'verified' } })).status, 200);
  }
  const listing = await request('/api/v1/listings', { method: 'POST', token: host.token, body: {
    title: 'Sony camera', category: 'Cameras', description: 'Full frame camera', location: 'Noida',
    hourly_paise: 10000, daily_paise: 60000, weekly_paise: 300000, deposit_paise: 100000, photos: [],
  } });
  assert.equal(listing.status, 201);
  assert.equal((await request('/api/v1/listings?category=Cameras')).data.data.items.length, 1);
  const start = Date.now() + 86400000;
  const body = { listing_id: listing.data.data.id, start: new Date(start).toISOString(), end: new Date(start + 7200000).toISOString() };
  const quote = await request('/api/v1/bookings/quote', { method: 'POST', token: renter.token, body });
  assert.equal(quote.data.data.total_paise, 123000);
  const booking = await request('/api/v1/bookings', { method: 'POST', token: renter.token, body });
  assert.equal(booking.status, 201);
  assert.equal(booking.data.data.status, 'requested');
  const approve = await request(`/api/v1/bookings/${booking.data.data.id}/approve`, { method: 'POST', token: host.token, body: {} });
  assert.equal(approve.data.data.status, 'approved');
  assert.equal((await request('/api/v1/admin/stats', { token: host.token })).data.data.totalListings, 1);
  assert.equal((await request('/api/v1/auth/logout', { method: 'POST', token: renter.token, body: {} })).status, 200);
  assert.equal((await request('/api/v1/me', { token: renter.token })).status, 401);
});

test('HTTP: JSON errors, size limits, CORS and security headers', async t => {
  const { request, base } = await fixture(t);
  const health = await request('/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await request('/api/v1/auth/otp', { method: 'POST', body: [] })).status, 400);
  assert.equal((await request('/health', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const preflight = await request('/api/v1/me', { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  const malformed = await fetch(base + '/api/v1/auth/otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
  assert.equal(malformed.status, 400);
  const oversized = await request('/api/v1/auth/otp', { method: 'POST', body: { phone: 'x'.repeat(70000) } });
  assert.equal(oversized.status, 413);
  const wrongType = await fetch(base + '/api/v1/auth/otp', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hello' });
  assert.equal(wrongType.status, 415);
});

test('HTTP: authentication endpoints are rate limited', async t => {
  const { request } = await fixture(t);
  for (let index = 0; index < 20; index++) {
    const result = await request('/api/v1/auth/otp', { method: 'POST', body: { phone: 'bad' } });
    assert.equal(result.status, 400);
  }
  const limited = await request('/api/v1/auth/otp', { method: 'POST', body: { phone: 'bad' } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('Cross-client: admin adapter verifies app account, observes bookings and resolves shared dispute', async t => {
  const { request: appRequest, login, service, base } = await fixture(t);
  const host = await login('+919876543210', 'Host');
  const renter = await login('+919876543211', 'Renter');
  const admin = await login('+919876543212', 'Administrator');
  service.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.user.id);
  const previous = process.env.NEXT_PUBLIC_API_BASE_URL;
  process.env.NEXT_PUBLIC_API_BASE_URL = `${base}/api/v1`;
  const { request: adminRequest, collection: adminCollection } = await import(`../../AayPlus-Admin/app/lib/api.js?test=${Date.now()}`);
  if (previous === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL; else process.env.NEXT_PUBLIC_API_BASE_URL = previous;
  for (const user of [host.user, renter.user]) await adminRequest(`/admin/users/${user.id}/kyc`, { token: admin.token, method: 'POST', body: { status: 'verified' } });
  assert.equal((await appRequest('/api/v1/me', { token: renter.token })).data.data.kyc_status, 'verified');
  const item = (await appRequest('/api/v1/listings', { method: 'POST', token: host.token, body: { title: 'Shared camera', category: 'Cameras', description: 'Camera', location: 'Noida', hourly_paise: 10000, daily_paise: 50000, weekly_paise: 250000, deposit_paise: 100000, photos: [] } })).data.data;
  assert.equal((await adminCollection('/admin/listings', admin.token))[0].title, 'Shared camera');
  assert.equal((await appRequest('/api/v1/me/listings', { token: renter.token })).data.data.items.length, 0);
  const start = Date.now() + 86400000;
  const booking = (await appRequest('/api/v1/bookings', { method: 'POST', token: renter.token, body: { listing_id: item.id, start: new Date(start).toISOString(), end: new Date(start + 7200000).toISOString() } })).data.data;
  const observed = (await adminCollection('/admin/bookings', admin.token))[0];
  assert.equal(observed.id, booking.id); assert.equal(observed.renter_name, 'Renter'); assert.equal(observed.listing.title, 'Shared camera');
  for (const [action, token] of [['approve', host.token], ['sign', host.token], ['sign', renter.token]]) assert.equal((await appRequest(`/api/v1/bookings/${booking.id}/${action}`, { method: 'POST', token, body: {} })).status, 200);
  service.db.prepare('UPDATE bookings SET start_at=? WHERE id=?').run(Math.floor(Date.now() / 1000) - 1, booking.id);
  for (const action of ['pickup', 'return']) assert.equal((await appRequest(`/api/v1/bookings/${booking.id}/${action}`, { method: 'POST', token: host.token, body: { notes: 'Condition recorded', photos: ['https://example.com/evidence.jpg'] } })).status, 200);
  const dispute = (await appRequest(`/api/v1/bookings/${booking.id}/claim`, { method: 'POST', token: host.token, body: { claim_paise: 30000, description: 'Lens scratch' } })).data.data;
  await appRequest(`/api/v1/disputes/${dispute.id}/response`, { method: 'POST', token: renter.token, body: { response: 'Please review the evidence.' } });
  assert.equal((await adminCollection('/admin/disputes', admin.token))[0].response, 'Please review the evidence.');
  const details = await adminRequest(`/bookings/${booking.id}`, { token: admin.token }); assert.equal(details.inspections.length, 2);
  await adminRequest(`/admin/disputes/${dispute.id}/resolve`, { method: 'POST', token: admin.token, body: { settlement_paise: 10000, notes: 'Partial claim approved.' } });
  assert.equal((await appRequest(`/api/v1/bookings/${booking.id}`, { token: renter.token })).data.data.status, 'completed');
  const ledger = (await appRequest('/api/v1/ledger', { token: renter.token })).data.data.items;
  assert.equal(ledger.find(row => row.kind === 'deposit_release_due').amount_paise, 90000);
  await adminRequest(`/listings/${item.id}`, { method: 'PATCH', token: admin.token, body: { active: false } });
  assert.equal((await appRequest('/api/v1/listings')).data.data.items.length, 0);
  assert.equal((await appRequest('/api/v1/me/listings', { token: host.token })).data.data.items[0].active, false);
});


test('Uploaded phone photo is resized, persisted, owned and attached to a shared listing', async t => {
  const { login, request, service, base } = await fixture(t);
  const host = await login('+919876543210', 'Host');
  const stranger = await login('+919876543211', 'Other host');
  const image = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: 'blue' } }).png().toBuffer();
  const upload = (body, token = host.token) => fetch(`${base}/api/v1/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body });
  assert.equal((await upload(image, '')).status, 401);
  assert.equal((await upload(image)).status, 403);
  service.db.prepare("UPDATE users SET kyc_status='verified'").run();
  assert.equal((await upload(Buffer.from('<svg>bad</svg>'))).status, 415);
  assert.equal((await upload(Buffer.alloc(8 * 1024 * 1024 + 1))).status, 413);
  const response = await upload(image); assert.equal(response.status, 201);
  const photo = (await response.json()).data;
  assert.match(photo.url, /^\/media\/[a-f0-9]{24}\.jpg$/);
  const downloaded = await fetch(base + photo.url); assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-type'), /image\/jpeg/);
  const metadata = await sharp(Buffer.from(await downloaded.arrayBuffer())).metadata();
  assert.equal(metadata.width, 1600); assert.equal(metadata.height, 800); assert.equal(metadata.exif, undefined);
  const body = { title: 'Photographed camera', category: 'Cameras', description: 'Camera', location: 'Noida', hourly_paise: 10000, daily_paise: 50000, weekly_paise: 250000, deposit_paise: 100000, photos: [photo.url] };
  assert.equal((await request('/api/v1/listings', { method: 'POST', token: stranger.token, body })).status, 403);
  const listing = await request('/api/v1/listings', { method: 'POST', token: host.token, body });
  assert.equal(listing.status, 201); assert.deepEqual(listing.data.data.photos, [photo.url]);
  assert.deepEqual((await request('/api/v1/listings')).data.data.items[0].photos, [photo.url]);
  assert.equal((await fetch(`${base}/media/not-an-image.jpg`)).status, 404);
});


test('Development logs contain status and redacted responses, never authentication secrets', async t => {
  const logs = [];
  const { login } = await fixture(t, { logger: { info: (...args) => logs.push(args), error() {} } });
  const session = await login('+919876543210', 'Member');
  const text = JSON.stringify(logs);
  assert.ok(logs.length >= 2); assert.ok(text.includes('durationMs'));
  assert.ok(!text.includes(session.token)); assert.ok(!text.includes('+919876543210'));
  const otp = logs.find(entry => entry[1].path === '/api/v1/auth/otp')[1];
  assert.equal(otp.request.phone, '[redacted]'); assert.equal(otp.response.data.developmentCode, '[redacted]');
  const verify = logs.find(entry => entry[1].path === '/api/v1/auth/verify')[1];
  assert.equal(verify.request.code, '[redacted]'); assert.equal(verify.response.data.token, '[redacted]');
  assert.equal(verify.status, 200);
});
test('Request response logging is disabled outside development', async t => {
  const logs = [];
  const { request } = await fixture(t, { development: false, logger: { info: (...args) => logs.push(args), error() {} } });
  await request('/health'); assert.equal(logs.length, 0);
});


test('Pickup and return evidence supports private photo/video uploads and rejects unrelated access', async t => {
  const { login, request, service, base } = await fixture(t);
  const host = await login('+919876543210', 'Host');
  const renter = await login('+919876543211', 'Renter');
  const other = await login('+919876543212', 'Other');
  service.db.prepare("UPDATE users SET kyc_status='verified'").run();
  const listing = (await request('/api/v1/listings', { method: 'POST', token: host.token, body: { title: 'Bike', category: 'Bikes', description: 'Bike', location: 'Noida', hourly_paise: 10000, daily_paise: 50000, weekly_paise: 250000, deposit_paise: 100000, photos: [] } })).data.data;
  const start = Date.now() + 86400000;
  const booking = (await request('/api/v1/bookings', { method: 'POST', token: renter.token, body: { listing_id: listing.id, start: new Date(start).toISOString(), end: new Date(start+7200000).toISOString() } })).data.data;
  service.transition(service.authenticate(host.token), booking.id, 'approve');
  service.transition(service.authenticate(host.token), booking.id, 'sign');
  service.transition(service.authenticate(renter.token), booking.id, 'sign');
  service.db.prepare('UPDATE bookings SET start_at=? WHERE id=?').run(Math.floor(Date.now()/1000)-1, booking.id);
  const upload = (body, video, token = host.token) => fetch(`${base}/api/v1/uploads${video ? '/videos' : ''}?booking_id=${booking.id}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body });
  assert.equal((await upload(Buffer.from('invalid video'), true)).status, 415);
  const videoBytes = readFileSync(new URL('./fixtures/inspection.mp4', import.meta.url));
  assert.equal((await upload(videoBytes, true, other.token)).status, 403);
  const videoResponse = await upload(videoBytes, true); assert.equal(videoResponse.status, 201);
  const video = (await videoResponse.json()).data.url;
  const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'blue' } }).png().toBuffer();
  const photoResponse = await upload(image, false); assert.equal(photoResponse.status, 201);
  const photo = (await photoResponse.json()).data.url;
  assert.equal((await fetch(base+video)).status, 401);
  assert.equal((await fetch(base+video, { headers: { Authorization: `Bearer ${other.token}` } })).status, 403);
  assert.equal((await fetch(base+photo, { headers: { Authorization: `Bearer ${renter.token}` } })).status, 200);
  const range = await fetch(base+video, { headers: { Authorization: `Bearer ${renter.token}`, Range: 'bytes=0-31' } });
  assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 32);
  assert.equal((await fetch(`${base}/media/${video.split('/').pop()}`)).status, 404);
  const pickup = await request(`/api/v1/bookings/${booking.id}/pickup`, { method: 'POST', token: host.token, body: { notes: 'All sides recorded', photos: [photo], videos: [video] } });
  assert.equal(pickup.status, 200);
  const details = (await request(`/api/v1/bookings/${booking.id}`, { token: renter.token })).data.data;
  assert.deepEqual(details.inspections[0].videos, [video]); assert.deepEqual(details.inspections[0].photos, [photo]);
  assert.equal((await request(`/api/v1/bookings/${booking.id}/return`, { method: 'POST', token: host.token, body: { notes: 'Return video', photos: [], videos: [video] } })).status, 200);
});
