import 'dotenv/config';
import { PostgresDatabase } from './database.js';
if (!/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL || '')) throw new Error('Set DATABASE_URL to the Supabase Session pooler URI first');
const db = new PostgresDatabase(process.env.DATABASE_URL);
try { await db.migrate(); console.log('PostgreSQL schema migration complete.'); }
catch { console.error('Migration failed. Check DATABASE_URL, database password, TLS configuration and connectivity.'); process.exitCode = 1; }
finally { await db.close(); }
