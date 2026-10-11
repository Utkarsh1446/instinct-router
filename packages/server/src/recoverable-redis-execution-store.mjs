import { ExecutionStoreError, copyExecutionValue } from './execution-store.mjs';
import { createRedisExecutionStore } from './redis-execution-store.mjs';

/** Keeps warm serverless handlers usable after an ambiguous transport failure.
 * The failing operation is never retried. Only a future call opens a fresh
 * adapter over the same durable journal; all claims and CAS checks still apply.
 */
export async function createRecoverableRedisExecutionStore(options = {}) {
  let current = Promise.resolve(await createRedisExecutionStore(options)), closed = false;
  const snapshot = value => copyExecutionValue(value, options.maxRecordBytes ?? 262144);
  const live = () => { if (closed) throw new ExecutionStoreError('EXECUTION_STORE_CLOSED'); };
  const invoke = async (method, args) => {
    live();
    if (!current) current = createRedisExecutionStore(options);
    const selected = current;
    try {
      const store = await selected; live();
      return await store[method](...args);
    } catch (error) {
      if (['EXECUTION_STORE_WRITE_UNCERTAIN', 'EXECUTION_STORE_POISONED'].includes(error?.code) && current === selected) {
        current = null;
        // This adapter owns no server resources or locks. Closing it cannot
        // remove shared Redis state or release a wallet reservation.
        selected.then(store => store.close()).catch(() => {});
      }
      throw error;
    }
  };
  return Object.freeze({
    async insert(value) { live(); return invoke('insert', [snapshot(value)]); },
    get(id) { return invoke('get', [id]); },
    findActive(ownerId) { return invoke('findActive', [ownerId]); },
    async compareAndSwap(id, revision, value) { live(); return invoke('compareAndSwap', [id, revision, snapshot(value)]); },
    async close() { closed = true; const selected = current; current = null; if (selected) await (await selected).close(); },
  });
}
