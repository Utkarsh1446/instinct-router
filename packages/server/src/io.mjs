import { ApiError, fault, single } from './security.mjs';
import { parseStrictJson } from './strict-json.mjs';
import { performance } from 'node:perf_hooks';

export const baseHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', Vary: 'Origin' };
export function send(res, status, value, origin, extra = {}) {
  if (res.destroyed || res.writableEnded) return;
  const raw = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value));
  res.writeHead(status, { ...baseHeaders, ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}), ...extra,
    ...(status >= 400 ? { Connection: 'close' } : {}), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': raw.length });
  res.end(raw);
}
export const streamLimits = Object.freeze({ candidates: 128, lineBytes: 262144, totalBytes: 2097152,
  queuedEvents: 64, drainMs: 2000 });

/** One bounded writer. Producers never wait on an unbounded client-side queue. */
export function createQuoteStream(res, { origin, requestId, appId, request, cancel, limits = streamLimits,
  lifetimeMs = 12000 + streamLimits.drainMs, clock = () => performance.now() }) {
  const common = { apiVersion: '1', requestId, appId, request: structuredClone(request) };
  const deadline = clock() + lifetimeMs;
  let sequence = 0, written = 0, writtenBytes = 0, candidates = 0, bytes = 0, pumping = false, terminal = false, closed = false;
  let resolveDone, rejectDone;
  const queue = [], done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  done.catch(() => {});
  let lifetime;
  const cleanup = () => { clearTimeout(lifetime); res.off('close', disconnected); res.off('error', disconnected); };
  const disconnected = () => {
    if (closed) return;
    closed = true; queue.length = 0; cleanup(); cancel('disconnected');
    rejectDone(new ApiError(499, 'CANCELLED', 'The request was cancelled.'));
  };
  const expired = () => {
    if (closed) return;
    closed = true; queue.length = 0; cleanup(); cancel('STREAM_TIMEOUT'); res.destroy();
    rejectDone(new ApiError(408, 'STREAM_TIMEOUT', 'The quote stream exceeded its delivery deadline.', true));
  };
  const drain = () => new Promise((resolve, reject) => {
    const cleanupDrain = () => { clearTimeout(timer); res.off('drain', drained); res.off('close', failed); res.off('error', failed); };
    const drained = () => { cleanupDrain(); resolve(); };
    const failed = () => { cleanupDrain(); reject(new ApiError(499, 'CANCELLED', 'The request was cancelled.')); };
    const timer = setTimeout(() => { cleanupDrain(); reject(new ApiError(408, 'STREAM_BACKPRESSURE', 'The quote stream reader is too slow.', true)); }, limits.drainMs);
    res.once('drain', drained); res.once('close', failed); res.once('error', failed);
    if (res.destroyed) failed();
  });
  const pump = async () => {
    if (pumping || closed) return;
    pumping = true;
    try {
      while (queue.length && !closed) {
        if (clock() >= deadline) { expired(); return; }
        const raw = queue.shift(); written++; writtenBytes += raw.length;
        if (!res.write(raw)) await drain();
      }
      if (!closed && clock() >= deadline) { expired(); return; }
      if (terminal && !closed) { closed = true; cleanup(); res.end(); resolveDone(); }
    } catch (error) {
      if (!closed) { closed = true; queue.length = 0; cleanup(); cancel(error.code ?? 'stream_failed'); res.destroy(); rejectDone(error); }
    } finally { pumping = false; }
  };
  const encode = (type, extra) => Buffer.from(JSON.stringify({ ...common, type, sequence: sequence++,
    provisional: type !== 'COMPLETE', comparisonComplete: type === 'COMPLETE' && extra.quote.comparisonComplete === true, ...extra }) + '\n');
  const error = value => {
    if (terminal || closed) return;
    terminal = true; cancel(value.code); queue.length = 0; sequence = written;
    const raw = encode('ERROR', { error: { code: value.code, message: value.message, retryable: value.retryable === true,
      ...(value.retryAfterMs ? { retryAfterMs: value.retryAfterMs } : {}) } });
    if (writtenBytes + raw.length > limits.totalBytes || raw.length > limits.lineBytes) { res.destroy(); disconnected(); return; }
    queue.push(raw);
    void pump();
  };
  const emit = (type, extra = {}) => {
    if (terminal || closed) return false;
    if (clock() >= deadline) { expired(); return false; }
    let raw;
    try { raw = encode(type, extra); }
    catch { error(new ApiError(503, 'INVALID_ENGINE_RESULT', 'The route comparison is unavailable.', true)); return false; }
    if (type === 'CANDIDATE' && ++candidates > limits.candidates || raw.length > limits.lineBytes ||
        bytes + raw.length > limits.totalBytes - (type === 'COMPLETE' ? 0 : 16384) || queue.length >= limits.queuedEvents) {
      // The rejected event has not been published; retain contiguous wire sequence.
      sequence--; error(new ApiError(503, 'STREAM_LIMIT', 'The quote stream capacity was exceeded.', true)); return false;
    }
    bytes += raw.length; queue.push(raw); terminal = type === 'COMPLETE'; void pump(); return true;
  };
  res.on('close', disconnected); res.on('error', disconnected);
  lifetime = setTimeout(expired, lifetimeMs);
  res.writeHead(200, { ...baseHeaders, ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
  res.flushHeaders(); emit('START');
  return { candidate: value => emit('CANDIDATE', { candidate: value }), complete: value => emit('COMPLETE', { quote: value }), error, done };
}
export async function readBody(req, timeoutMs) {
  const length = single(req, 'content-length');
  if (single(req, 'transfer-encoding') !== undefined || single(req, 'content-type') !== 'application/json' ||
      typeof length !== 'string' || !/^[1-9][0-9]{0,4}$/.test(length) || Number(length) > 8192)
    fault(400, 'INVALID_BODY', 'Send a JSON request of at most 8192 bytes.');
  const raw = await new Promise((resolve, reject) => {
    let bytes = 0, done = false; const chunks = [];
    const cleanup = () => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', failed); };
    const finish = (error, value) => { if (done) return; done = true; cleanup(); if (error) { req.resume(); reject(error); } else resolve(value); };
    const failed = () => finish(new ApiError(400, 'INVALID_BODY', 'The request body is incomplete.'));
    const data = chunk => { bytes += chunk.length; if (bytes > Number(length)) failed(); else chunks.push(chunk); };
    const end = () => bytes === Number(length) ? finish(null, Buffer.concat(chunks)) : failed();
    const timer = setTimeout(() => finish(new ApiError(408, 'BODY_TIMEOUT', 'The request body timed out.', true)), timeoutMs);
    req.on('data', data); req.once('end', end); req.once('error', failed); req.once('aborted', failed);
  });
  try {
    return parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch { fault(400, 'INVALID_BODY', 'The request body must be valid JSON.'); }
}
const quoteFields = ['source', 'destination', 'amount', 'sender', 'recipient', 'slippageBps', 'objective',
  'maxOutputShortfallBps', 'maxFeeBps', 'maxPriceImpactBps', 'routeScope'];
export function validateBody(path, value) {
  const fields = path === '/v1/executions/inspect' ? ['source', 'destination', 'amount', 'sender', 'recipient', 'slippageBps'] : ['/v1/quotes', '/v1/quotes/stream'].includes(path) ? quoteFields : path === '/v1/assets/balance' ? ['chainId','address','owner'] : path === '/v1/assets/resolve' ? ['chainId', 'address'] : ['quoteId', 'candidateId'];
  if (Object.keys(value).some(key => !fields.includes(key))) fault(400, 'INVALID_REQUEST', 'Unexpected request fields.');
  if (path === '/v1/executions/prepare' && (typeof value.quoteId !== 'string' || !value.quoteId ||
    Object.hasOwn(value, 'candidateId') && (typeof value.candidateId !== 'string' || !value.candidateId)))
    fault(400, 'INVALID_REQUEST', 'Use a quote snapshot ID and optional candidate ID.');
  if (['/v1/quotes', '/v1/quotes/stream'].includes(path) || path === '/v1/executions/inspect') {
    for (const field of ['source', 'destination']) {
      const asset = value[field];
      if (!asset || Object.getPrototypeOf(asset) !== Object.prototype || Object.keys(asset).length !== 3 ||
          !['chainId', 'address', 'decimals'].every(key => Object.hasOwn(asset, key))) fault(400, 'INVALID_ASSET', 'Use an exact chain, address and decimals for each asset.');
    }
    if (typeof value.sender !== 'string' || !value.sender || typeof value.recipient !== 'string' || !value.recipient)
      fault(400, 'WALLETS_REQUIRED', 'Quote requests require explicit sender and recipient addresses.');
  }
}
