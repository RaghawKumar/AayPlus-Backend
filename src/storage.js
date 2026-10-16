import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ApiError } from './service.js';

export class LocalStorage {
  constructor(directory) { this.directory = resolve(directory); }
  async put(name, bytes) { await mkdir(this.directory, { recursive: true }); await writeFile(join(this.directory, name), bytes, { flag: 'wx' }); }
  async remove(name) { await unlink(join(this.directory, name)).catch(() => {}); }
  send(req, res, next, name) { res.sendFile(name, { root: this.directory }, error => { if (error) next(new ApiError(404, 'Media unavailable')); }); }
}

// Use the Storage REST API so server secrets never reach clients. Both buckets
// stay private; the API exposes listing images only after checking their DB row.
export class SupabaseStorage {
  constructor({ url, secret, listingBucket = 'listing-images', evidenceBucket = 'inspection-evidence', fetcher = fetch }) {
    if (!url || !secret) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required for Supabase Storage');
    this.url = new URL(url).origin;
    if (!this.url.startsWith('https://')) throw new Error('SUPABASE_URL must use HTTPS');
    this.secret = secret; this.listingBucket = listingBucket; this.evidenceBucket = evidenceBucket; this.fetch = fetcher;
  }
  objectUrl(name, privateEvidence) { return `${this.url}/storage/v1/object/${encodeURIComponent(privateEvidence ? this.evidenceBucket : this.listingBucket)}/${encodeURIComponent(name)}`; }
  headers(extra = {}) { return { apikey: this.secret, Authorization: `Bearer ${this.secret}`, ...extra }; }
  async request(url, options) {
    try { return await this.fetch(url, { ...options, signal: AbortSignal.timeout(60000) }); }
    catch { throw new ApiError(503, 'Media storage is temporarily unavailable'); }
  }
  async put(name, bytes, privateEvidence) {
    const response = await this.request(this.objectUrl(name, privateEvidence), { method: 'POST', headers: this.headers({ 'Content-Type': name.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4', 'x-upsert': 'false' }), body: bytes });
    if (!response.ok) { await response.body?.cancel(); throw new ApiError(503, 'Media upload failed; check Storage bucket configuration'); }
    await response.body?.cancel();
  }
  async remove(name, privateEvidence) {
    const response = await this.request(this.objectUrl(name, privateEvidence), { method: 'DELETE', headers: this.headers() });
    await response.body?.cancel();
    if (!response.ok) throw new ApiError(503, 'Media cleanup failed');
  }
  async send(req, res, next, name, privateEvidence) {
    const headers = this.headers();
    if (req.headers.range) headers.Range = req.headers.range;
    const response = await this.request(this.objectUrl(name, privateEvidence), { headers });
    if (![200, 206, 416].includes(response.status)) {
      await response.body?.cancel();
      throw new ApiError(response.status === 404 ? 404 : 503, 'Media unavailable');
    }
    res.status(response.status);
    for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      if (response.headers.has(key)) res.set(key, response.headers.get(key));
    }
    // Respect downstream backpressure for inspection videos.
    const { Readable } = await import('node:stream');
    const { pipeline } = await import('node:stream/promises');
    if (response.body) await pipeline(Readable.fromWeb(response.body), res);
    else res.end();
  }
}
