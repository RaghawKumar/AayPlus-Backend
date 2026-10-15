import Database from 'better-sqlite3';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function ensure(condition, message, status = 400) {
  if (!condition) throw new ApiError(status, message);
}
export const id = () => randomBytes(12).toString('hex');
export const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => Math.floor(Date.now() / 1000);
export function string(value, field, max = 2000) {
  ensure(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max, `Invalid ${field}`);
  return value.trim();
}
function money(value, field, min = 0) {
  ensure(Number.isSafeInteger(value) && value >= min && value <= 100_000_000, `${field} must be integer paise between ${min} and 100000000`);
  return value;
}
function date(value) {
  ensure(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value), 'Dates must be ISO 8601 strings with a timezone');
  const parsed = Date.parse(value);
  ensure(Number.isFinite(parsed), 'Invalid date');
  return Math.floor(parsed / 1000);
}
function photos(value = []) {
  ensure(Array.isArray(value) && value.length <= 12 && value.every(photo => {
    if (typeof photo !== 'string' || photo.length > 2000) return false;
    if (/^\/(?:media|api\/v1\/evidence)\/[a-f0-9]{24}\.jpg$/.test(photo)) return true;
    try { return new URL(photo).protocol === 'https:'; } catch { return false; }
  }), 'Photos must contain up to 12 uploaded images or HTTPS URLs');
  return value;
}
const categories = ['Bikes', 'Cameras', 'Electronics', 'Parking'];
const schema = `
CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO schema_version VALUES (1);
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, phone TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
 email TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','admin')),
 kyc_status TEXT NOT NULL DEFAULT 'unverified' CHECK(kyc_status IN ('unverified','verified','rejected')),
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS uploads (
 name TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS otps (
 phone TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS listings (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
 category TEXT NOT NULL, description TEXT NOT NULL, location TEXT NOT NULL,
 hourly_paise INTEGER NOT NULL CHECK(hourly_paise>0), daily_paise INTEGER NOT NULL CHECK(daily_paise>0),
 weekly_paise INTEGER NOT NULL CHECK(weekly_paise>0), deposit_paise INTEGER NOT NULL CHECK(deposit_paise>=0),
 photos TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
 id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES listings(id),
 renter_id TEXT NOT NULL REFERENCES users(id), owner_id TEXT NOT NULL REFERENCES users(id),
 start_at INTEGER NOT NULL, end_at INTEGER NOT NULL CHECK(end_at>start_at),
 status TEXT NOT NULL CHECK(status IN ('requested','approved','rejected','cancelled','active','return_review','disputed','completed')),
 rental_paise INTEGER NOT NULL, fee_paise INTEGER NOT NULL, deposit_paise INTEGER NOT NULL,
 renter_signed INTEGER NOT NULL DEFAULT 0, owner_signed INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS booking_availability ON bookings(listing_id,status,start_at,end_at);
CREATE TABLE IF NOT EXISTS inspections (
 id TEXT PRIMARY KEY, booking_id TEXT NOT NULL REFERENCES bookings(id),
 kind TEXT NOT NULL CHECK(kind IN ('pickup','return')), actor_id TEXT NOT NULL REFERENCES users(id),
 notes TEXT NOT NULL, photos TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(booking_id,kind)
);
CREATE TABLE IF NOT EXISTS disputes (
 id TEXT PRIMARY KEY, booking_id TEXT UNIQUE NOT NULL REFERENCES bookings(id),
 claim_paise INTEGER NOT NULL CHECK(claim_paise>0), description TEXT NOT NULL, response TEXT,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
 settlement_paise INTEGER, notes TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
 id TEXT PRIMARY KEY, booking_id TEXT NOT NULL REFERENCES bookings(id),
 user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
 amount_paise INTEGER NOT NULL CHECK(amount_paise>=0), created_at INTEGER NOT NULL,
 UNIQUE(booking_id,kind)
);
CREATE TABLE IF NOT EXISTS audit (
 id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id),
 action TEXT NOT NULL, resource_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
`;

