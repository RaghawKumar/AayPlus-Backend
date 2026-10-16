import 'dotenv/config';
import { configuredService } from './config.js';

const [command, phone] = process.argv.slice(2);
if (command !== 'promote-admin' || !/^\+91[6-9][0-9]{9}$/.test(phone || '')) {
  console.error('Usage: npm run admin:promote -- promote-admin +919876543210');
  process.exit(1);
}
const service = await configuredService();
try {
  await service.transaction(async () => {
    const user = await service.db.prepare('SELECT * FROM users WHERE phone=?').get(phone);
    if (!user) throw new Error('Sign in to create this account first.');
    await service.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user.id);
    await service.audit(user, 'operator.promote-admin', user.id);
  });
  console.log('Administrator role granted. Existing sessions pick up the new role.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {await service.close();}
