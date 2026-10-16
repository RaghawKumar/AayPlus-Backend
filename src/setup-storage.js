import 'dotenv/config';
import { configuredStorage } from './config.js';
import { SupabaseStorage } from './storage.js';
const storage = configuredStorage();
if (!(storage instanceof SupabaseStorage)) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY first');
for (const bucket of [storage.listingBucket, storage.evidenceBucket]) {
  const url = `${storage.url}/storage/v1/bucket`;
  const existing = await storage.request(`${url}/${encodeURIComponent(bucket)}`, { headers: storage.headers() });
  if (existing.ok) {
    const data = await existing.json();
    if (data.public) throw new Error(`Bucket ${bucket} must be private; disable Public bucket in Supabase before continuing`);
  } else {
    const error = await existing.json().catch(() => ({}));
    if (existing.status !== 404 && String(error.statusCode) !== '404') throw new Error('Cannot inspect Storage buckets; check SUPABASE_URL and SUPABASE_SECRET_KEY');
    const created = await storage.request(url, { method: 'POST', headers: storage.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ id: bucket, name: bucket, public: false, file_size_limit: 52428800, allowed_mime_types: ['image/jpeg', 'video/mp4'] }) });
    if (!created.ok) { await created.body?.cancel(); throw new Error(`Could not create bucket ${bucket}`); }
    await created.body?.cancel();
  }
  console.log(`Private Storage bucket ready: ${bucket}`);
}
