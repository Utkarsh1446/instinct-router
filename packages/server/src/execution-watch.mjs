import { performance } from 'node:perf_hooks';
import { ApiError, fault } from './security.mjs';
import { baseHeaders } from './io.mjs';

export const executionWatchLimits = Object.freeze({ lifetimeMs: 120000, intervalMs: 250,
  lineBytes: 262144, totalBytes: 8388608, events: 1024, queuedEvents: 8, drainMs: 1000 });

// Watching cannot multiply receipt checks for the same wallet/execution. These
// connection slots are independent from (and each check still uses) work quotas.
export function createExecutionWatchPool(maxConcurrent = 8) {
  const active = new Set(), apps = new Map();
  return {
    acquire(app, wallet, id) {
      const key = JSON.stringify([app.id, wallet.ownerId, id]), count = apps.get(app.id) ?? 0;
      if (active.has(key) || active.size >= maxConcurrent || count >= app.maxConcurrent)
        fault(429, 'EXECUTION_WATCH_BUSY', 'A trade status connection is already active or capacity is full.', true, 1000);
      active.add(key); apps.set(app.id, count + 1); let released = false;
      return () => { if (released) return; released = true; active.delete(key);
        const remaining = apps.get(app.id) - 1; if (remaining) apps.set(app.id, remaining); else apps.delete(app.id); };
    },
  };
}

export function watchDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort);
      reject(new ApiError(499, 'CANCELLED', 'Trade status checking stopped.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
}

/** Read-only observation loop. Never claims, signs, submits or retries a trade. */
export async function watchExecution({ refresh, update, signal, authenticate = () => {},
  clock = () => performance.now(), sleep = watchDelay, lifetimeMs = executionWatchLimits.lifetimeMs,
  intervalMs = executionWatchLimits.intervalMs }) {
  const deadline = clock() + lifetimeMs;
  let transientFailures = 0;
  while (!signal.aborted && clock() < deadline) {
    await authenticate(); const started = clock(); let result;
    try { result = await refresh(signal); transientFailures = 0; }
    catch (error) {
      // Reads alone can retry. Binding/semantic/authentication errors never do.
      if (signal.aborted || error?.retryable !== true ||
          !['EXECUTION_UNAVAILABLE', 'QUOTE_TIMEOUT', 'ROUTER_BUSY'].includes(error.code) || ++transientFailures > 3) throw error;
      await sleep(Math.min(250 * 2 ** transientFailures, Math.max(0, deadline - clock())), signal); continue;
    }
    if (signal.aborted) break;
    await authenticate(); // A session that expired during the proof cannot receive it.
    await update(result);
    if (['COMPLETE', 'FAILED'].includes(result.execution.status)) return 'SETTLED';
    if (!['SUBMITTED', 'RECOVERY_REQUIRED'].includes(result.execution.status)) return 'STATE_CHANGED';
    if (clock() >= deadline) break;
    // No stacked browser delay or overlapping RPC batches. Yield even when a
    // proof is slower than the target cadence so other requests remain fair.
    await sleep(Math.min(Math.max(25, intervalMs - (clock() - started)), deadline - clock()), signal);
  }
  return 'TIMEOUT';
}

/** Bounded authenticated NDJSON writer. Every observation is flushed now. */
export function createExecutionStream(res, { origin, requestId, appId, executionId, cancel,
  now = Date.now, clock = () => performance.now(), limits = executionWatchLimits }) {
  const common = { apiVersion: '1', requestId, appId, executionId };
  const deadline = clock() + limits.lifetimeMs;
  let sequence = 0, bytes = 0, pumping = false, terminal = false, closed = false;
  let resolveDone, rejectDone, lifetime;
  const queue = [], done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  done.catch(() => {});
  const cleanup = () => { clearTimeout(lifetime); res.off('close', disconnected); res.off('error', disconnected); };
  const fail = error => {
    if (closed) return;
    closed = true; queue.length = 0; cleanup(); cancel(error.code); res.destroy(); rejectDone(error);
  };
  const disconnected = () => fail(new ApiError(499, 'CANCELLED', 'Trade status connection closed.'));
  const drain = () => new Promise((resolve, reject) => {
    const cleanupDrain = () => { clearTimeout(timer); res.off('drain', drained); res.off('close', failed); res.off('error', failed); };
    const drained = () => { cleanupDrain(); resolve(); };
    const failed = () => { cleanupDrain(); reject(new ApiError(499, 'CANCELLED', 'Trade status connection closed.')); };
    const timer = setTimeout(() => { cleanupDrain(); reject(new ApiError(408, 'STREAM_BACKPRESSURE', 'Trade status reader is too slow.', true)); }, limits.drainMs);
    res.once('drain', drained); res.once('close', failed); res.once('error', failed); if (res.destroyed) failed();
  });
  const pump = async () => {
    if (pumping || closed) return;
    pumping = true;
    try {
      while (queue.length && !closed) {
        const raw = queue.shift();
        if (!res.write(raw)) await drain();
      }
      if (terminal && !closed) { closed = true; cleanup(); res.end(); resolveDone(); }
    } catch (error) { fail(error); }
    finally { pumping = false; }
  };
  const emit = (type, extra = {}) => {
    if (terminal || closed) return false;
    if (clock() >= deadline + (['END', 'ERROR'].includes(type) ? limits.drainMs : 0)) { fail(new ApiError(408, 'STREAM_TIMEOUT', 'Trade status connection reached its deadline.', true)); return false; }
    let raw;
    try { raw = Buffer.from(JSON.stringify({ ...common, type, sequence, sentAtMs: now(), ...extra }) + '\n'); }
    catch { fail(new ApiError(503, 'INVALID_ENGINE_RESULT', 'Trade status is unavailable.', true)); return false; }
    if (sequence >= limits.events || raw.length > limits.lineBytes || bytes + raw.length > limits.totalBytes || queue.length >= limits.queuedEvents) {
      fail(new ApiError(503, 'STREAM_LIMIT', 'Trade status connection capacity exceeded.', true)); return false;
    }
    sequence++; bytes += raw.length; queue.push(raw); terminal = ['END', 'ERROR'].includes(type); void pump(); return true;
  };
  res.on('close', disconnected); res.on('error', disconnected);
  // Leave one drain budget for the final END when the observation loop times out.
  lifetime = setTimeout(() => fail(new ApiError(408, 'STREAM_TIMEOUT', 'Trade status connection reached its deadline.', true)), limits.lifetimeMs + limits.drainMs);
  res.writeHead(200, { ...baseHeaders, ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
  res.flushHeaders(); emit('START');
  return {
    update: value => emit('UPDATE', { execution: value.execution, receiptStatus: value.receiptStatus,
      ...(value.progress ? { progress: value.progress } : {}) }),
    end: reason => emit('END', { reason }),
    error: error => emit('ERROR', { error: { code: error.code, message: error.message, retryable: error.retryable === true,
      ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) } }),
    done,
  };
}
