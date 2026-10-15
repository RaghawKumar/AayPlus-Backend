import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createApp } from './app.js';
import { Marketplace } from './service.js';

const path = resolve(process.env.DATABASE_PATH || './data/aayplus.sqlite3');
mkdirSync(dirname(path), { recursive: true });
const service = new Marketplace(path, { development: process.env.APP_ENV === 'development' });
const port = Number(process.env.PORT || 8080), host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
const origins = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:7357').split(',').map(value => value.trim()).filter(Boolean);
const server = createApp(service, { origins, uploadDirectory: process.env.UPLOAD_DIRECTORY || './data/uploads' }).listen(port, host, () => {
  console.log(`AayPlus API: http://${host}:${port} (${service.development ? 'development' : 'restricted'} mode)`);
});
server.requestTimeout = 120_000;
server.headersTimeout = 10_000;
function shutdown() {
  server.close(() => { service.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
