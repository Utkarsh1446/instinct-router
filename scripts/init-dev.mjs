import { mkdir, chmod, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const dir = new URL('../.dev/', import.meta.url);
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
const apps = [{ id: 'instinct', publishableKey: 'router_test_public_instinct', serverKey: randomBytes(32).toString('base64url'),
  allowedOrigins: ['http://127.0.0.1:8792'], rateLimitPerMinute: 60, maxConcurrent: 2 }];
try {
  await writeFile(new URL('apps.json', dir), JSON.stringify({ apps }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Created owner-only local app configuration. The server credential stays in .dev/apps.json.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Local app configuration already exists; kept its credentials.');
}
