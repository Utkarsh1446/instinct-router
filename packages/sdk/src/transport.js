import { executionMethods } from './execution-api.js';
import { walletToken as validateWalletToken } from './execution-validation.js';
import { RouterSdkError, invalid } from './errors.js';
import { parseJson } from './json.js';
import { readExecutionStream } from './execution-stream.js';
import { readQuoteStream } from './stream.js';
import { object, baseUrl, timeout, credential, identifier, assetRequest, balanceRequest, validateBalance, quoteRequest, inspectionRequest, validateInspection, prepareRequest, responseEnvelope, validateQuoteBinding, MAX_RESPONSE_BYTES } from './validation.js';

function cancelBody(body) {
  try { Promise.resolve(body?.cancel?.()).catch(() => {}); } catch { /* Cleanup must not expose transport errors. */ }
}
function checkAbort(signal, body) {
  if (signal.aborted) { cancelBody(body); throw new RouterSdkError('ABORTED', 'The router request was cancelled.'); }
}
async function readJson(response, signal, checkDeadline) {
  checkAbort(signal, response.body);
  const length = response.headers?.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) { cancelBody(response.body); throw new RouterSdkError('RESPONSE_TOO_LARGE', 'The router response exceeds 2 MiB.'); }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type') || '')) { cancelBody(response.body); throw new RouterSdkError('PROTOCOL_ERROR', 'The router did not return JSON.'); }
  if (typeof response.body?.getReader !== 'function') { cancelBody(response.body); throw new RouterSdkError('PROTOCOL_ERROR', 'The router fetch implementation must return a standard streaming Response.'); }
  const reader = response.body.getReader();
  if (!reader) { cancelBody(response.body); throw new RouterSdkError('PROTOCOL_ERROR', 'The router fetch implementation must return a standard streaming Response.'); }
  let text;
  if (reader) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0, chunks = 0, completed = false, cancelled = false;
    const parts = [];
    const cancel = () => { if (!cancelled) { cancelled = true; cancelBody(reader); } };
    const check = () => { checkDeadline(); if (signal.aborted) { cancel(); checkAbort(signal); } };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        check();
        const chunk = await reader.read();
        check();
        if (chunk.done) break;
        if (++chunks > 16384 || !(chunk.value instanceof Uint8Array)) throw new RouterSdkError('PROTOCOL_ERROR', 'The router returned an invalid or excessively fragmented response stream.');
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) { cancel(); throw new RouterSdkError('RESPONSE_TOO_LARGE', 'The router response exceeds 2 MiB.'); }
        parts.push(decoder.decode(chunk.value, { stream: true }));
        if (chunks % 128 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      parts.push(decoder.decode()); text = parts.join(''); completed = true;
    } finally {
      signal.removeEventListener('abort', cancel); if (!completed) cancel();
      try { reader.releaseLock(); } catch { /* Cleanup must not replace a bounded protocol error. */ }
    }
  }
  checkDeadline(); checkAbort(signal, response.body);
  const data = parseJson(text);
  checkDeadline(); checkAbort(signal, response.body);
  return data;
}

