/** Checks a saved submission only. Wallet signing, claiming and broadcasting are outside this interface. */
export async function pollSettlement({ resume, onUpdate = () => {}, onStatus = () => {}, hasProgress = () => false, signal,
  durationMs = 120000, intervalMs = 1000, now = () => performance.now(), sleep = defaultSleep }) {
  if (typeof resume !== 'function' || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 120000 ||
    !Number.isFinite(intervalMs) || intervalMs < 1000) throw new TypeError('Invalid settlement polling options.');
  const started = now(), deadline = started + durationMs;
  let errors = 0, delay = intervalMs;
  while (!signal?.aborted && now() < deadline) {
    const checkStarted = now();
    onStatus('WAITING', {elapsedMs:Math.max(0,checkStarted-started)});
    try {
      // Deliberately await completion before scheduling another check.
      const record = await resume();
      if (signal?.aborted) return { reason: 'STOPPED' };
      errors = 0; delay = intervalMs;
      onUpdate(record, {elapsedMs:Math.max(0,now()-started)});
      if (record?.status === 'COMPLETE' || record?.status === 'FAILED') return { reason: record.status, record };
      if (record?.status !== 'SUBMITTED' && !(record?.status === 'RECOVERY_REQUIRED' && hasProgress(record) === true)) return { reason: 'USER_ACTION_REQUIRED', record };
    } catch (error) {
      if (signal?.aborted) return { reason: 'STOPPED' };
      if (!['RATE_LIMITED','ROUTER_BUSY','EXECUTION_BUSY','WALLET_AUTH_BUSY'].includes(error?.code) || ++errors > 3)
        return { reason: 'ERROR', error };
      // Bounded retries of read-only status checks; never retry signing or submission.
      const retryAfter = Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0 ? error.retryAfterMs : 0;
      delay = Math.min(10000, Math.max(intervalMs * 2 ** errors, Math.min(retryAfter,10000)));
      onStatus('BACKOFF', {elapsedMs:Math.max(0,now()-started)});
    }
    if (now() >= deadline) break;
    await sleep(Math.min(Math.max(250, delay-(now()-checkStarted)), deadline-now()), signal);
  }
  return { reason: signal?.aborted ? 'STOPPED' : 'TIMEOUT' };
}
function defaultSleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    let timer;
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    timer = setTimeout(finish, ms); signal?.addEventListener('abort', finish, {once:true});
  });
}
