import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testService } from '../test-support/service.js';
import { Marketplace, id } from '../src/service.js';

test('PostgreSQL: concurrent reservations across connections allow exactly one winner', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const first = await testService(':memory:', { development: true });
  const second = await new Marketplace(process.env.TEST_DATABASE_URL, { development: true }).initialize();
  t.after(async () => { await first.close(); await second.close(); });
  const host = { id: id(), kyc_status: 'verified', role: 'member' };
  const renter = { id: id(), kyc_status: 'verified', role: 'member' };
  for (const actor of [host, renter]) await first.db.prepare("INSERT INTO users(id,phone,name,kyc_status,created_at) VALUES (?,?,?,'verified',1)").run(actor.id, actor.id, 'Test');
  const listing = await first.createListing(host, { title: 'Camera', category: 'Cameras', description: 'Kit', location: 'Noida', hourly_paise: 100, daily_paise: 1000, weekly_paise: 5000, deposit_paise: 1000 });
  const start = Date.now() + 86400000;
  const request = { listing_id: listing.id, start: new Date(start).toISOString(), end: new Date(start + 3600000).toISOString() };
  const outcomes = await Promise.allSettled([first.createBooking(renter, request), second.createBooking(renter, request)]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.status, 409);
  assert.equal(Number((await first.db.prepare('SELECT COUNT(*) AS n FROM bookings').get()).n), 1);
  const security = await first.db.pool.query("SELECT relrowsecurity FROM pg_class WHERE relnamespace='aayplus'::regnamespace AND relname IN ('users','sessions','otps')");
  assert.equal(security.rows.length, 3);
  assert.ok(security.rows.every(row => row.relrowsecurity));
});

test('PostgreSQL: SQLite importer preserves IDs and refuses to overwrite existing data', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(), 'aayplus-import-test-'));
  const sourcePath = join(directory, 'source.sqlite3');
  const source = await new Marketplace(sourcePath, { development: true }).initialize();
  const target = await testService(':memory:', { development: true });
  t.after(async () => { await source.close(); await target.close(); await rm(directory, { recursive: true, force: true }); });
  const uid = id();
  await source.db.prepare("INSERT INTO users(id,phone,name,kyc_status,created_at) VALUES (?,?,?,'verified',1)").run(uid, uid, 'Imported host');
  const listing = await source.createListing(await source.row('users', uid), { title: 'Camera', category: 'Cameras', description: 'Kit', location: 'Noida', hourly_paise: 100, daily_paise: 1000, weekly_paise: 5000, deposit_paise: 1000 });
  const run = () => spawnSync(process.execPath, ['src/import-sqlite.js'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, DATABASE_PATH: sourcePath, SUPABASE_URL: 'https://unused.example', SUPABASE_SECRET_KEY: 'test-only' } });
  const imported = run();
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal((await target.row('users', uid)).name, 'Imported host');
  assert.equal((await target.row('listings', listing.id)).title, 'Camera');
  assert.equal(run().status, 1);
  assert.equal(Number((await target.db.prepare('SELECT COUNT(*) AS n FROM users').get()).n), 1);
  assert.equal((await source.row('listings', listing.id)).title, 'Camera');
});
