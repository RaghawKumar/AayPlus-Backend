import { openDatabase } from './database.js';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, message) {super(message);this.status = status;}
}
export function ensure(condition, message, status = 400) {
  if (!condition) throw new ApiError(status, message);
}
export const id = () => randomBytes(12).toString('hex');
export const hash = (value) => createHash('sha256').update(value).digest('hex');
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
  ensure(Array.isArray(value) && value.length <= 12 && value.every((photo) => {
    if (typeof photo !== 'string' || photo.length > 2000) return false;
    if (/^\/(?:media|api\/v1\/evidence)\/[a-f0-9]{24}\.jpg$/.test(photo)) return true;
    try {return new URL(photo).protocol === 'https:';} catch {return false;}
  }), 'Photos must contain up to 12 uploaded images or HTTPS URLs');
  return value;
}
const categories = ['Bikes', 'Cameras', 'Electronics', 'Parking'];

export class Marketplace {
  constructor(path, { development = false } = {}) {
    this.development = development;
    this.db = openDatabase(path);
  }
  async initialize() {await this.db.initialize();return this;}

  async close() {await this.db.close();}
  async transaction(fn) {return await this.db.transaction(fn);}
  async row(table, resourceId) {
    ensure(['users', 'listings', 'bookings', 'disputes'].includes(table), 'Invalid resource');
    const row = await this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(resourceId);
    ensure(row, 'Resource not found', 404);
    return row;
  }
  async audit(actor, action, resource) {
    await this.db.prepare('INSERT INTO audit VALUES (?,?,?,?,?)').run(id(), actor.id, action, resource, now());
  }
  admin(actor) {ensure(actor.role === 'admin', 'Administrator access required', 403);}
  async requestOtp(data) {
    const phone = data.phone;
    ensure(typeof phone === 'string' && /^\+91[6-9][0-9]{9}$/.test(phone), 'Use +91 followed by a valid 10-digit mobile number');
    ensure(this.development, 'SMS provider is not configured', 503);
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.transaction(async () => {
      const previous = await this.db.prepare('SELECT sent_at FROM otps WHERE phone=?').get(phone);
      ensure(!previous || now() - previous.sent_at >= 60, 'Wait 60 seconds before requesting another code', 429);
      await this.db.prepare('INSERT INTO otps VALUES (?,?,?,?,?) ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=excluded.attempts,sent_at=excluded.sent_at').run(phone, hash(phone + code), now() + 300, 0, now());
    });
    return { expiresIn: 300, developmentCode: code, delivery: 'development-only' };
  }
  async verifyOtp(data) {
    const { phone, code } = data;
    ensure(typeof phone === 'string' && typeof code === 'string' && /^\d{6}$/.test(code), 'Phone and six-digit code are required');
    // Return failed verification from the transaction so the attempt counter commits.
    const result = await this.transaction(async () => {
      const otp = await this.db.prepare('SELECT * FROM otps WHERE phone=?').get(phone);
      if (!otp || otp.expires_at <= now() || otp.attempts >= 5) return null;
      if (!timingSafeEqual(Buffer.from(otp.code_hash, 'hex'), Buffer.from(hash(phone + code), 'hex'))) {
        await this.db.prepare('UPDATE otps SET attempts=attempts+1 WHERE phone=?').run(phone);
        return null;
      }
      let user = await this.db.prepare('SELECT * FROM users WHERE phone=?').get(phone);
      if (!user) {
        const uid = id();
        await this.db.prepare('INSERT INTO users(id,phone,name,created_at) VALUES (?,?,?,?)').run(uid, phone, string(data.name, 'name', 100), now());
        user = await this.row('users', uid);
      }
      await this.db.prepare('DELETE FROM otps WHERE phone=?').run(phone);
      await this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now());
      const token = randomBytes(32).toString('base64url');
      await this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), user.id, now() + 604800);
      return { token, expiresIn: 604800, user };
    });
    ensure(result, 'Invalid or expired verification code', 401);
    return result;
  }
  async authenticate(token) {
    const user = await this.db.prepare('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?').get(hash(token), now());
    ensure(user, 'Authentication required', 401);
    return user;
  }
  async logout(token) {await this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));return { loggedOut: true };}
  async updateAccount(actor, data) {
    const name = string(data.name ?? actor.name, 'name', 100);
    const email = data.email ?? actor.email;
    ensure(typeof email === 'string' && email.length <= 254 && (!email || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)), 'Invalid email');
    await this.db.prepare('UPDATE users SET name=?,email=? WHERE id=?').run(name, email, actor.id);
    return await this.row('users', actor.id);
  }
  async reviewKyc(actor, uid, data) {
    this.admin(actor);
    ensure(['verified', 'rejected'].includes(data.status), 'Invalid verification status');
    ensure(this.development, 'Identity verification provider is not configured', 503);
    return await this.transaction(async () => {
      await this.row('users', uid);
      await this.db.prepare('UPDATE users SET kyc_status=? WHERE id=?').run(data.status, uid);
      await this.audit(actor, `kyc.development.${data.status}`, uid);
      return await this.row('users', uid);
    });
  }
  listingJson(row) {return { ...row, photos: JSON.parse(row.photos), active: Boolean(row.active) };}
  async listings(query = {}) {
    const conditions = ['l.active=1'],params = [];
    for (const key of ['category', 'location']) {
      if (query[key]) {conditions.push(`l.${key}=?`);params.push(string(query[key], key, 150));}
    }
    if (query.q) {conditions.push('(l.title LIKE ? OR l.description LIKE ?)');const q = `%${string(query.q, 'search', 100)}%`;params.push(q, q);}
    const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 50));
    const offset = Math.max(0, Number.parseInt(query.offset, 10) || 0);
    const rows = await this.db.prepare(`SELECT l.*,u.name AS owner_name FROM listings l JOIN users u ON u.id=l.owner_id WHERE ${conditions.join(' AND ')} ORDER BY l.created_at DESC,l.id LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { items: rows.map((row) => this.listingJson(row)), limit, offset };
  }
  async ownListings(actor, query = {}) {
    const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 50));
    const offset = Math.max(0, Number.parseInt(query.offset, 10) || 0);
    const rows = await this.db.prepare('SELECT * FROM listings WHERE owner_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(actor.id, limit, offset);
    return { items: rows.map((row) => this.listingJson({ ...row, owner_name: actor.name })), limit, offset };
  }
  async createListing(actor, data) {
    ensure(actor.kyc_status === 'verified', 'Verified identity required to list an item', 403);
    ensure(categories.includes(data.category), 'Invalid category');
    for (const photo of photos(data.photos)) {
      ensure(!photo.startsWith('/api/v1/evidence/'), 'Private inspection evidence cannot be used in a public listing');
      if (photo.startsWith('/media/')) ensure(await this.db.prepare('SELECT name FROM uploads WHERE name=? AND owner_id=?').get(photo.slice(7), actor.id), 'Photo must be uploaded by this account', 403);
    }
    const uid = id();
    const values = [uid, actor.id, string(data.title, 'title', 150), data.category,
    string(data.description, 'description'), string(data.location, 'location', 150),
    money(data.hourly_paise, 'hourly_paise', 1), money(data.daily_paise, 'daily_paise', 1),
    money(data.weekly_paise, 'weekly_paise', 1), money(data.deposit_paise, 'deposit_paise'),
    JSON.stringify(photos(data.photos)), 1, now()];
    return await this.transaction(async () => {
      await this.db.prepare('INSERT INTO listings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...values);
      await this.audit(actor, 'listing.created', uid);
      return this.listingJson(await this.row('listings', uid));
    });
  }
  async setListingActive(actor, uid, data) {
    ensure(typeof data.active === 'boolean', 'active must be a boolean');
    return await this.transaction(async () => {
      const listing = await this.row('listings', uid);
      ensure(actor.id === listing.owner_id || actor.role === 'admin', 'Only the host or administrator can change this listing', 403);
      await this.db.prepare('UPDATE listings SET active=? WHERE id=?').run(Number(data.active), uid);
      await this.audit(actor, data.active ? 'listing.activated' : 'listing.archived', uid);
      return this.listingJson(await this.row('listings', uid));
    });
  }
  static price(listing, start, end) {
    const hours = Math.ceil((end - start) / 3600);
    const daily = Math.min(listing.daily_paise, 24 * listing.hourly_paise);
    const weekly = Math.min(listing.weekly_paise, 7 * daily);
    const weeks = Math.floor(hours / 168),rest = hours % 168;
    const days = Math.floor(rest / 24),remaining = rest % 24;
    const rental = weeks * weekly + Math.min(days * daily + Math.min(remaining * listing.hourly_paise, daily), rest ? weekly : 0);
    return { hours, rental_paise: rental, fee_paise: 3000, deposit_paise: listing.deposit_paise, total_paise: rental + 3000 + listing.deposit_paise, currency: 'INR' };
  }
  async createBooking(actor, data, quoteOnly = false) {
    const start = date(data.start),end = date(data.end);
    ensure(start > now() && end > start && end - start <= 90 * 86400, 'Choose a future rental lasting up to 90 days');
    return await this.transaction(async () => {
      const listing = await this.row('listings', string(data.listing_id, 'listing_id', 24));
      ensure(listing.active, 'Listing is unavailable', 409);
      ensure(listing.owner_id !== actor.id, 'You cannot rent your own item');
      ensure(actor.kyc_status === 'verified', 'Verified identity required to book', 403);
      const overlap = await this.db.prepare("SELECT id FROM bookings WHERE listing_id=? AND status IN ('requested','approved','active','return_review','disputed') AND start_at<? AND end_at>?").get(listing.id, end, start);
      ensure(!overlap, 'Item is already reserved for these dates', 409);
      const price = Marketplace.price(listing, start, end);
      if (quoteOnly) return price;
      const uid = id();
      await this.db.prepare('INSERT INTO bookings(id,listing_id,renter_id,owner_id,start_at,end_at,status,rental_paise,fee_paise,deposit_paise,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(uid, listing.id, actor.id, listing.owner_id, start, end, 'requested', price.rental_paise, price.fee_paise, price.deposit_paise, now());
      await this.audit(actor, 'booking.requested', uid);
      return await this.row('bookings', uid);
    });
  }
  async presentBooking(booking) {
    const listing = await this.row('listings', booking.listing_id);
    const owner = await this.row('users', booking.owner_id);
    const renter = await this.row('users', booking.renter_id);
    return { ...booking, listing: this.listingJson({ ...listing, owner_name: owner.name }), owner_name: owner.name, renter_name: renter.name };
  }
  async bookingDetails(actor, uid) {
    const booking = await this.row('bookings', uid);
    ensure([booking.renter_id, booking.owner_id].includes(actor.id) || actor.role === 'admin', 'This booking belongs to another account', 403);
    const inspections = (await this.db.prepare('SELECT * FROM inspections WHERE booking_id=? ORDER BY created_at').all(uid)).map((row) => ({ ...row, photos: JSON.parse(row.photos), videos: JSON.parse(row.videos || '[]') }));
    return { ...(await this.presentBooking(booking)), inspections, server_time: now(), pickup_available: booking.status === 'approved' && Boolean(booking.owner_signed && booking.renter_signed) && now() >= booking.start_at };
  }
  async transition(actor, bid, action, data = {}) {
    return await this.transaction(async () => {
      const booking = await this.row('bookings', bid);
      const owner = booking.owner_id === actor.id,renter = booking.renter_id === actor.id;
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
        await this.db.prepare(`UPDATE bookings SET ${column}=1 WHERE id=?`).run(bid);
      } else if (['pickup', 'return'].includes(action)) {
        ensure(owner, 'Only the host can record handover', 403);
        ensure(status === (action === 'pickup' ? 'approved' : 'active'), 'Invalid handover stage', 409);
        ensure(booking.owner_signed && booking.renter_signed, 'Both parties must sign before handover', 409);
        if (action === 'pickup') ensure(now() >= booking.start_at, 'Rental has not started yet', 409);
        const evidence = photos(data.photos);
        const videos = data.videos ?? [];
        ensure(Array.isArray(videos) && videos.length <= 2 && videos.every((v) => typeof v === 'string' && /^\/api\/v1\/evidence\/[a-f0-9]{24}\.(mp4|mov)$/.test(v)), 'Choose up to two uploaded inspection videos');
        ensure(evidence.length > 0 || videos.length > 0, 'At least one inspection photo or video is required');
        for (const media of [...evidence, ...videos]) {
          if (media.startsWith('/api/v1/evidence/')) ensure(await this.db.prepare('SELECT name FROM uploads WHERE name=? AND owner_id=? AND booking_id=?').get(media.split('/').pop(), actor.id, bid), 'Evidence must be uploaded for this booking by this account', 403);else
          if (media.startsWith('/media/')) ensure(await this.db.prepare('SELECT name FROM uploads WHERE name=? AND owner_id=? AND booking_id IS NULL').get(media.split('/').pop(), actor.id), 'Photo must belong to this account', 403);
        }
        await this.db.prepare('INSERT INTO inspections(id,booking_id,kind,actor_id,notes,photos,created_at,videos) VALUES (?,?,?,?,?,?,?,?)').run(id(), bid, action, actor.id, string(data.notes, 'inspection notes'), JSON.stringify(evidence), now(), JSON.stringify(videos));
        target = action === 'pickup' ? 'active' : 'return_review';
      } else if (action === 'complete') {
        ensure(owner, 'Only the host can close the return review', 403);
        ensure(status === 'return_review', 'Return inspection is required', 409);
        await this.settle(booking, 0);
        target = 'completed';
      } else throw new ApiError(404, 'Unknown booking action');
      await this.db.prepare('UPDATE bookings SET status=? WHERE id=?').run(target, bid);
      await this.audit(actor, `booking.${action}`, bid);
      return await this.row('bookings', bid);
    });
  }
  async settle(booking, damage) {
    // Accounting intentions only: no real capture, payout or refund is performed.
    const entries = [['rental_due', booking.owner_id, booking.rental_paise], ['damage_due', booking.owner_id, damage], ['deposit_release_due', booking.renter_id, booking.deposit_paise - damage]];
    for (const [kind, user, value] of entries) await this.db.prepare('INSERT INTO ledger VALUES (?,?,?,?,?,?)').run(id(), booking.id, user, kind, value, now());
  }
  async claim(actor, bid, data) {
    return await this.transaction(async () => {
      const booking = await this.row('bookings', bid);
      ensure(booking.owner_id === actor.id, 'Only the host can file a claim', 403);
      ensure(booking.status === 'return_review', 'Claim requires a return inspection', 409);
      const value = money(data.claim_paise, 'claim_paise', 1);
      ensure(value <= booking.deposit_paise, 'Claim exceeds deposit');
      const uid = id();
      await this.db.prepare('INSERT INTO disputes(id,booking_id,claim_paise,description,created_at) VALUES (?,?,?,?,?)').run(uid, bid, value, string(data.description, 'description'), now());
      await this.db.prepare("UPDATE bookings SET status='disputed' WHERE id=?").run(bid);
      await this.audit(actor, 'dispute.created', uid);
      return await this.row('disputes', uid);
    });
  }
  async respond(actor, did, data) {
    return await this.transaction(async () => {
      const dispute = await this.row('disputes', did),booking = await this.row('bookings', dispute.booking_id);
      ensure(booking.renter_id === actor.id, 'Only the renter can respond', 403);
      ensure(dispute.status === 'open', 'Dispute is closed', 409);
      await this.db.prepare('UPDATE disputes SET response=? WHERE id=?').run(string(data.response, 'response'), did);
      await this.audit(actor, 'dispute.responded', did);
      return await this.row('disputes', did);
    });
  }
  async resolve(actor, did, data) {
    this.admin(actor);
    const value = money(data.settlement_paise, 'settlement_paise'),notes = string(data.notes, 'resolution notes');
    return await this.transaction(async () => {
      const dispute = await this.row('disputes', did);
      ensure(dispute.status === 'open', 'Dispute has already been resolved', 409);
      ensure(value <= dispute.claim_paise, 'Settlement exceeds claim');
      const booking = await this.row('bookings', dispute.booking_id);
      await this.settle(booking, value);
      await this.db.prepare("UPDATE disputes SET status='resolved',settlement_paise=?,notes=? WHERE id=?").run(value, notes, did);
      await this.db.prepare("UPDATE bookings SET status='completed' WHERE id=?").run(booking.id);
      await this.audit(actor, 'dispute.resolved', did);
      return await this.row('disputes', did);
    });
  }
  async collection(actor, table, query = {}) {
    ensure(['bookings', 'disputes', 'ledger', 'users', 'audit', 'listings'].includes(table), 'Unknown collection', 404);
    const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 50));
    const offset = Math.max(0, Number.parseInt(query.offset, 10) || 0);
    let rows;
    if (actor.role === 'admin') rows = await this.db.prepare(`SELECT * FROM ${table} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`).all(limit, offset);else
    if (table === 'bookings') rows = await this.db.prepare('SELECT * FROM bookings WHERE renter_id=? OR owner_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(actor.id, actor.id, limit, offset);else
    if (table === 'ledger') rows = await this.db.prepare('SELECT * FROM ledger WHERE user_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(actor.id, limit, offset);else
    if (table === 'disputes') rows = await this.db.prepare('SELECT d.* FROM disputes d JOIN bookings b ON d.booking_id=b.id WHERE b.renter_id=? OR b.owner_id=? ORDER BY d.created_at DESC,d.id LIMIT ? OFFSET ?').all(actor.id, actor.id, limit, offset);else
    throw new ApiError(403, 'Administrator access required');
    return { items: table === 'listings' ? rows.map((row) => this.listingJson(row)) : table === 'bookings' ? await Promise.all(rows.map(async (row) => await this.presentBooking(row))) : rows, limit, offset };
  }
  async stats(actor) {
    this.admin(actor);
    const count = async (table, where = '1=1') => Number((await this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get()).count);
    return { totalUsers: await count('users'), totalListings: await count('listings', 'active=1'), activeRentals: await count('bookings', "status='active'"), completedRentals: await count('bookings', "status='completed'"), pendingDisputes: await count('disputes', "status='open'"), unverifiedUsers: await count('users', "kyc_status='unverified'"), paymentMode: 'not-configured' };
  }
}
