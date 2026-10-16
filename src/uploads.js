import express from 'express';
import ffprobe from 'ffprobe-static';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { LocalStorage } from './storage.js';
import { resolve, join } from 'node:path';
import { ApiError, ensure, id } from './service.js';

export function uploadRouter(service, directory, storage = new LocalStorage(directory)) {
  const router = express.Router();
  const authenticate = async (req, res, next) => {
    try {
      const auth = req.get('Authorization') || '';
      ensure(/^Bearer [A-Za-z0-9_-]{43}$/.test(auth), 'Authentication required', 401);
      req.actor = await service.authenticate(auth.slice(7));
      ensure(req.actor.kyc_status === 'verified', 'Verified identity required to upload media', 403);
      if (req.query.booking_id) {
        const booking = await service.row('bookings', stringBooking(req.query.booking_id));
        ensure(booking.owner_id === req.actor.id && ['approved', 'active'].includes(booking.status), 'Only the host can upload evidence for a pending handover', 403);
        req.evidenceBooking = booking.id;
      }
      ensure(req.is('application/octet-stream'), 'Send the image as application/octet-stream', 415);
      next();
    } catch (error) {next(error);}
  };
  router.post('/', authenticate, express.raw({ type: 'application/octet-stream', limit: '8mb' }), async (req, res) => {
    ensure(Buffer.isBuffer(req.body) && req.body.length > 0, 'Choose an image to upload');
    const recent = await service.db.prepare('SELECT COUNT(*) AS count FROM uploads WHERE owner_id=? AND created_at>?').get(req.actor.id, Math.floor(Date.now() / 1000) - 86400);
    ensure(recent.count < 100, 'Daily photo upload limit reached', 429);
    let image;
    try {
      const source = sharp(req.body, { limitInputPixels: 40_000_000, failOn: 'error' });
      const metadata = await source.metadata();
      ensure(['jpeg', 'png', 'webp', 'heif'].includes(metadata.format) && (metadata.pages || 1) === 1, 'Choose a JPEG, PNG or WebP photo', 415);
      image = await source.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(415, 'This image cannot be read. Try a JPEG or PNG photo.');
    }
    const name = `${id()}.jpg`;
    await storage.put(name, image, Boolean(req.evidenceBooking));
    try {
      await service.db.prepare('INSERT INTO uploads(name,owner_id,created_at,booking_id) VALUES (?,?,?,?)').run(name, req.actor.id, Math.floor(Date.now() / 1000), req.evidenceBooking || null);
    } catch (error) {await storage.remove(name, Boolean(req.evidenceBooking)).catch(() => {});throw error;}
    res.status(201).json({ data: { url: req.evidenceBooking ? `/api/v1/evidence/${name}` : `/media/${name}`, bytes: image.length } });
  });
  router.post('/videos', authenticate, express.raw({ type: 'application/octet-stream', limit: '50mb' }), async (req, res) => {
    ensure(req.evidenceBooking, 'A booking is required for inspection videos');
    ensure(Buffer.isBuffer(req.body) && req.body.length > 0, 'Choose a video to upload');
    ensure((await service.db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE owner_id=? AND created_at>?').get(req.actor.id, Math.floor(Date.now() / 1000) - 86400)).n < 100, 'Daily upload limit reached', 429);
    const temporary = await mkdtemp(join(tmpdir(), 'aayplus-video-'));
    const name = `${id()}.mp4`,path = join(temporary, name);
    try {
      await writeFile(path, req.body, { flag: 'wx' });
      let metadata;
      try {
        const { stdout } = await promisify(execFile)(ffprobe.path, ['-v', 'error', '-protocol_whitelist', 'file', '-show_format', '-show_streams', '-of', 'json', path], { timeout: 15000, maxBuffer: 256 * 1024 });
        metadata = JSON.parse(stdout);
      } catch {throw new ApiError(415, 'This video cannot be read. Choose an MP4 or MOV recording.');}
      const duration = Number(metadata.format?.duration);
      ensure(metadata.format?.format_name?.split(',').some((v) => ['mov', 'mp4'].includes(v)) && metadata.streams?.some((s) => s.codec_type === 'video' && ['h264', 'hevc', 'mpeg4'].includes(s.codec_name)), 'Choose an MP4 or MOV video with H.264 or HEVC encoding', 415);
      ensure(Number.isFinite(duration) && duration > 0 && duration <= 60.5, 'Inspection videos must be 60 seconds or shorter');
      await storage.put(name, req.body, true);
      try {
      await service.db.prepare('INSERT INTO uploads(name,owner_id,created_at,booking_id) VALUES (?,?,?,?)').run(name, req.actor.id, Math.floor(Date.now() / 1000), req.evidenceBooking);
      } catch (error) { await storage.remove(name, true).catch(() => {}); throw error; }
      res.status(201).json({ data: { url: `/api/v1/evidence/${name}`, duration, bytes: req.body.length } });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
  return router;
}

export function mediaDirectory(path = './data/uploads') {return resolve(path);}

function stringBooking(value) {ensure(typeof value === 'string' && /^[a-f0-9]{24}$/.test(value), 'Invalid booking');return value;}
