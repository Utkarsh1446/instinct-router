import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readOwnedJson, port } from './config.mjs';

const listenPort = port(process.env.ROUTER_EXAMPLE_PORT, 8792);
const apiPort = port(process.env.ROUTER_PORT, 8791);
const origin = `http://127.0.0.1:${listenPort}`;
const settings = await readOwnedJson(process.env.ROUTER_APPS_FILE ?? new URL('../.dev/apps.json', import.meta.url).pathname);
const app = settings.apps.find(row => row.allowedOrigins.includes(origin));
if (!app) throw new Error('Allow this example origin in local app configuration.');
const routes = new Map([
  ['/', [new URL('../examples/browser/index.html', import.meta.url), 'text/html']],
  ['/app.js', [new URL('../examples/browser/app.js', import.meta.url), 'text/javascript']],
  ['/trade-progress.js', [new URL('../examples/browser/trade-progress.js', import.meta.url), 'text/javascript']],
  ['/trade-progress.css', [new URL('../examples/browser/trade-progress.css', import.meta.url), 'text/css']],
  ['/asset-picker.js', [new URL('../examples/browser/asset-picker.js', import.meta.url), 'text/javascript']],
  ['/asset-picker.css', [new URL('../examples/browser/asset-picker.css', import.meta.url), 'text/css']],
  ['/asset-balances.js', [new URL('../examples/browser/asset-balances.js', import.meta.url), 'text/javascript']],
  ['/token-selection.js', [new URL('../examples/browser/token-selection.js', import.meta.url), 'text/javascript']],
  ['/wallet-ui.js', [new URL('../examples/browser/wallet-ui.js', import.meta.url), 'text/javascript']],
  ['/wallet-connections.js', [new URL('../examples/browser/wallet-connections.js', import.meta.url), 'text/javascript']],
  ['/wallet-addresses.js', [new URL('../examples/browser/wallet-addresses.js', import.meta.url), 'text/javascript']],
  ['/settlement-poller.js', [new URL('../examples/browser/settlement-poller.js', import.meta.url), 'text/javascript']],
  ...['index.js', 'transport.js', 'validation.js', 'errors.js', 'json.js', 'stream.js', 'execution-api.js', 'execution-stream.js', 'execution-validation.js', 'execution.js', 'wallets.js', 'solana-transaction.js', 'solana-message-codec.js', 'relay-solana-message.js'].map(name => [`/sdk/${name}`, [new URL(`../packages/sdk/src/${name}`, import.meta.url), 'text/javascript']]),
]);
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:${apiPort}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  if (req.url === '/demo-config' || req.url === '/demo-config.json') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ baseUrl: `http://127.0.0.1:${apiPort}`, publishableKey: app.publishableKey }));
  }
  const route = routes.get(req.url);
  if (!route) { res.writeHead(404); return res.end(); }
  try { const body = await readFile(route[0]); res.setHeader('Content-Type', route[1] + '; charset=utf-8'); res.end(body); }
  catch { res.writeHead(503); res.end('Example unavailable.'); }
});
server.listen(listenPort, '127.0.0.1', () => console.log(`External SDK example: ${origin}`));
const stop = () => { server.close(); server.closeAllConnections(); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
