import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { SupabaseStorage } from '../src/storage.js';
import { configuredService, configuredStorage } from '../src/config.js';
import { postgresSql } from '../src/database.js';

test('Supabase uploads use separate buckets, server credentials and no overwrite', async () => {
  const calls = [];
  const storage = new SupabaseStorage({ url: 'https://example.supabase.co', secret: 'server-only-secret', fetcher: async (url, options) => { calls.push({ url, options }); return new Response('{}'); } });
  await storage.put('photo.jpg', Buffer.from('image'), false);
  await storage.put('video.mp4', Buffer.from('video'), true);
  await storage.remove('video.mp4', true);
  assert.match(calls[0].url, /\/listing-images\/photo.jpg$/);
  assert.match(calls[1].url, /\/inspection-evidence\/video.mp4$/);
  assert.equal(calls[0].options.headers.apikey, 'server-only-secret');
  assert.equal(calls[0].options.headers['x-upsert'], 'false');
  assert.equal(calls[1].options.headers['Content-Type'], 'video/mp4');
  assert.equal(calls[2].options.method, 'DELETE');
});

test('Supabase media proxy forwards ranges without exposing credentials', async () => {
  let request;
  const storage = new SupabaseStorage({ url: 'https://example.supabase.co', secret: 'server-only-secret', fetcher: async (url, options) => {
    request = { url, options };
    return new Response('clip', { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-3/20', 'Accept-Ranges': 'bytes', 'Content-Length': '4' } });
  } });
  const res = new PassThrough(); const headers = {}; const chunks = [];
  res.status = value => { res.statusCode = value; return res; };
  res.set = (key, value) => { headers[key] = value; };
  res.on('data', chunk => chunks.push(chunk));
  await storage.send({ headers: { range: 'bytes=0-3' } }, res, () => {}, 'video.mp4', true);
  assert.equal(request.options.headers.Range, 'bytes=0-3');
  assert.match(request.url, /inspection-evidence/);
  assert.equal(res.statusCode, 206);
  assert.equal(headers['content-range'], 'bytes 0-3/20');
  assert.equal(Buffer.concat(chunks).toString(), 'clip');
  assert.ok(!JSON.stringify(headers).includes('server-only-secret'));
});

test('Storage errors are sanitized and network failures become retryable errors', async () => {
  const storage = new SupabaseStorage({ url: 'https://example.supabase.co', secret: 'secret', fetcher: async () => new Response('sensitive provider detail', { status: 403 }) });
  await assert.rejects(() => storage.put('photo.jpg', Buffer.from('x'), false), error => error.status === 503 && !error.message.includes('sensitive'));
  storage.fetch = async () => { throw new Error('secret connection details'); };
  await assert.rejects(() => storage.put('photo.jpg', Buffer.from('x'), false), error => error.status === 503 && !error.message.includes('secret'));
});

test('Supabase configuration fails instead of silently using ephemeral SQLite', async () => {
  await assert.rejects(() => configuredService({ SUPABASE_URL: 'https://example.supabase.co' }), /DATABASE_URL/);
  assert.throws(() => configuredStorage({ DATABASE_URL: 'postgresql://localhost/db' }), /SUPABASE_URL/);
  assert.equal(postgresSql("SELECT '?' AS literal FROM users WHERE id=? AND name=?"), "SELECT '?' AS literal FROM users WHERE id=$1 AND name=$2");
});
