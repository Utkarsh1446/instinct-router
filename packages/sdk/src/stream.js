import { RouterSdkError } from './errors.js';
import { parseJson } from './json.js';
import { quoteRequest, responseEnvelope, validateCandidate, validateQuoteBinding, MAX_RESPONSE_BYTES } from './validation.js';

const MAX_LINE_BYTES = 262144, MAX_CANDIDATES = 128, MAX_EVENTS = 130;
const fail = () => { throw new RouterSdkError('PROTOCOL_ERROR', 'The router returned an invalid quote stream.'); };
function cancel(value) { try { Promise.resolve(value?.cancel?.()).catch(() => {}); } catch { /* Never expose cleanup failures. */ } }
function identity(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value); }
/** Object key order is not part of JSON identity; array order and all values are. */
function stable(value) {
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function candidateSnapshot(candidate) {
  const { eligible, ...rest } = candidate;
  return stable(rest); // Final ranking/expiry may change only eligibility.
}
async function callback(fn, candidate, metadata, signal) {
  if (!fn) return;
  if (signal.aborted) throw new RouterSdkError('ABORTED', 'The router request was cancelled.');
  let stop;
  const aborted = new Promise((_, reject) => {
    stop = () => reject(new RouterSdkError('ABORTED', 'The router request was cancelled.'));
    signal.addEventListener('abort', stop, { once: true });
  });
  try { await Promise.race([Promise.resolve().then(() => fn(structuredClone(candidate), Object.freeze(metadata))), aborted]); }
  catch (error) {
    if (signal.aborted) throw error;
    throw new RouterSdkError('CALLBACK_ERROR', 'The provisional quote callback failed.');
  } finally { signal.removeEventListener('abort', stop); }
}

/** Consume through clean EOF: COMPLETE is a snapshot, never early success or trade authorization. */
export async function readQuoteStream(response, signal, checkDeadline, request, onCandidate, remoteError) {
  const check = () => { checkDeadline(); if (signal.aborted) throw new RouterSdkError('ABORTED', 'The router request was cancelled.'); };
  check();
  const declared = response.headers?.get('content-length');
  if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    cancel(response.body); throw new RouterSdkError('RESPONSE_TOO_LARGE', 'The router quote stream exceeds its body limit.');
  }
  if (!/^application\/x-ndjson(?:\s*;|$)/i.test(response.headers?.get('content-type') || '') || typeof response.body?.getReader !== 'function') {
    cancel(response.body); throw new RouterSdkError('PROTOCOL_ERROR', 'The router did not return a standard NDJSON response stream.');
  }
  const reader = response.body.getReader();
  if (!reader || typeof reader.read !== 'function') { cancel(response.body); fail(); }
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const seen = new Map();
  let started, terminal, sequence = 0, bytes = 0, chunks = 0, buffer = '', completed = false, stopped = false;
  const stop = () => { if (!stopped) { stopped = true; cancel(reader); } };
  signal.addEventListener('abort', stop, { once: true });
  async function event(line) {
    check();
    if (terminal || sequence >= MAX_EVENTS) fail();
    const value = parseJson(line);
    const common = ['apiVersion', 'type', 'sequence', 'requestId', 'appId', 'request', 'provisional', 'comparisonComplete'];
    const extra = value?.type === 'CANDIDATE' ? ['candidate'] : value?.type === 'COMPLETE' ? ['quote'] : value?.type === 'ERROR' ? ['error'] : [];
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.apiVersion !== '1' ||
      value.sequence !== sequence || !identity(value.requestId) || !identity(value.appId) ||
      !['START', 'CANDIDATE', 'COMPLETE', 'ERROR'].includes(value.type) ||
      Object.keys(value).some(key => !common.concat(extra).includes(key)) || common.concat(extra).some(key => !Object.hasOwn(value, key))) fail();
    let snapshot;
    try { snapshot = quoteRequest(value.request); } catch { fail(); }
    if (stable(snapshot) !== stable(request)) fail();
    if (value.type === 'START') {
      if (sequence !== 0 || value.provisional !== true || value.comparisonComplete !== false) fail();
      started = { requestId: value.requestId, appId: value.appId };
    } else {
      if (!started || value.requestId !== started.requestId || value.appId !== started.appId) fail();
      if (value.type === 'COMPLETE') {
        if (value.provisional !== false || typeof value.comparisonComplete !== 'boolean') fail();
        responseEnvelope(value.quote, 200, 'quote'); validateQuoteBinding(value.quote, request);
        if (value.quote.requestId !== started.requestId || value.quote.appId !== started.appId ||
          value.quote.comparisonComplete !== value.comparisonComplete || value.quote.candidates.length !== seen.size ||
          typeof value.quote.requestHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.quote.requestHash) ||
          !Number.isSafeInteger(value.quote.snapshotExpiresAtMs) || value.quote.snapshotExpiresAtMs < 0 ||
          value.quote.snapshotExpiresAtMs > Date.now() + 300000 || value.quote.validUntilMs != null &&
          (!Number.isSafeInteger(value.quote.validUntilMs) || value.quote.snapshotExpiresAtMs > value.quote.validUntilMs)) fail();
        for (const candidate of value.quote.candidates) {
          if (!seen.has(candidate.id) || candidateSnapshot(candidate) !== seen.get(candidate.id)) fail();
        }
        terminal = { quote: value.quote };
      } else {
        if (value.provisional !== true || value.comparisonComplete !== false) fail();
        if (value.type === 'ERROR') {
          responseEnvelope({ apiVersion: value.apiVersion, requestId: value.requestId, error: value.error }, 500, 'quote');
          terminal = { error: value };
        } else {
          const candidate = validateCandidate(value.candidate);
          if (!identity(candidate.id) || seen.has(candidate.id) || seen.size >= MAX_CANDIDATES) fail();
          if (request.routeScope === 'INDEPENDENT' && (candidate.routingFamily !== 'INDEPENDENT' ||
            !Array.isArray(candidate.providers) || candidate.providers.some(provider => ['relay', 'aurora', 'debridge'].includes(provider)))) fail();
          seen.set(candidate.id, candidateSnapshot(candidate));
          await callback(onCandidate, candidate, { ...started, sequence, provisional: true,
            comparisonComplete: false, readOnly: true, executionReady: false }, signal);
          check();
        }
      }
    }
    sequence++;
  }
  try {
    while (true) {
      check(); const chunk = await reader.read(); check();
      if (chunk.done) break;
      if (++chunks > 16384 || !(chunk.value instanceof Uint8Array)) fail();
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new RouterSdkError('RESPONSE_TOO_LARGE', 'The router quote stream exceeds 2 MiB.');
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        if (new TextEncoder().encode(line).byteLength + 1 > MAX_LINE_BYTES) throw new RouterSdkError('RESPONSE_TOO_LARGE', 'A router quote stream event exceeds 256 KiB.');
        buffer = buffer.slice(newline + 1);
        await event(line.endsWith('\r') ? line.slice(0, -1) : line);
      }
      if (new TextEncoder().encode(buffer).byteLength > MAX_LINE_BYTES) throw new RouterSdkError('RESPONSE_TOO_LARGE', 'A router quote stream event exceeds 256 KiB.');
      if (chunks % 128 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    buffer += decoder.decode(); check();
    if (buffer.length || !terminal) fail(); // Every event must end in LF; EOF cannot truncate JSON or UTF8.
    completed = true;
    if (terminal.error) throw remoteError(terminal.error.error, terminal.error.requestId, response.status);
    const quote = terminal.quote, now = Date.now();
    const winner = quote.candidates.find(candidate => candidate.id === quote.winner);
    const deadlines = winner ? ['validUntilMs', 'deadlineMs'].filter(field => Object.hasOwn(winner, field)).map(field => winner[field]) : [];
    if (deadlines.some(value => !Number.isSafeInteger(value) || value < 0)) fail();
    if (quote.snapshotExpiresAtMs <= now || deadlines.some(value => value <= now))
      throw new RouterSdkError('QUOTE_EXPIRED', 'The quote snapshot expired while being received. Request a fresh comparison.');
    return quote;
  } catch (error) {
    if (error instanceof RouterSdkError) throw error;
    throw new RouterSdkError('PROTOCOL_ERROR', 'The router returned an invalid quote stream.');
  } finally {
    signal.removeEventListener('abort', stop); if (!completed) stop();
    try { reader.releaseLock(); } catch { /* A cleanup failure cannot replace protocol validation. */ }
  }
}
