import Database from 'better-sqlite3';
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sqliteSchema } from './schema.js';
import { readFile } from 'node:fs/promises';

// The API uses integer flags, epoch seconds and JSON text on both backends.
// Only SQL parameters are translated; values always remain bound parameters.
export function postgresSql(sql) {
  let index = 0;
  return sql.replace(/'(?:''|[^'])*'|\?/g, value => value === '?' ? `$${++index}` : value);
}
export function openDatabase(location) {
  if (/^postgres(?:ql)?:\/\//.test(location)) return new PostgresDatabase(location);
  const db = new Database(location);
  const context = new AsyncLocalStorage();
  let pending = Promise.resolve();
  const queued = async fn => {
    if (context.getStore()) return fn();
    const previous = pending;
    let release; pending = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await context.run(true, fn); }
    finally { release(); }
  };
  return {
    initialize: () => queued(() => {
      db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 5000');
      db.exec(sqliteSchema);
      if (!db.prepare('PRAGMA table_info(uploads)').all().some(c => c.name === 'booking_id')) db.exec('ALTER TABLE uploads ADD COLUMN booking_id TEXT REFERENCES bookings(id)');
      if (!db.prepare('PRAGMA table_info(inspections)').all().some(c => c.name === 'videos')) db.exec("ALTER TABLE inspections ADD COLUMN videos TEXT NOT NULL DEFAULT '[]'");
    }),
    prepare(sql) {
      return Object.fromEntries(['get', 'all', 'run'].map(method => [method, (...params) => queued(() => db.prepare(sql)[method](...params))]));
    },
    transaction: fn => queued(async () => {
      db.exec('BEGIN IMMEDIATE');
      try { const result = await fn(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }),
    close: () => queued(() => db.close()),
  };
}
export class PostgresDatabase {
  constructor(connectionString) {
    this.pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
    this.context = new AsyncLocalStorage();
    this.pool.on('error', () => console.error('An idle PostgreSQL connection failed'));
  }
  async initialize() {
    // Migrations are an explicit operator command, never an implicit destructive startup action.
    const result = await this.pool.query('SELECT version FROM aayplus.schema_version WHERE version=1');
    if (result.rowCount !== 1) throw new Error('Run npm run db:migrate before starting the API');
  }
  async migrate() {
    const sql = await readFile(new URL('../migrations/001_postgres.sql', import.meta.url), 'utf8');
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(731245901)'); await client.query(sql); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  prepare(sql) {
    const query = async params => {
      const client = this.context.getStore();
      if (client) return client.query(postgresSql(sql), params);
      const connection = await this.pool.connect();
      try {
        await connection.query('SET search_path TO aayplus');
        return await connection.query(postgresSql(sql), params);
      } finally { connection.release(); }
    };
    return {
      get: async (...params) => (await query(params)).rows[0],
      all: async (...params) => (await query(params)).rows,
      run: async (...params) => ({ changes: (await query(params)).rowCount }),
    };
  }
  async transaction(fn) {
    if (this.context.getStore()) return fn();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path TO aayplus');
      // Matches SQLite BEGIN IMMEDIATE semantics across all API instances: checks,
      // state changes, audit and ledger inserts commit together. Suitable for initial scale.
      await client.query('SELECT pg_advisory_xact_lock(731245901)');
      const result = await this.context.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  close() { return this.pool.end(); }
}
