import { randomUUID } from 'node:crypto';
import { createPublicRuntime } from '../scripts/vercel-runtime.mjs';

export const config = { api: { bodyParser: false, responseLimit: false } };
let runtime, retryAfterMs = 0;
export default async function router(req, res) {
  try {
    if (!runtime) {
      if (Date.now() < retryAfterMs) throw new Error('INITIALIZATION_BACKOFF');
      runtime = createPublicRuntime().catch(error => { runtime = undefined; retryAfterMs = Date.now() + 5000; throw error; });
    }
    const current = await runtime;
    if (Date.now() >= current.refreshAfterMs) runtime = undefined;
    await current(req, res);
  } catch {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '5' });
    res.end(JSON.stringify({ apiVersion: '1', requestId: 'req_' + randomUUID(), error: {
      code: 'ROUTER_UNAVAILABLE', message: 'The routing service is temporarily unavailable. Your saved trade remains recoverable.', retryable: true, retryAfterMs: 5000,
    } }));
  }
}
