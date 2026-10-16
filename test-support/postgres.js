import { spawnSync } from 'node:child_process';
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a DISPOSABLE PostgreSQL database; tests delete its aayplus schema data');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1'], { stdio: 'inherit', env: process.env });
process.exitCode = result.status ?? 1;
