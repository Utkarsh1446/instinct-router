/** Trusted read transport. A fallback starts a complete new preflight, never merges evidence. */
import { BASE_V3 } from '@instinct/router-core';
import { BaseReadinessError, baseExecutionPrimitives as p } from './base-readiness.mjs';
import { ExecutionEngineError, fail } from './base-execution-checks.mjs';
export const TRANSIENT_READ_CODES = new Set(['READINESS_RPC_TRANSPORT_UNAVAILABLE', 'READINESS_RPC_BUSY', 'READINESS_RPC_HISTORY_UNAVAILABLE']);
const MAX_BODY = 262144;
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const unavailable = code => { throw new BaseReadinessError(code); };
const busy = row => plain(row.error) && Number.isSafeInteger(row.error.code) &&
  [-32005, -32007, -32016, -32603].includes(row.error.code) && typeof row.error.message === 'string' &&
  /rate.?limit|too many requests|exceeded request limit|server busy|temporarily unavailable/i.test(row.error.message);
// Publicnode serves recent transaction metadata but gates receipts separately.
// Only a receipt-only request can classify this known infrastructure failure;
// mixed results must reach their semantic checks and cannot be discarded here.
const receiptHistoryUnavailable = (rows, batch) => batch.length === 1 && rows.length === 1 &&
  batch[0].method === 'eth_getTransactionReceipt' && Array.isArray(batch[0].params) && batch[0].params.length === 1 &&
  typeof batch[0].params[0] === 'string' && /^0x[0-9a-fA-F]{64}$/.test(batch[0].params[0]) &&
  plain(rows[0].error) && Object.keys(rows[0].error).length === 2 && rows[0].error.code === -32602 &&
  rows[0].error.message === 'Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode';
async function bodyText(response, signal) {
  const size = response.headers.get('content-length');
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_BODY) || !response.body?.getReader) unavailable('READINESS_INVALID_RPC');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, chunks = 0, text = '';
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) unavailable('READINESS_CANCELLED');
      const part = await reader.read(); if (signal.aborted) unavailable('READINESS_CANCELLED'); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY || ++chunks > 4096) unavailable('READINESS_INVALID_RPC');
      try { text += decoder.decode(part.value, { stream: true }); } catch { unavailable('READINESS_INVALID_RPC'); }
      if (chunks % 64 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    try { return text + decoder.decode(); } catch { unavailable('READINESS_INVALID_RPC'); }
  } catch (error) { if (error instanceof BaseReadinessError) throw error; unavailable('READINESS_RPC_TRANSPORT_UNAVAILABLE'); }
  finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}
