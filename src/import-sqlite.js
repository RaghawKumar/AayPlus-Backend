import 'dotenv/config';
import Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { PostgresDatabase } from './database.js';
import { configuredStorage } from './config.js';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL first');
const source = new Database(resolve(process.env.DATABASE_PATH || './data/aayplus.sqlite3'), { readonly: true, fileMustExist: true });
const target = new PostgresDatabase(process.env.DATABASE_URL);
const storage = configuredStorage();
const copied = [];
const tables = ['users', 'otps', 'sessions', 'listings', 'bookings', 'uploads', 'inspections', 'disputes', 'ledger', 'audit'];
try {
  await target.initialize();
  await target.transaction(async () => {
    for (const table of tables) {
      if (Number((await target.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n)) throw new Error('Target must be empty; import never overwrites existing records');
    }
    for (const table of tables) {
      const rows = source.prepare(`SELECT * FROM ${table}`).all();
      for (const row of rows) {
        if (table === 'uploads') {
          if (!/^[a-f0-9]{24}\.(jpg|mp4)$/.test(row.name)) throw new Error('Unsupported upload filename');
          const bytes = await readFile(join(resolve(process.env.UPLOAD_DIRECTORY || './data/uploads'), row.name));
          await storage.put(row.name, bytes, Boolean(row.booking_id));
          copied.push(row);
        }
        const columns = Object.keys(row);
        if (!columns.every(key => /^[a-z_]+$/.test(key))) throw new Error('Unsupported source column');
        await target.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row));
      }
    }
  });
  console.log('SQLite records and uploaded media imported. Source files were kept unchanged.');
} catch (error) {
  for (const row of copied) await storage.remove(row.name, Boolean(row.booking_id)).catch(() => {});
  console.error('Import failed; database changes rolled back. Check source media, empty target, and connection settings.');
  process.exitCode = 1;
} finally { source.close(); await target.close(); }
