export { createWalletAuthentication, createMemoryWalletAuthStore, createRedisWalletAuthStore } from './wallet-auth.mjs';
export { createRedisPublicRateLimit } from './public-rate-limit.mjs';
export { createFileExecutionStore, ExecutionStoreError } from './execution-store.mjs';
export { createRedisExecutionStore } from './redis-execution-store.mjs';
export { createRecoverableRedisExecutionStore } from './recoverable-redis-execution-store.mjs';
export { createRedisRestCommand } from './redis-rest.mjs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ServiceError } from '@instinct/router-engine';
import { ApiError, createAuthentication, fault, single } from './security.mjs';
import { createQuoteStream, readBody, send, streamLimits, validateBody } from './io.mjs';
import { createState, subscribe } from './state.mjs';
import { createWalletAuthentication } from './wallet-auth.mjs';
import { createExecutionApi, executionError } from './execution-api.mjs';
import { createExecutionWatchPool, createExecutionStream, watchExecution, executionWatchLimits } from './execution-watch.mjs';

const postPaths = ['/v1/quotes', '/v1/quotes/stream', '/v1/assets/resolve', '/v1/assets/balance', '/v1/executions/prepare', '/v1/executions/inspect', '/v1/wallets/challenge', '/v1/wallets/verify'];
const getPaths = ['/v1/config', '/v1/capabilities', '/v1/executions/active'];
const snapshotPath = /^\/v1\/quotes\/(q_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const executionPath = /^\/v1\/executions\/(ex_[0-9a-f-]{36})(?:\/(claim|submit|uncertain|refresh|cancel|watch))?$/;
const engineMessages = {
  BALANCE_UNAVAILABLE: 'Public balance could not be verified. Try again shortly.', BALANCE_UNSUPPORTED_CHAIN: 'Public balance reads are not configured for this network.', INVALID_BALANCE_REQUEST: 'Provide an exact chain, token address and owner address.',
  TOKEN_DECIMALS_MISMATCH: 'Token decimals do not match verified metadata. Resolve the token before quoting.',
  IDENTICAL_ASSETS: 'Choose a different destination token.', TOKEN_NOT_FOUND: 'The token mint was not found.',
  TOKEN_NOT_MINT: 'This address is not a supported token mint.', TOKEN_METADATA_UNAVAILABLE: 'Token details could not be verified.',
};
function publicError(error) {
  if (error instanceof ApiError) return error;
  if (error instanceof ServiceError && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code)) {
    const status = [400, 404, 409, 422, 429, 499, 503, 504].includes(error.status) ? error.status : 503;
    return new ApiError(status, error.code, engineMessages[error.code] ?? (status < 500 ? 'Check the request details.' : 'The routing service is unavailable.'), status >= 500 || status === 429);
  }
  return new ApiError(503, 'ROUTER_UNAVAILABLE', 'The routing service is unavailable.', true);
}

