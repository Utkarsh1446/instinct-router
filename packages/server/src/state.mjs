import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ApiError, fault, requestFingerprint } from './security.mjs';

/** Ephemeral quote snapshots and RFQ coalescing. This stores no financial state. */
export function createState({ now, maxConcurrent, globalRateLimitPerMinute, quoteTimeoutMs, maxSnapshots, maxIdempotencyEntries }) {
  const recent = () => ({ rows: [], offset: 0 });
  const snapshots = new Map(), replays = new Map(), apps = new Map(), globalRecent = recent();
  let globalActive = 0;
  const tenant = app => {
    if (!apps.has(app.id)) apps.set(app.id, { active: 0, recent: recent() });
    return apps.get(app.id);
  };
  const trim = (queue, stamp) => {
    while (queue.offset < queue.rows.length && queue.rows[queue.offset] <= stamp - 60000) queue.offset++;
    // Amortized queue removal keeps large configured rate windows off the hot path.
    if (queue.offset > 1024 && queue.offset * 2 >= queue.rows.length) {
      queue.rows = queue.rows.slice(queue.offset); queue.offset = 0;
    }
  };
  const size = queue => queue.rows.length - queue.offset;
  const boundedSet = (map, key, value, limit, removableRow = row => !row.pending) => {
    while (map.size >= limit) {
      let removable;
      for (const entry of map) if (removableRow(entry[1])) {
        removable = entry; break;
      }
      if (!removable) fault(429, 'ROUTER_BUSY', 'The quote request capacity is full.', true, 1000);
      map.delete(removable[0]);
    }
    map.set(key, value);
  };
  const owned = (app, quoteId) => {
    const row = snapshots.get(quoteId);
    if (!row || row.appId !== app.id) fault(404, 'QUOTE_NOT_FOUND', 'Quote snapshot not found.');
    if (row.expiresAt <= now()) fault(410, 'QUOTE_EXPIRED', 'This quote snapshot has expired. Request a new quote.');
    return structuredClone(row.value);
  };
  return {
    owned,
    rate(app) {
      const stamp = now(), row = tenant(app); trim(row.recent, stamp); trim(globalRecent, stamp);
      const appFull = size(row.recent) >= app.rateLimit, globalFull = size(globalRecent) >= globalRateLimitPerMinute;
      if (appFull || globalFull) {
        const wait = queue => Math.max(1, queue.rows[queue.offset] + 60000 - stamp);
        fault(429, 'RATE_LIMITED', 'The app request limit has been reached.', true,
          Math.max(appFull ? wait(row.recent) : 1, globalFull ? wait(globalRecent) : 1));
      }
      row.recent.rows.push(stamp); globalRecent.rows.push(stamp);
    },
    work(app, body, key, invoke, requestId, quote) {
      const fingerprint = requestFingerprint(body), replayKey = key ? app.id + ':' + key : null;
      if (replayKey && replays.has(replayKey)) {
        const row = replays.get(replayKey);
        if (row.fingerprint !== fingerprint) fault(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key belongs to a different request.');
        if (!row.pending && row.expiresAt <= now()) fault(409, 'IDEMPOTENCY_EXPIRED', 'Use a new idempotency key for a fresh quote.');
        return row;
      }
      const appState = tenant(app);
      if (globalActive >= maxConcurrent || appState.active >= app.maxConcurrent)
        fault(429, 'ROUTER_BUSY', 'A quote is already running for this app. Try again shortly.', true, 1000);
      const controller = new AbortController();
      const work = { fingerprint, controller, subscribers: 0, pending: true, expiresAt: Infinity };
      // Preserve every live replay guarantee. Only expired completed entries may be
      // forgotten under capacity pressure; keys have no durable lifetime guarantee.
      if (replayKey) boundedSet(replays, replayKey, work, maxIdempotencyEntries,
        row => !row.pending && row.expiresAt <= now());
      globalActive++; appState.active++;
      let abortReject;
      const aborted = new Promise((_resolve, reject) => { abortReject = reject; });
      const abort = () => abortReject(new ApiError(controller.signal.reason === 'timeout' ? 504 : 499,
        controller.signal.reason === 'timeout' ? 'QUOTE_TIMEOUT' : 'CANCELLED', 'The request did not complete.', true));
      controller.signal.addEventListener('abort', abort, { once: true });
      const monotonicDeadline = performance.now() + quoteTimeoutMs;
      const timer = setTimeout(() => controller.abort('timeout'), quoteTimeoutMs);
      const actual = Promise.resolve().then(() => invoke(controller.signal)).then(result => {
        // Timers can be delayed by event-loop work; arrival still has a hard deadline.
        if (!controller.signal.aborted && performance.now() >= monotonicDeadline) controller.abort('timeout');
        if (controller.signal.aborted) throw new ApiError(499, 'CANCELLED', 'The request was cancelled.', true);
        if (!result || typeof result !== 'object' || Array.isArray(result)) fault(503, 'INVALID_ENGINE_RESULT', 'The route comparison is unavailable.', true);
        const value = structuredClone(result);
        if (typeof value.requestId === 'string') value.providerRequestId = value.requestId;
        Object.assign(value, { apiVersion: '1', requestId, appId: app.id });
        if (quote) {
          value.quoteId = 'q_' + randomUUID(); value.request = structuredClone(body); value.requestHash = fingerprint;
          value.readOnly = true; value.execution = { enabled: false, reason: value.execution?.reason ?? 'Wallet execution is not configured.' };
          value.snapshotExpiresAtMs = Math.min(Number.isSafeInteger(value.validUntilMs) ? value.validUntilMs : now() + 15000, now() + 300000);
          boundedSet(snapshots, value.quoteId, { appId: app.id, value: structuredClone(value), expiresAt: value.snapshotExpiresAtMs }, maxSnapshots);
          work.expiresAt = value.snapshotExpiresAtMs;
        }
        return value;
      }).finally(() => {
        // Actual transport settlement, not the HTTP timeout, releases capacity.
        globalActive--; appState.active--; clearTimeout(timer); controller.signal.removeEventListener('abort', abort);
      });
      work.promise = Promise.race([actual, aborted]).then(value => { work.pending = false; return value; }, error => {
        work.pending = false;
        if (replayKey && replays.get(replayKey) === work) replays.delete(replayKey);
        throw error;
      });
      work.promise.catch(() => {});
      return work;
    },
  };
}
export async function subscribe(work, res) {
  work.subscribers++;
  let rejectClose;
  const closed = new Promise((_resolve, reject) => { rejectClose = reject; });
  const close = () => { if (!res.writableEnded) rejectClose(new ApiError(499, 'CANCELLED', 'The request was cancelled.')); };
  res.once('close', close);
  try { return structuredClone(await Promise.race([work.promise, closed])); }
  finally {
    res.off('close', close); work.subscribers--;
    if (work.pending && !work.subscribers) work.controller.abort('disconnected');
  }
}
