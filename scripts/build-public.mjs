import { copyFile, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = new URL('../', import.meta.url);
// Explicit lists prevent development configuration, journals, or future source files
// from silently becoming downloadable assets.
export const browserAssets = Object.freeze([
  'index.html', 'app.js', 'trade-progress.js', 'trade-progress.css',
  'asset-picker.js', 'asset-picker.css', 'asset-balances.js', 'token-selection.js',
  'wallet-ui.js', 'wallet-connections.js', 'wallet-addresses.js', 'settlement-poller.js',
]);
export const sdkAssets = Object.freeze([
  'index.js', 'transport.js', 'validation.js', 'errors.js', 'json.js', 'stream.js',
  'execution-api.js', 'execution-stream.js', 'execution-validation.js', 'execution.js',
  'wallets.js', 'solana-transaction.js', 'solana-message-codec.js', 'relay-solana-message.js',
]);

export async function buildPublic({ env = process.env, outputDirectory = fileURLToPath(new URL('public/', root)) } = {}) {
  const publishableKey = env.ROUTER_PUBLIC_APP_KEY;
  if (typeof publishableKey !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(publishableKey))
    throw new Error('Set ROUTER_PUBLIC_APP_KEY to the app publishable credential (16–256 letters, digits, underscores or hyphens).');
  const files = [
    ...browserAssets.map(name => [new URL(`examples/browser/${name}`, root), name]),
    ...sdkAssets.map(name => [new URL(`packages/sdk/src/${name}`, root), `sdk/${name}`]),
  ];
  for (const [source] of files) {
    if (!(await lstat(source)).isFile()) throw new Error('Public assets must be regular files.');
  }
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(resolve(outputDirectory, 'sdk'), { recursive: true });
  for (const [source, destination] of files) await copyFile(source, resolve(outputDirectory, destination));
  // This is intentionally the only environment value published. Never serialize env
  // or load the private app/provider/execution configuration here.
  await writeFile(resolve(outputDirectory, 'demo-config.json'), JSON.stringify({ baseUrl: '', publishableKey }) + '\n');
  return files.length + 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`Built ${await buildPublic()} public assets.`); }
  catch (error) { console.error(`Public build failed: ${error.message}`); process.exitCode = 1; }
}