export function createRouterHandler({ service, apps, now = Date.now, maxConcurrent = 8, globalRateLimitPerMinute = 120,
  quoteTimeoutMs = 12000, bodyTimeoutMs = 3000, maxSnapshots = 1000, maxIdempotencyEntries = 1000, execution, balances, walletAuthentication, walletAuthStore, rateLimit } = {}) {
  if (!service || ['config', 'quote', 'resolveAsset'].some(name => typeof service[name] !== 'function')) throw new Error('A router engine service is required.');
  if (typeof now !== 'function') throw new Error('A router API clock is required.');
  for (const [value, max] of [[maxConcurrent, 64], [globalRateLimitPerMinute, 100000], [quoteTimeoutMs, 30000],
    [bodyTimeoutMs, 10000], [maxSnapshots, 10000], [maxIdempotencyEntries, 10000]])
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('Invalid router API limits.');
  const auth = createAuthentication(apps);
  const state = createState({ now, maxConcurrent, globalRateLimitPerMinute, quoteTimeoutMs, maxSnapshots, maxIdempotencyEntries });
  const wallets = walletAuthentication ?? createWalletAuthentication({ now, store: walletAuthStore });
  if (['challenge', 'verify', 'authenticate'].some(method => typeof wallets[method] !== 'function') || rateLimit !== undefined && typeof rateLimit !== 'function') throw new Error('Invalid router authentication or rate limiter.');
  const executions = execution ? createExecutionApi(execution) : null;
  const watches = createExecutionWatchPool(maxConcurrent);
  let bodyReaders = 0;
  const appBodyReaders = new Map();
  return async (req, res) => {
    const requestId = 'req_' + randomUUID(); let responseOrigin;
    res.setHeader('X-Request-ID', requestId);
    try {
      single(req, 'host'); single(req, 'origin'); single(req, 'authorization'); single(req, 'x-router-app-key'); single(req, 'x-router-wallet-token');
      const path = req.url;
      const matched = snapshotPath.exec(path), executionMatch = executionPath.exec(path);
      const known = getPaths.includes(path) || postPaths.includes(path) || !!matched || !!executionMatch;
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { apiVersion: '1', requestId, status: 'ok' });
      if (!known || path.includes('?')) fault(404, 'NOT_FOUND', 'This API resource does not exist.');
      if (req.method === 'OPTIONS') {
        const origin = single(req, 'origin'), method = single(req, 'access-control-request-method');
        const requested = single(req, 'access-control-request-headers');
        const fields = typeof requested === 'string' ? requested.toLowerCase().split(',').map(value => value.trim()) : [];
        if (!auth.originKnown(origin) || !['GET', 'POST'].includes(method) || !fields.includes('x-router-app-key') ||
          fields.some(value => !['x-router-app-key', 'content-type', 'idempotency-key', 'x-router-wallet-token'].includes(value)) || new Set(fields).size !== fields.length ||
          method === 'GET' && !(getPaths.includes(path) || matched || executionMatch && !executionMatch[2]) || method === 'POST' && !(postPaths.includes(path) || executionMatch?.[2]))
          fault(403, 'PREFLIGHT_NOT_ALLOWED', 'This browser request is not allowed.');
        return send(res, 204, undefined, origin, { 'Access-Control-Allow-Methods': method,
          'Access-Control-Allow-Headers': fields.join(', '), 'Access-Control-Max-Age': '60' });
      }
      const { app, origin } = auth.authenticate(req); responseOrigin = origin;
      if (rateLimit) await rateLimit({ req, app, origin, path });
      else state.rate(app);
      const key = single(req, 'idempotency-key');
      if (key !== undefined && (path !== '/v1/quotes' || req.method !== 'POST' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)))
        fault(400, 'INVALID_IDEMPOTENCY_KEY', 'Use a bounded idempotency key only for quote requests.');
      if (req.method === 'GET' && path === '/v1/executions/active') {
        if (!executions) fault(501, 'EXECUTION_ADAPTER_UNAVAILABLE', 'Wallet execution is not configured.');
        const wallet = await wallets.authenticate(req, app, origin);
        const work = state.work(app, {}, undefined, signal => executions.active(wallet,signal).catch(error=>{throw executionError(error);}), requestId, false);
        return send(res, 200, await subscribe(work, res), origin);
      }
      if (req.method === 'GET' && executionMatch && !executionMatch[2]) {
        if (!executions) fault(501, 'EXECUTION_ADAPTER_UNAVAILABLE', 'Wallet execution is not configured.');
        const wallet = await wallets.authenticate(req, app, origin);
        const work = state.work(app, {}, undefined, signal => executions.get(executionMatch[1], wallet,signal).catch(error=>{throw executionError(error);}), requestId, false);
        return send(res, 200, await subscribe(work, res), origin);
      }
      if (req.method === 'GET' && matched) return send(res, 200, state.owned(app, matched[1]), origin);
      if (req.method === 'GET' && getPaths.includes(path)) {
        const config = structuredClone(service.config());
        let executionCapabilities = { walletExecution: false, supportedRoutes: [] };
        if (executions && typeof execution.engine.capabilities === 'function') executionCapabilities = structuredClone(execution.engine.capabilities());
        const enabled = executionCapabilities.walletExecution === true && execution?.engine.recipes.length > 0 &&
          (executionCapabilities.supportedRoutes?.length > 0 || executionCapabilities.executionProfiles?.length > 0);
        config.execution = { enabled, signing: 'USER_WALLET_ONLY', broadcastsTransactions: false, reason: enabled ? null : config.execution?.reason ?? 'Wallet execution is not configured.', supportedRoutes: enabled ? executionCapabilities.supportedRoutes ?? [] : [], blockedRoutes: executionCapabilities.blockedRoutes ?? [],
          ...(executionCapabilities.executionProfiles ? {executionProfiles: enabled ? executionCapabilities.executionProfiles : []} : {}) };
        config.capabilities = { ...config.capabilities, walletExecution: enabled };
        const value = path === '/v1/config' ? config : { assetClasses: config.assetClasses, providers: config.providers,
          capabilities: { ...config.capabilities, pricing: true, walletExecution: enabled },
          execution: config.execution, readOnly: !enabled };
        return send(res, 200, { ...value, apiVersion: '1', requestId, appId: app.id }, origin);
      }
      if (req.method !== 'POST' || !(postPaths.includes(path) || executionMatch?.[2])) fault(405, 'METHOD_NOT_ALLOWED', 'This API method is not allowed.');
      const appReaders = appBodyReaders.get(app.id) ?? 0;
      if (bodyReaders >= maxConcurrent * 2 || appReaders >= app.maxConcurrent)
        fault(429, 'ROUTER_BUSY', 'The request body capacity is full.', true, 1000);
      bodyReaders++; appBodyReaders.set(app.id, appReaders + 1);
      let input;
      try { input = await readBody(req, bodyTimeoutMs); }
      finally { bodyReaders--; appBodyReaders.set(app.id, appBodyReaders.get(app.id) - 1); }
      if (res.destroyed) return;
      if (path === '/v1/wallets/challenge') return send(res, 200, { ...await wallets.challenge(app, origin, input), apiVersion: '1', requestId, appId: app.id }, origin);
      if (path === '/v1/wallets/verify') {
        const work = state.work(app, input, undefined, () => wallets.verify(app, origin, input), requestId, false);
        return send(res, 200, await subscribe(work, res), origin);
      }
      if (executionMatch?.[2]) {
        if (!executions) fault(501, 'EXECUTION_ADAPTER_UNAVAILABLE', 'Wallet execution is not configured.');
        const wallet = await wallets.authenticate(req, app, origin);
        if (executionMatch[2] === 'watch') {
          if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).length)
            fault(400, 'INVALID_REQUEST', 'Use an empty trade status request.');
          const id = executionMatch[1], release = watches.acquire(app, wallet, id);
          const controller = new AbortController(); let stream;
          const authenticate = () => wallets.authenticate(req, app, origin);
          try {
            // Ownership is established before any stream headers or status data.
            const initial = state.work(app, {}, undefined, signal => executions.get(id, wallet,signal).catch(error=>{throw executionError(error);}), requestId, false);
            await subscribe(initial, res);
            if (res.destroyed) return;
            await authenticate();
            stream = createExecutionStream(res, { origin, requestId, appId: app.id, executionId: id, now,
              cancel: reason => controller.abort(reason) });
            const reason = await watchExecution({ signal: controller.signal, authenticate,
              // Reserve time to flush END; the writer has its own absolute cap.
              lifetimeMs: executionWatchLimits.lifetimeMs - executionWatchLimits.drainMs,
              update: value => { if (!stream.update(value)) controller.abort('stream_closed'); },
              refresh: async signal => {
                const work = state.work(app, {}, undefined,
                  checkSignal => executions.mutate(id, 'refresh', {}, wallet, checkSignal).catch(error => { throw executionError(error); }), requestId, false);
                const abort = () => work.controller.abort(signal.reason);
                signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
                try { return await work.promise; }
                finally { signal.removeEventListener('abort', abort); }
              } });
            if (!controller.signal.aborted) stream.end(reason);
          } catch (error) {
            if (!stream) throw error;
            if (!controller.signal.aborted) stream.error(executionError(error));
          } finally {
            if (stream) await stream.done.catch(() => {});
            controller.abort('watch_finished'); release();
          }
          return;
        }
        const work = state.work(app, input, undefined, signal => executions.mutate(executionMatch[1], executionMatch[2], input, wallet, signal).catch(error => { throw executionError(error); }), requestId, false);
        return send(res, 200, await subscribe(work, res), origin);
      }
      if (path !== '/v1/executions/prepare' || !executions) validateBody(path, input);
      if (path === '/v1/executions/prepare' && executions) {
        const wallet = await wallets.authenticate(req, app, origin);
        if (Object.hasOwn(input, 'quoteId')) fault(409, 'EXECUTION_SNAPSHOT_UNSUPPORTED', 'Prepare fresh fixed terms and review them before signing.');
        const terms = input;
        const { nativeFeeBudgets, ...quoteInput } = input;
        if (!Array.isArray(nativeFeeBudgets) || !nativeFeeBudgets.length || nativeFeeBudgets.length > 8 || nativeFeeBudgets.some(budget =>
          !budget || typeof budget !== 'object' || Array.isArray(budget) || Object.keys(budget).length !== 2 ||
          typeof budget.chainId !== 'string' || budget.maxAmountRaw !== null &&
            (typeof budget.maxAmountRaw !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(budget.maxAmountRaw))))
          fault(400, 'NATIVE_BUDGET_REQUIRED', 'Provide a native gas limit or explicit null for automatic estimation on each paying chain.');
        validateBody('/v1/quotes', quoteInput);
        const work = state.work(app, terms, undefined, signal => executions.prepare(terms, wallet, signal).catch(error => { throw executionError(error); }), requestId, false);
        return send(res, 200, await subscribe(work, res), origin);
      }
      if (path === '/v1/executions/prepare') {
        if (Object.hasOwn(input, 'quoteId')) {
          if (typeof input.quoteId !== 'string') fault(400, 'INVALID_REQUEST', 'Use a quote snapshot ID.');
          const quote = state.owned(app, input.quoteId);
          if (Object.hasOwn(input, 'candidateId') && (!Array.isArray(quote.candidates) || !quote.candidates.some(candidate => candidate.id === input.candidateId)))
            fault(404, 'CANDIDATE_NOT_FOUND', 'Quote candidate not found.');
        }
        fault(501, 'EXECUTION_ADAPTER_UNAVAILABLE', 'Wallet execution is unavailable until reviewed execution adapters are connected.');
      }
      if(path==='/v1/assets/balance'){
        if(!balances||typeof balances.getAssetBalance!=='function')fault(501,'BALANCE_UNAVAILABLE','Public balance reads are not configured.');
        const work=state.work(app,input,undefined,signal=>balances.getAssetBalance(structuredClone(input),signal),requestId,false);
        return send(res,200,await subscribe(work,res),origin);
      }
      const isQuote = path === '/v1/quotes', isInspection = path === '/v1/executions/inspect';
      if (path === '/v1/quotes/stream') {
        let stream;
        const work = state.work(app, input, undefined, signal => service.quote(structuredClone(input), signal,
          candidate => { if (!signal.aborted) stream.candidate(candidate); }), requestId, true);
        stream = createQuoteStream(res, { origin, requestId, appId: app.id, request: input,
          cancel: reason => work.controller.abort(reason), lifetimeMs: quoteTimeoutMs + streamLimits.drainMs });
        try { stream.complete(await subscribe(work, res)); }
        catch (error) { stream.error(publicError(error)); }
        await stream.done.catch(() => {});
        return;
      }
      if (isInspection && typeof service.inspectExecution !== 'function') fault(501, 'INSPECTION_UNAVAILABLE', 'Execution inspection is not configured.');
      const work = state.work(app, input, key, signal => isQuote ? service.quote(structuredClone(input), signal) :
        isInspection ? service.inspectExecution(structuredClone(input), signal) : service.resolveAsset(structuredClone(input), signal), requestId, isQuote);
      return send(res, 200, await subscribe(work, res), origin);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const value = publicError(error);
      const extra = value.retryAfterMs ? { 'Retry-After': String(Math.ceil(value.retryAfterMs / 1000)) } : {};
      send(res, value.status, { apiVersion: '1', requestId, error: { code: value.code, message: value.message,
        retryable: value.retryable, ...(value.retryAfterMs ? { retryAfterMs: value.retryAfterMs } : {}) } }, responseOrigin, extra);
    }
  };
}

export function createRouterApi(options = {}) {
  const server = createServer({ maxHeaderSize: 8192 }, createRouterHandler(options));
  const bodyTimeoutMs = options.bodyTimeoutMs ?? 3000;
  server.requestTimeout = bodyTimeoutMs + 1000; server.headersTimeout = bodyTimeoutMs + 1000;
  server.keepAliveTimeout = 5000; server.maxConnections = 128;
  return server;
}
