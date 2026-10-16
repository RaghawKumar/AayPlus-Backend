export const sqliteSchema = `
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
