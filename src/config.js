import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Marketplace } from './service.js';
import { SupabaseStorage, LocalStorage } from './storage.js';

export function configuredAuth(env = process.env) {
  const mode = env.AUTH_OTP_MODE || 'default';
  if (!['default', 'static'].includes(mode)) throw new Error('AUTH_OTP_MODE must be default or static');
  if (mode === 'static' && !/^\d{6}$/.test(env.STATIC_OTP_CODE || '')) throw new Error('Static OTP mode requires a six-digit STATIC_OTP_CODE');
  return { development: env.APP_ENV === 'development', staticOtpCode: mode === 'static' ? env.STATIC_OTP_CODE : null };
}

export async function configuredService(env = process.env) {
  if (env.SUPABASE_URL && !env.DATABASE_URL) throw new Error('Set DATABASE_URL to the Supabase Session pooler PostgreSQL URI; API keys alone do not connect the database');
  if (env.DATABASE_URL && !/^postgres(?:ql)?:\/\//.test(env.DATABASE_URL)) throw new Error('DATABASE_URL must be a PostgreSQL connection URI');
  const location = env.DATABASE_URL || resolve(env.DATABASE_PATH || './data/aayplus.sqlite3');
  if (!env.DATABASE_URL) mkdirSync(dirname(location), { recursive: true });
  const service = new Marketplace(location, configuredAuth(env));
  try { return await service.initialize(); }
  catch (error) { await service.close(); throw error; }
}
export function configuredStorage(env = process.env) {
  if (env.DATABASE_URL || env.SUPABASE_URL) return new SupabaseStorage({
    url: env.SUPABASE_URL, secret: env.SUPABASE_SECRET_KEY,
    listingBucket: env.SUPABASE_LISTING_BUCKET || 'listing-images',
    evidenceBucket: env.SUPABASE_EVIDENCE_BUCKET || 'inspection-evidence',
  });
  return new LocalStorage(env.UPLOAD_DIRECTORY || './data/uploads');
}
