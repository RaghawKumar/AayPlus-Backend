import express from 'express';
import { developmentLogging } from './dev-logger.js';
import { randomUUID } from 'node:crypto';
import { ApiError, ensure } from './service.js';
import { uploadRouter, mediaDirectory } from './uploads.js';
import { LocalStorage } from './storage.js';

export function createApp(service, { origins = ['http://localhost:3000'], logger = console, uploadDirectory = './data/uploads', storage = new LocalStorage(uploadDirectory) } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (service.development) app.use(developmentLogging(logger));
  // Keep trust proxy disabled. Configure a trusted proxy before deploying behind one.
  const buckets = new Map();
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Request-Id': randomUUID() });
    const origin = req.headers.origin;
    if (origin && !origins.includes(origin)) return next(new ApiError(403, 'Origin is not allowed'));
    if (origin) {res.set('Access-Control-Allow-Origin', origin);res.vary('Origin');}
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      return res.sendStatus(204);
    }
    const time = Date.now();
    for (const [key, bucket] of buckets) if (bucket.reset <= time) buckets.delete(key);
    const auth = req.path.startsWith('/api/v1/auth/');
    const key = `${req.ip}:${auth ? 'auth' : 'api'}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= 10_000) return next(new ApiError(503, 'Server is busy; try again shortly'));
      bucket = { count: 0, reset: time + 60_000 };buckets.set(key, bucket);
    }
    if (++bucket.count > (auth ? 20 : 180)) {
      res.set('Retry-After', String(Math.ceil((bucket.reset - time) / 1000)));
      return next(new ApiError(429, 'Too many requests; try again shortly'));
    }
    next();
  });
  const images = mediaDirectory(uploadDirectory);
  app.use('/api/v1/uploads', uploadRouter(service, images, storage));
  app.get('/media/:name', async (req, res, next) => {
    if (!/^[a-f0-9]{24}\.jpg$/.test(req.params.name)) return next(new ApiError(404, 'Photo not found'));
    if (!(await service.db.prepare('SELECT name FROM uploads WHERE name=? AND booking_id IS NULL').get(req.params.name))) return next(new ApiError(404, 'Photo not found'));
    await storage.send(req, res, next, req.params.name, false);
  });
  app.use(express.json({ limit: '64kb', strict: true }));
  app.use((req, res, next) => {
    if (['POST', 'PATCH'].includes(req.method)) {
      if (!req.is('application/json')) return next(new ApiError(415, 'Content-Type must be application/json'));
      if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object') return next(new ApiError(400, 'JSON body must be an object'));
    }
    next();
  });
  const send = (res, data, status = 200) => res.status(status).json({ data });
  app.get('/health', (req, res) => res.json({ status: 'ok', mode: service.development ? 'development' : 'restricted', payments: 'not-configured' }));
  const api = express.Router();
  app.use('/api/v1', api);
  api.post('/auth/otp', async (req, res) => send(res, await service.requestOtp(req.body)));
  api.post('/auth/verify', async (req, res) => send(res, await service.verifyOtp(req.body)));
  api.get('/listings', async (req, res) => send(res, await service.listings(req.query)));
  api.get('/listings/:id', async (req, res) => {
    const listing = await service.row('listings', req.params.id);
    ensure(listing.active, 'Resource not found', 404);
    send(res, service.listingJson(listing));
  });
  api.use(async (req, res, next) => {
    const auth = req.get('Authorization') || '';
    ensure(/^Bearer [A-Za-z0-9_-]{43}$/.test(auth), 'Authentication required', 401);
    req.token = auth.slice(7);
    req.actor = await service.authenticate(req.token);
    next();
  });
  api.get('/evidence/:name', async (req, res, next) => {
    ensure(/^[a-f0-9]{24}\.(jpg|mp4)$/.test(req.params.name), 'Evidence not found', 404);
    const upload = await service.db.prepare('SELECT * FROM uploads WHERE name=? AND booking_id IS NOT NULL').get(req.params.name);
    ensure(upload, 'Evidence not found', 404);
    await service.bookingDetails(req.actor, upload.booking_id);
    await storage.send(req, res, next, req.params.name, true);
  });
  api.get('/me/listings', async (req, res) => send(res, await service.ownListings(req.actor, req.query)));
  api.get('/me', (req, res) => send(res, req.actor));
  api.patch('/me', async (req, res) => send(res, await service.updateAccount(req.actor, req.body)));
  api.post('/auth/logout', async (req, res) => send(res, await service.logout(req.token)));
  api.post('/listings', async (req, res) => send(res, await service.createListing(req.actor, req.body), 201));
  api.patch('/listings/:id', async (req, res) => send(res, await service.setListingActive(req.actor, req.params.id, req.body)));
  api.post('/bookings/quote', async (req, res) => send(res, await service.createBooking(req.actor, req.body, true)));
  api.post('/bookings', async (req, res) => send(res, await service.createBooking(req.actor, req.body), 201));
  for (const table of ['bookings', 'disputes', 'ledger']) api.get(`/${table}`, async (req, res) => send(res, await service.collection(req.actor, table, req.query)));
  api.get('/bookings/:id', async (req, res) => send(res, await service.bookingDetails(req.actor, req.params.id)));
  for (const action of ['approve', 'reject', 'cancel', 'sign', 'pickup', 'return', 'complete']) {
    api.post(`/bookings/:id/${action}`, async (req, res) => send(res, await service.transition(req.actor, req.params.id, action, req.body)));
  }
  api.post('/bookings/:id/claim', async (req, res) => send(res, await service.claim(req.actor, req.params.id, req.body), 201));
  api.post('/disputes/:id/response', async (req, res) => send(res, await service.respond(req.actor, req.params.id, req.body)));
  const admin = express.Router();
  api.use('/admin', admin);
  admin.use((req, res, next) => {service.admin(req.actor);next();});
  admin.get('/stats', async (req, res) => send(res, await service.stats(req.actor)));
  for (const table of ['users', 'listings', 'bookings', 'disputes', 'ledger', 'audit']) {
    admin.get(`/${table}`, async (req, res) => send(res, await service.collection(req.actor, table, req.query)));
  }
  admin.post('/users/:id/kyc', async (req, res) => send(res, await service.reviewKyc(req.actor, req.params.id, req.body)));
  admin.post('/disputes/:id/resolve', async (req, res) => send(res, await service.resolve(req.actor, req.params.id, req.body)));
  app.use((req, res, next) => next(new ApiError(404, 'Route not found')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    let status = error instanceof ApiError ? error.status : 500;
    let message = error instanceof ApiError ? error.message : 'Internal server error';
    if (error.type === 'entity.parse.failed') {status = 400;message = 'Invalid JSON';}
    if (error.type === 'entity.too.large') {status = 413;message = 'Request body is too large';}
    if (error.code?.startsWith('SQLITE_CONSTRAINT') || ['23505', '23503', '23514', '23P01'].includes(error.code)) {status = 409;message = 'Operation conflicts with an existing record';}
    if (['SQLITE_BUSY', '40001', '40P01', '55P03'].includes(error.code)) {status = 503;message = 'Database is busy; retry shortly';}
    if (status === 500) logger.error({ requestId: res.get('X-Request-Id'), error: error.message });
    res.status(status).json({ error: { message, requestId: res.get('X-Request-Id') } });
  });
  return app;
}