export class Marketplace {
  constructor(path, { development = false } = {}) {
    this.development = development;
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(schema);
    if (!this.db.prepare('PRAGMA table_info(uploads)').all().some(c => c.name === 'booking_id')) this.db.exec('ALTER TABLE uploads ADD COLUMN booking_id TEXT REFERENCES bookings(id)');
    if (!this.db.prepare('PRAGMA table_info(inspections)').all().some(c => c.name === 'videos')) this.db.exec("ALTER TABLE inspections ADD COLUMN videos TEXT NOT NULL DEFAULT '[]'");
  }
  close() { this.db.close(); }
  transaction(fn) { return this.db.transaction(fn).immediate(); }
  row(table, resourceId) {
    ensure(['users', 'listings', 'bookings', 'disputes'].includes(table), 'Invalid resource');
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(resourceId);
    ensure(row, 'Resource not found', 404);
    return row;
  }
  audit(actor, action, resource) {
    this.db.prepare('INSERT INTO audit VALUES (?,?,?,?,?)').run(id(), actor.id, action, resource, now());
  }
  admin(actor) { ensure(actor.role === 'admin', 'Administrator access required', 403); }
  requestOtp(data) {
    const phone = data.phone;
    ensure(typeof phone === 'string' && /^\+91[6-9][0-9]{9}$/.test(phone), 'Use +91 followed by a valid 10-digit mobile number');
    ensure(this.development, 'SMS provider is not configured', 503);
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    this.transaction(() => {
      const previous = this.db.prepare('SELECT sent_at FROM otps WHERE phone=?').get(phone);
      ensure(!previous || now() - previous.sent_at >= 60, 'Wait 60 seconds before requesting another code', 429);
      this.db.prepare('INSERT OR REPLACE INTO otps VALUES (?,?,?,?,?)').run(phone, hash(phone + code), now() + 300, 0, now());
    });
    return { expiresIn: 300, developmentCode: code, delivery: 'development-only' };
  }
  verifyOtp(data) {
    const { phone, code } = data;
    ensure(typeof phone === 'string' && typeof code === 'string' && /^\d{6}$/.test(code), 'Phone and six-digit code are required');
    // Return failed verification from the transaction so the attempt counter commits.
    const result = this.transaction(() => {
      const otp = this.db.prepare('SELECT * FROM otps WHERE phone=?').get(phone);
      if (!otp || otp.expires_at <= now() || otp.attempts >= 5) return null;
      if (!timingSafeEqual(Buffer.from(otp.code_hash, 'hex'), Buffer.from(hash(phone + code), 'hex'))) {
        this.db.prepare('UPDATE otps SET attempts=attempts+1 WHERE phone=?').run(phone);
        return null;
      }
      let user = this.db.prepare('SELECT * FROM users WHERE phone=?').get(phone);
      if (!user) {
        const uid = id();
        this.db.prepare('INSERT INTO users(id,phone,name,created_at) VALUES (?,?,?,?)').run(uid, phone, string(data.name, 'name', 100), now());
        user = this.row('users', uid);
      }
      this.db.prepare('DELETE FROM otps WHERE phone=?').run(phone);
      this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now());
      const token = randomBytes(32).toString('base64url');
      this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), user.id, now() + 604800);
      return { token, expiresIn: 604800, user };
    });
    ensure(result, 'Invalid or expired verification code', 401);
    return result;
  }
  authenticate(token) {
    const user = this.db.prepare('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?').get(hash(token), now());
    ensure(user, 'Authentication required', 401);
    return user;
  }
  logout(token) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token)); return { loggedOut: true }; }
  updateAccount(actor, data) {
    const name = string(data.name ?? actor.name, 'name', 100);
    const email = data.email ?? actor.email;
    ensure(typeof email === 'string' && email.length <= 254 && (!email || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)), 'Invalid email');
    this.db.prepare('UPDATE users SET name=?,email=? WHERE id=?').run(name, email, actor.id);
    return this.row('users', actor.id);
  }
  reviewKyc(actor, uid, data) {
    this.admin(actor);
    ensure(['verified', 'rejected'].includes(data.status), 'Invalid verification status');
    ensure(this.development, 'Identity verification provider is not configured', 503);
    return this.transaction(() => {
      this.row('users', uid);
      this.db.prepare('UPDATE users SET kyc_status=? WHERE id=?').run(data.status, uid);
      this.audit(actor, `kyc.development.${data.status}`, uid);
      return this.row('users', uid);
    });
  }
  listingJson(row) { return { ...row, photos: JSON.parse(row.photos), active: Boolean(row.active) }; }
  listings(query = {}) {
    const conditions = ['l.active=1'], params = [];
    for (const key of ['category', 'location']) {
      if (query[key]) { conditions.push(`l.${key}=?`); params.push(string(query[key], key, 150)); }
    }
    if (query.q) { conditions.push('(l.title LIKE ? OR l.description LIKE ?)'); const q = `%${string(query.q, 'search', 100)}%`; params.push(q, q); }
    const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 50));
    const offset = Math.max(0, Number.parseInt(query.offset, 10) || 0);
    const rows = this.db.prepare(`SELECT l.*,u.name AS owner_name FROM listings l JOIN users u ON u.id=l.owner_id WHERE ${conditions.join(' AND ')} ORDER BY l.created_at DESC,l.id LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { items: rows.map(row => this.listingJson(row)), limit, offset };
  }
  ownListings(actor, query = {}) {
    const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 50));
    const offset = Math.max(0, Number.parseInt(query.offset, 10) || 0);
    const rows = this.db.prepare('SELECT * FROM listings WHERE owner_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(actor.id, limit, offset);
    return { items: rows.map(row => this.listingJson({ ...row, owner_name: actor.name })), limit, offset };
  }
  createListing(actor, data) {
    ensure(actor.kyc_status === 'verified', 'Verified identity required to list an item', 403);
    ensure(categories.includes(data.category), 'Invalid category');
    for (const photo of photos(data.photos)) {
      ensure(!photo.startsWith('/api/v1/evidence/'), 'Private inspection evidence cannot be used in a public listing');
      if (photo.startsWith('/media/')) ensure(this.db.prepare('SELECT name FROM uploads WHERE name=? AND owner_id=?').get(photo.slice(7), actor.id), 'Photo must be uploaded by this account', 403);
    }
    const uid = id();
    const values = [uid, actor.id, string(data.title, 'title', 150), data.category,
      string(data.description, 'description'), string(data.location, 'location', 150),
      money(data.hourly_paise, 'hourly_paise', 1), money(data.daily_paise, 'daily_paise', 1),
      money(data.weekly_paise, 'weekly_paise', 1), money(data.deposit_paise, 'deposit_paise'),
      JSON.stringify(photos(data.photos)), 1, now()];
    return this.transaction(() => {
      this.db.prepare('INSERT INTO listings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...values);
      this.audit(actor, 'listing.created', uid);
      return this.listingJson(this.row('listings', uid));
    });
  }
  setListingActive(actor, uid, data) {
    ensure(typeof data.active === 'boolean', 'active must be a boolean');
    return this.transaction(() => {
      const listing = this.row('listings', uid);
      ensure(actor.id === listing.owner_id || actor.role === 'admin', 'Only the host or administrator can change this listing', 403);
      this.db.prepare('UPDATE listings SET active=? WHERE id=?').run(Number(data.active), uid);
      this.audit(actor, data.active ? 'listing.activated' : 'listing.archived', uid);
      return this.listingJson(this.row('listings', uid));
    });
  }
  static price(listing, start, end) {
    const hours = Math.ceil((end - start) / 3600);
    const daily = Math.min(listing.daily_paise, 24 * listing.hourly_paise);
    const weekly = Math.min(listing.weekly_paise, 7 * daily);
    const weeks = Math.floor(hours / 168), rest = hours % 168;
    const days = Math.floor(rest / 24), remaining = rest % 24;
    const rental = weeks * weekly + Math.min(days * daily + Math.min(remaining * listing.hourly_paise, daily), rest ? weekly : 0);
    return { hours, rental_paise: rental, fee_paise: 3000, deposit_paise: listing.deposit_paise, total_paise: rental + 3000 + listing.deposit_paise, currency: 'INR' };
  }
  createBooking(actor, data, quoteOnly = false) {
    const start = date(data.start), end = date(data.end);
    ensure(start > now() && end > start && end - start <= 90 * 86400, 'Choose a future rental lasting up to 90 days');
    return this.transaction(() => {
      const listing = this.row('listings', string(data.listing_id, 'listing_id', 24));
      ensure(listing.active, 'Listing is unavailable', 409);
      ensure(listing.owner_id !== actor.id, 'You cannot rent your own item');
      ensure(actor.kyc_status === 'verified', 'Verified identity required to book', 403);
      const overlap = this.db.prepare("SELECT id FROM bookings WHERE listing_id=? AND status IN ('requested','approved','active','return_review','disputed') AND start_at<? AND end_at>?").get(listing.id, end, start);
      ensure(!overlap, 'Item is already reserved for these dates', 409);
      const price = Marketplace.price(listing, start, end);
      if (quoteOnly) return price;
      const uid = id();
      this.db.prepare('INSERT INTO bookings(id,listing_id,renter_id,owner_id,start_at,end_at,status,rental_paise,fee_paise,deposit_paise,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(uid, listing.id, actor.id, listing.owner_id, start, end, 'requested', price.rental_paise, price.fee_paise, price.deposit_paise, now());
      this.audit(actor, 'booking.requested', uid);
      return this.row('bookings', uid);
    });
  }
  presentBooking(booking) {
    const listing = this.row('listings', booking.listing_id);
    const owner = this.row('users', booking.owner_id);
    const renter = this.row('users', booking.renter_id);
    return { ...booking, listing: this.listingJson({ ...listing, owner_name: owner.name }), owner_name: owner.name, renter_name: renter.name };
  }
  bookingDetails(actor, uid) {
    const booking = this.row('bookings', uid);
    ensure([booking.renter_id, booking.owner_id].includes(actor.id) || actor.role === 'admin', 'This booking belongs to another account', 403);
    const inspections = this.db.prepare('SELECT * FROM inspections WHERE booking_id=? ORDER BY created_at').all(uid).map(row => ({ ...row, photos: JSON.parse(row.photos), videos: JSON.parse(row.videos || '[]') }));
    return { ...this.presentBooking(booking), inspections, server_time: now(), pickup_available: booking.status === 'approved' && Boolean(booking.owner_signed && booking.renter_signed) && now() >= booking.start_at };
  }
  transition(actor, bid, action, data = {}) {
    return this.transaction(() => {
      const booking = this.row('bookings', bid);
      const owner = booking.owner_id === actor.id, renter = booking.renter_id === actor.id;
      ensure(owner || renter, 'This booking belongs to another account', 403);
      const status = booking.status;
      let target = status;
      if (['approve', 'reject'].includes(action)) {
        ensure(owner, 'Only the host can respond', 403);
        ensure(status === 'requested', 'Request has already been handled', 409);
        target = action === 'approve' ? 'approved' : 'rejected';
      } else if (action === 'cancel') {
        ensure(['requested', 'approved'].includes(status) && now() < booking.start_at, 'Booking can no longer be cancelled', 409);
        target = 'cancelled';
      } else if (action === 'sign') {
        ensure(status === 'approved', 'Approve the booking before signing', 409);
        const column = owner ? 'owner_signed' : 'renter_signed';
        this.db.prepare(`UPDATE bookings SET ${column}=1 WHERE id=?`).run(bid);
      } else if (['pickup', 'return'].includes(action)) {
        ensure(owner, 'Only the host can record handover', 403);
        ensure(status === (action === 'pickup' ? 'approved' : 'active'), 'Invalid handover stage', 409);
        ensure(booking.owner_signed && booking.renter_signed, 'Both parties must sign before handover', 409);
        if (action === 'pickup') ensure(now() >= booking.start_at, 'Rental has not started yet', 409);
        const evidence = photos(data.photos);
        const videos = data.videos ?? [];
        ensure(Array.isArray(videos) && videos.length <= 2 && videos.every(v => typeof v === 'string' && /^\/api\/v1\/evidence\/[a-f0-9]{24}\.(mp4|mov)$/.test(v)), 'Choose up to two uploaded inspection videos');
        ensure(evidence.length > 0 || videos.length > 0, 'At least one inspection photo or video is required');
        for (const media of [...evidence, ...videos]) {
          if (media.startsWith('/api/v1/evidence/')) ensure(this.db.prepare('SELECT name FROM uploads WHERE name=? AND owner_id=? AND booking_id=?').get(media.split('/').pop(), actor.id, bid), 'Evidence must be uploaded for this booking by this account', 403);
          else if (media.startsWith('/media/')) ensure(this.db.prepare('SELECT name FROM uploads WHERE name=? AND owner_id=? AND booking_id IS NULL').get(media.split('/').pop(), actor.id), 'Photo must belong to this account', 403);
        }
        this.db.prepare('INSERT INTO inspections(id,booking_id,kind,actor_id,notes,photos,created_at,videos) VALUES (?,?,?,?,?,?,?,?)').run(id(), bid, action, actor.id, string(data.notes, 'inspection notes'), JSON.stringify(evidence), now(), JSON.stringify(videos));
        target = action === 'pickup' ? 'active' : 'return_review';
      } else if (action === 'complete') {
        ensure(owner, 'Only the host can close the return review', 403);
        ensure(status === 'return_review', 'Return inspection is required', 409);
        this.settle(booking, 0);
        target = 'completed';
      } else throw new ApiError(404, 'Unknown booking action');
      this.db.prepare('UPDATE bookings SET status=? WHERE id=?').run(target, bid);
      this.audit(actor, `booking.${action}`, bid);
      return this.row('bookings', bid);
    });
  }
  settle(booking, damage) {
    // Accounting intentions only: no real capture, payout or refund is performed.
    const entries = [['rental_due', booking.owner_id, booking.rental_paise], ['damage_due', booking.owner_id, damage], ['deposit_release_due', booking.renter_id, booking.deposit_paise - damage]];
    for (const [kind, user, value] of entries) this.db.prepare('INSERT INTO ledger VALUES (?,?,?,?,?,?)').run(id(), booking.id, user, kind, value, now());
  }
  claim(actor, bid, data) {
    return this.transaction(() => {
      const booking = this.row('bookings', bid);
      ensure(booking.owner_id === actor.id, 'Only the host can file a claim', 403);
      ensure(booking.status === 'return_review', 'Claim requires a return inspection', 409);
      const value = money(data.claim_paise, 'claim_paise', 1);
      ensure(value <= booking.deposit_paise, 'Claim exceeds deposit');
      const uid = id();
      this.db.prepare('INSERT INTO disputes(id,booking_id,claim_paise,description,created_at) VALUES (?,?,?,?,?)').run(uid, bid, value, string(data.description, 'description'), now());
      this.db.prepare("UPDATE bookings SET status='disputed' WHERE id=?").run(bid);
      this.audit(actor, 'dispute.created', uid);
      return this.row('disputes', uid);
    });
  }
  respond(actor, did, data) {
    return this.transaction(() => {
      const dispute = this.row('disputes', did), booking = this.row('bookings', dispute.booking_id);
      ensure(booking.renter_id === actor.id, 'Only the renter can respond', 403);
      ensure(dispute.status === 'open', 'Dispute is closed', 409);
      this.db.prepare('UPDATE disputes SET response=? WHERE id=?').run(string(data.response, 'response'), did);
      this.audit(actor, 'dispute.responded', did);
      return this.row('disputes', did);
    });
  }
  resolve(actor, did, data) {
    this.admin(actor);
    const value = money(data.settlement_paise, 'settlement_paise'), notes = string(data.notes, 'resolution notes');
    return this.transaction(() => {
      const dispute = this.row('disputes', did);
      ensure(dispute.status === 'open', 'Dispute has already been resolved', 409);
      ensure(value <= dispute.claim_paise, 'Settlement exceeds claim');
      const booking = this.row('bookings', dispute.booking_id);
      this.settle(booking, value);
      this.db.prepare("UPDATE disputes SET status='resolved',settlement_paise=?,notes=? WHERE id=?").run(value, notes, did);
      this.db.prepare("UPDATE bookings SET status='completed' WHERE id=?").run(booking.id);
      this.audit(actor, 'dispute.resolved', did);
      return this.row('disputes', did);
    });
  }
  collection(actor, table, query = {}) {
    ensure(['bookings', 'disputes', 'ledger', 'users', 'audit', 'listings'].includes(table), 'Unknown collection', 404);
    const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 50));
    const offset = Math.max(0, Number.parseInt(query.offset, 10) || 0);
    let rows;
    if (actor.role === 'admin') rows = this.db.prepare(`SELECT * FROM ${table} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`).all(limit, offset);
    else if (table === 'bookings') rows = this.db.prepare('SELECT * FROM bookings WHERE renter_id=? OR owner_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(actor.id, actor.id, limit, offset);
    else if (table === 'ledger') rows = this.db.prepare('SELECT * FROM ledger WHERE user_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(actor.id, limit, offset);
    else if (table === 'disputes') rows = this.db.prepare('SELECT d.* FROM disputes d JOIN bookings b ON d.booking_id=b.id WHERE b.renter_id=? OR b.owner_id=? ORDER BY d.created_at DESC,d.id LIMIT ? OFFSET ?').all(actor.id, actor.id, limit, offset);
    else throw new ApiError(403, 'Administrator access required');
    return { items: table === 'listings' ? rows.map(row => this.listingJson(row)) : table === 'bookings' ? rows.map(row => this.presentBooking(row)) : rows, limit, offset };
  }
  stats(actor) {
    this.admin(actor);
    const count = (table, where = '1=1') => this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get().count;
    return { totalUsers: count('users'), totalListings: count('listings', 'active=1'), activeRentals: count('bookings', "status='active'"), completedRentals: count('bookings', "status='completed'"), pendingDisputes: count('disputes', "status='open'"), unverifiedUsers: count('users', "kyc_status='unverified'"), paymentMode: 'not-configured' };
  }
}