function retryableBatch(rows, batch) {
  if (!Array.isArray(rows) || rows.length !== batch.length) unavailable('READINESS_INVALID_RPC');
  const ids = new Set();
  for (const row of rows) {
    if (!plain(row) || row.jsonrpc !== '2.0' || !batch.some(call => call.id === row.id) || ids.has(row.id) ||
      Object.hasOwn(row, 'result') === Object.hasOwn(row, 'error')) unavailable('READINESS_INVALID_RPC');
    if (Object.hasOwn(row, 'error') && (!plain(row.error) || !Number.isSafeInteger(row.error.code) ||
      typeof row.error.message !== 'string' || row.error.message.length > 512)) unavailable('READINESS_INVALID_RPC');
    ids.add(row.id);
  }
  // Mixed successful/semantic values and busy errors never authorize retry or fallback.
  return rows.length > 0 && rows.every(row => Object.hasOwn(row, 'error') && busy(row));
}
export function createBaseExecutionTransport(wire, endpoints, { monotonic = () => performance.now() } = {}) {
  if (typeof monotonic !== 'function') fail('INVALID_EXECUTION_CONFIG');
  if (endpoints === undefined) endpoints = ['https://base.drpc.org', BASE_V3.rpc];
  if (!Array.isArray(endpoints) || !endpoints.length || endpoints.length > 3 || new Set(endpoints).size !== endpoints.length)
    fail('INVALID_EXECUTION_CONFIG');
  endpoints = endpoints.map(endpoint => {
    let url; try { url = new URL(endpoint); } catch { fail('INVALID_EXECUTION_CONFIG'); }
    if (typeof endpoint !== 'string' || endpoint.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.hash)
      fail('INVALID_EXECUTION_CONFIG');
    return url.href;
  });
  if (new Set(endpoints).size !== endpoints.length) fail('INVALID_EXECUTION_CONFIG');
  let active = 0, actualRequests = 0;
  const queued = [];
  const releaseRequest = () => {
    actualRequests--;
    while (queued.length && actualRequests < 6) {
      const next = queued.shift(); next.signal.removeEventListener('abort', next.cancel);
      if (next.signal.aborted) { next.reject(new BaseReadinessError('READINESS_CANCELLED')); continue; }
      actualRequests++; next.resolve(releaseRequest);
    }
  };
  const acquireRequest = async signal => {
    if (signal.aborted) unavailable('READINESS_CANCELLED');
    if (actualRequests < 6) { actualRequests++; return releaseRequest; }
    if (queued.length >= 24) fail('EXECUTION_BUSY');
    return new Promise((resolve, reject) => {
      const entry = { signal, resolve, reject, cancel: () => {
        const index = queued.indexOf(entry); if (index >= 0) queued.splice(index, 1);
        reject(new BaseReadinessError('READINESS_CANCELLED'));
      } };
      signal.addEventListener('abort', entry.cancel, { once: true }); queued.push(entry);
    });
  };
  const transports = endpoints.map(endpoint => async (url, init) => {
    if (url !== BASE_V3.rpc || init.method !== 'POST' || active >= 4) fail(active >= 4 ? 'EXECUTION_BUSY' : 'INVALID_EXECUTION_CONFIG');
    const batch = p.strictJson(init.body); active++;
    try {
      const chunks = Array.from({ length: Math.ceil(batch.length / 3) }, (_, index) => batch.slice(index * 3, index * 3 + 3));
      const chunkResults = new Array(chunks.length), errors = [];
      let nextChunk = 0, stopped = false;
      const readChunk = async chunk => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const release = await acquireRequest(init.signal);
          let rows, retry;
          try {
            if (init.signal.aborted) unavailable('READINESS_CANCELLED');
            let response;
            try { response = await wire(endpoint, { ...init, body: JSON.stringify(chunk) }); }
            catch { if (init.signal.aborted) unavailable('READINESS_CANCELLED'); unavailable('READINESS_RPC_TRANSPORT_UNAVAILABLE'); }
            if (response.redirected || response.url && response.url !== endpoint) {
              void response.body?.cancel().catch(() => {}); unavailable('READINESS_INVALID_RPC');
            }
            if (!response.ok) {
              void response.body?.cancel().catch(() => {});
              if ([403, 408, 429, 500, 502, 503, 504].includes(response.status)) unavailable('READINESS_RPC_TRANSPORT_UNAVAILABLE');
              unavailable('READINESS_RPC_UNAVAILABLE');
            }
            rows = p.strictJson(await bodyText(response, init.signal)); retry = retryableBatch(rows, chunk);
            if (receiptHistoryUnavailable(rows, batch)) unavailable('READINESS_RPC_HISTORY_UNAVAILABLE');
          } finally { release(); }
          if (!retry || attempt === 1) return rows;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      };
      const worker = async () => {
        while (!stopped && nextChunk < chunks.length) {
          const index = nextChunk++;
          try { chunkResults[index] = await readChunk(chunks[index]); }
          catch (error) { stopped = true; errors.push(error); }
        }
      };
      // No failure decision or alternate can race any outstanding transport.
      await Promise.allSettled(Array.from({ length: Math.min(3, chunks.length) }, worker));
      const combined = chunkResults.filter(Boolean).flat();
      if (errors.length) {
        const semantic = errors.find(error => !TRANSIENT_READ_CODES.has(error?.code));
        if (semantic) throw semantic;
        if (combined.length) unavailable('READINESS_RPC_UNAVAILABLE');
        throw errors[0];
      }
      if (retryableBatch(combined, batch)) unavailable('READINESS_RPC_BUSY');
      return new Response(JSON.stringify(combined), { headers: { 'content-type': 'application/json' } });
    } finally { active--; }
  });
  return { transports, async run(operation, signal = new AbortController().signal, { timeoutMs = 8000 } = {}) {
    if (typeof operation !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 11000)
      fail('INVALID_EXECUTION_CONFIG');
    if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function') fail('INVALID_EXECUTION_INPUT');
    if (signal.aborted) fail('EXECUTION_CANCELLED');
    const started = monotonic(); if (!Number.isFinite(started) || started < 0) fail('INVALID_EXECUTION_CONFIG');
    const cutoff = started + timeoutMs;
    const controller = new AbortController(); let rejectBound;
    const bound = new Promise((_, reject) => { rejectBound = reject; });
    const stop = code => { controller.abort(); rejectBound(new ExecutionEngineError(code)); };
    const cancel = () => stop('EXECUTION_CANCELLED');
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => stop('EXECUTION_TIMEOUT'), timeoutMs);
    const work = async () => {
      for (let index = 0; index < transports.length; index++) {
        if (controller.signal.aborted || monotonic() >= cutoff) fail(signal.aborted ? 'EXECUTION_CANCELLED' : 'EXECUTION_TIMEOUT');
        try {
          const value = await operation(index, controller.signal);
          if (controller.signal.aborted || monotonic() >= cutoff) fail(signal.aborted ? 'EXECUTION_CANCELLED' : 'EXECUTION_TIMEOUT');
          return value;
        } catch (error) {
          if (controller.signal.aborted || monotonic() >= cutoff) fail(signal.aborted ? 'EXECUTION_CANCELLED' : 'EXECUTION_TIMEOUT');
          if (!TRANSIENT_READ_CODES.has(error?.code) || index === transports.length - 1) throw error;
        }
      }
      throw new ExecutionEngineError('EXECUTION_EVIDENCE_UNAVAILABLE');
    };
    // Caller completion is bounded even when a wire ignores abort. Its actual
    // request leases remain held until settlement; aborted work cannot fail over.
    try { return await Promise.race([work(), bound]); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
  } };
}