export function makeClient(options, mode) {
  const keyName = mode === 'server' ? 'serverKey' : 'publishableKey';
  object(options, ['baseUrl', keyName, 'fetch', 'timeoutMs'], ['baseUrl', keyName]);
  const origin = baseUrl(options.baseUrl), key = credential(options[keyName]);
  const wire = Object.hasOwn(options, 'fetch') && options.fetch !== undefined ? options.fetch : globalThis.fetch;
  if (typeof wire !== 'function') invalid('Provide a fetch implementation.');
  const defaultTimeout = timeout(Object.hasOwn(options, 'timeoutMs') ? options.timeoutMs : undefined);
  const redact = value => String(value).replaceAll(key, '[redacted]');
  async function request(path, method, payload, requestOptions = {}, kind) {
    object(requestOptions, kind === 'walletWatch' ? ['signal','timeoutMs','walletToken','onUpdate'] : kind === 'quoteStream' ? ['signal', 'timeoutMs', 'onCandidate'] : ['signal', 'timeoutMs', 'idempotencyKey', ...(kind === 'walletExecution' ? ['walletToken'] : [])]);
    const onCandidate = Object.hasOwn(requestOptions, 'onCandidate') ? requestOptions.onCandidate : undefined;
    if (onCandidate !== undefined && typeof onCandidate !== 'function') invalid('Invalid provisional quote callback.');
    const onUpdate = Object.hasOwn(requestOptions,'onUpdate') ? requestOptions.onUpdate : undefined;
    if (onUpdate !== undefined && typeof onUpdate !== 'function') invalid('Invalid execution update callback.');
    const session = Object.hasOwn(requestOptions, 'walletToken') ? validateWalletToken(requestOptions.walletToken) : undefined;
    if (['walletExecution','walletWatch'].includes(kind) && !session) invalid('A wallet ownership session is required.');
    const wait = kind === 'walletWatch' ? Object.hasOwn(requestOptions,'timeoutMs') && requestOptions.timeoutMs !== undefined ? requestOptions.timeoutMs : 123000 : Object.hasOwn(requestOptions, 'timeoutMs') && requestOptions.timeoutMs !== undefined ? timeout(requestOptions.timeoutMs) : defaultTimeout;
    if (kind === 'walletWatch' && (!Number.isSafeInteger(wait) || wait<1 || wait>123000)) invalid('Invalid execution stream timeout.');
    const signal = Object.hasOwn(requestOptions, 'signal') ? requestOptions.signal : undefined;
    const idempotencyKey = Object.hasOwn(requestOptions, 'idempotencyKey') ? requestOptions.idempotencyKey : undefined;
    if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) invalid('Invalid abort signal.');
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(idempotencyKey))) invalid('Invalid idempotency key.');
    if (idempotencyKey !== undefined && (method !== 'POST' || path !== '/v1/quotes')) invalid('Idempotency keys apply only to quote requests.');
    if (signal?.aborted) throw new RouterSdkError('ABORTED', 'The router request was cancelled.');
    const controller = new AbortController();
    let timedOut = false;
    const deadline = performance.now() + wait;
    const checkDeadline = () => { if (!controller.signal.aborted && performance.now() >= deadline) { timedOut = true; controller.abort(); } };
    const externalAbort = () => controller.abort();
    signal?.addEventListener('abort', externalAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, wait);
    let rejectAbort;
    const abortError = () => new RouterSdkError(timedOut ? 'TIMEOUT' : 'ABORTED', timedOut ? 'The router request timed out.' : 'The router request was cancelled.', { retryable: timedOut });
    const cancelled = new Promise((_, reject) => { rejectAbort = () => reject(abortError()); controller.signal.addEventListener('abort', rejectAbort, { once: true }); });
    const headers = { Accept: ['quoteStream','walletWatch'].includes(kind) ? 'application/x-ndjson' : 'application/json', ...(mode === 'server' ? { Authorization: `Bearer ${key}` } : { 'X-Router-App-Key': key }) };
    if (session) headers['X-Router-Wallet-Token'] = session;
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
    const remoteError = (error, requestId, status) => {
      if (error.code.includes(key) || session && error.code.includes(session)) return new RouterSdkError('PROTOCOL_ERROR', 'The router returned an invalid error code.');
      return new RouterSdkError(error.code, redact(error.message).replaceAll(session ?? '\u0000', '[redacted]'), { status, requestId: redact(requestId).replaceAll(session ?? '\u0000', '[redacted]'),
        retryable: error.retryable, retryAfterMs: error.retryAfterMs });
    };
    try {
      const result = await Promise.race([cancelled, (async () => {
        const response = await wire(`${origin}${path}`, { method, headers, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
          ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
        checkDeadline();
        if (controller.signal.aborted) { cancelBody(response?.body); throw abortError(); }
        if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599 || response.redirected ||
            response.url && response.url !== `${origin}${path}`) { cancelBody(response?.body); throw new RouterSdkError('PROTOCOL_ERROR', 'The router returned an invalid HTTP response.'); }
        let data;
        try { data = kind === 'walletWatch' && response.status >= 200 && response.status < 300
          ? await readExecutionStream(response,controller.signal,checkDeadline,decodeURIComponent(path.split('/')[3]),onUpdate,remoteError)
          : kind === 'quoteStream' && response.status >= 200 && response.status < 300
          ? await readQuoteStream(response, controller.signal, checkDeadline, payload, onCandidate, remoteError)
          : await readJson(response, controller.signal, checkDeadline); }
        catch (error) { if (error instanceof RouterSdkError) throw error; throw new RouterSdkError('PROTOCOL_ERROR', 'The router returned an invalid response body.'); }
        if (kind === 'walletWatch' && response.status >= 200 && response.status < 300) return data;
        responseEnvelope(data, response.status, kind === 'quoteStream' ? 'quote' : kind);
        if (response.status < 200 || response.status >= 300) throw remoteError(data.error, data.requestId, response.status);
        if (kind === 'quote' || kind === 'quoteStream') validateQuoteBinding(data, method === 'POST' ? payload : undefined,
          method === 'GET' ? path.slice('/v1/quotes/'.length) : undefined);
        if (kind === 'balance') validateBalance(data,payload);
        if (kind === 'inspect') validateInspection(data, payload);
        if (kind === 'asset') {
          let resolved;
          try { resolved = assetRequest({ chainId: data.chainId, address: data.address, decimals: data.decimals }, true); }
          catch { throw new RouterSdkError('PROTOCOL_ERROR', 'The router returned invalid token metadata.'); }
          if (resolved.chainId !== payload.chainId || resolved.address !== payload.address || data.metadataVerified !== true) throw new RouterSdkError('PROTOCOL_ERROR', 'The router returned token metadata for a different or unverified asset.');
        }
        checkDeadline(); if (controller.signal.aborted) throw abortError();
        return data;
      })()]);
      if (controller.signal.aborted) throw abortError();
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw abortError();
      if (error instanceof RouterSdkError) throw error;
      throw new RouterSdkError('NETWORK_ERROR', 'Unable to reach the router.', { retryable: true });
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', externalAbort);
      controller.signal.removeEventListener('abort', rejectAbort);
    }
  }
  return Object.freeze({
    getConfig: options => request('/v1/config', 'GET', undefined, options, 'config'),
    getCapabilities: options => request('/v1/capabilities', 'GET', undefined, options, 'capabilities'),
    getAssetBalance: async (input, options) => request('/v1/assets/balance', 'POST', balanceRequest(input), options, 'balance'),
    resolveAsset: async (asset, options) => request('/v1/assets/resolve', 'POST', assetRequest(asset), options, 'asset'),
    quote: async (input, options) => request('/v1/quotes', 'POST', quoteRequest(input), options, 'quote'),
    quoteStream: async (input, options) => request('/v1/quotes/stream', 'POST', quoteRequest(input), options, 'quoteStream'),
    getQuote: async (quoteId, options) => request(`/v1/quotes/${encodeURIComponent(identifier(quoteId, 'quote ID'))}`, 'GET', undefined, options, 'quote'),
    inspectExecution: async (input, options) => request('/v1/executions/inspect', 'POST', inspectionRequest(input), options, 'inspect'),
    ...executionMethods(request),
  });
}
