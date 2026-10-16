import { Marketplace } from '../src/service.js';
export async function testService(localPath, options) {
  const location = process.env.TEST_DATABASE_URL || localPath;
  const service = new Marketplace(location, options);
  if (process.env.TEST_DATABASE_URL) {
    // TEST_DATABASE_URL must point to a disposable database, never the live project.
    await service.db.migrate();
    await service.db.pool.query('TRUNCATE aayplus.users, aayplus.otps CASCADE');
  }
  return service.initialize();
}
