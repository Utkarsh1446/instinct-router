/** A provider that ignores cancellation keeps its slot until it really stops.
 * Callers still receive a bounded result; repeated requests cannot grow work. */
export class QuoteFault extends Error {
  code: string;
  retryable: boolean;
  constructor(code: string, retryable = true) { super(code); this.code = code; this.retryable = retryable; }
}

export interface SchedulerOptions {
  maxConcurrency?: number;
  failureThreshold?: number;
  circuitCooldownMs?: number;
  maxQueued?: number;
}

interface Health { failures: number; openUntil: number; epoch: number; probeEpoch: number | null }
interface Ticket { start: () => void; cancel: () => void }

export class QuoteScheduler {
  private active = 0;
  private queue: Ticket[] = [];
  private health = new Map<string, Health>();
  private options: Required<SchedulerOptions>;

  constructor(options: SchedulerOptions = {}) {
    this.options = { maxConcurrency: 4, failureThreshold: 3,
      circuitCooldownMs: 15_000, maxQueued: 64, ...options };
    for (const [key, value] of Object.entries(this.options)) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000_000)
        throw new QuoteFault(`INVALID_${key}`, false);
    }
    if (this.options.maxConcurrency > 64 || this.options.maxQueued > 512)
      throw new QuoteFault('INVALID_WORKLOAD_BOUND', false);
  }

  async schedule<T>(key: string, operation: (signal: AbortSignal) => Promise<T>,
    options: { deadlineMs: number; timeoutMs: number; signal?: AbortSignal }): Promise<T> {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(key) || !Number.isSafeInteger(options.deadlineMs) ||
      !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
      throw new QuoteFault('INVALID_SCHEDULE', false);
    const remaining = Math.min(options.timeoutMs, options.deadlineMs - Date.now());
    const cutoff = Date.now() + remaining;
    if (remaining <= 0) throw new QuoteFault('QUOTE_DEADLINE');
    if (options.signal?.aborted) throw new QuoteFault('CANCELLED', false);
    if (this.queue.length >= this.options.maxQueued) throw new QuoteFault('QUOTE_CAPACITY');
    let state = this.health.get(key);
    if (!state) {
      if (this.health.size >= 512) throw new QuoteFault('HEALTH_CAPACITY', false);
      state = { failures: 0, openUntil: 0, epoch: 0, probeEpoch: null };
      this.health.set(key, state);
    }
    if (state.openUntil > Date.now() || state.probeEpoch !== null) throw new QuoteFault('CIRCUIT_OPEN');
    const probe = state.openUntil !== 0;
    if (probe) state.probeEpoch = ++state.epoch;
    const epoch = state.epoch;
    const health = state;
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let finished = false;
      let started = false;
      const finish = (error?: unknown, value?: T) => {
        if (finished) return;
        if (!error && Date.now() >= cutoff) error = new QuoteFault('QUOTE_TIMEOUT');
        finished = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancelled);
        this.queue = this.queue.filter(item => item !== ticket);
        if (error) {
          if (started && health.epoch === epoch && (!(error instanceof QuoteFault) || error.retryable)) {
            health.failures++;
            if (probe || health.failures >= this.options.failureThreshold) {
              health.openUntil = Date.now() + this.options.circuitCooldownMs;
              health.epoch++;
            }
          }
          reject(error);
        } else {
          if (health.epoch === epoch) { health.failures = 0; health.openUntil = 0; }
          resolve(value as T);
        }
        // Keep a timed-out half-open probe reserved until its transport settles.
        if (!started && probe && health.probeEpoch === epoch) health.probeEpoch = null;
      };
      const cancelled = () => {
        finish(new QuoteFault('CANCELLED', false));
        controller.abort();
      };
      const ticket: Ticket = {
        cancel: cancelled,
        start: () => {
          if (finished) return;
          if (Date.now() >= cutoff) { finish(new QuoteFault('QUOTE_DEADLINE')); return; }
          if (health.openUntil > Date.now() || health.epoch !== epoch) { finish(new QuoteFault('CIRCUIT_OPEN')); return; }
          started = true;
          this.active++;
          Promise.resolve().then(() => {
            if (controller.signal.aborted) throw new QuoteFault('CANCELLED', false);
            return operation(controller.signal);
          }).then(
            value => finish(undefined, value), error => finish(error),
          ).finally(() => {
            if (probe && health.probeEpoch === epoch) health.probeEpoch = null;
            this.active--;
            this.drain();
          });
        },
      };
      const timer = setTimeout(() => {
        finish(new QuoteFault('QUOTE_TIMEOUT'));
        controller.abort();
      }, remaining);
      options.signal?.addEventListener('abort', cancelled, { once: true });
      this.queue.push(ticket);
      this.drain();
    });
  }

  private drain() {
    while (this.active < this.options.maxConcurrency && this.queue.length)
      this.queue.shift()!.start();
  }

  snapshot() {
    return { active: this.active, queued: this.queue.length,
      providers: [...this.health.entries()].map(([key, value]) => ({ key, failures: value.failures,
        openUntil: value.openUntil, probing: value.probeEpoch !== null })) };
  }
}

/** Only slow-changing discovery data belongs here. Firm quotes are never cached. */
export interface MetadataCacheOptions {
  loadTimeoutMs?: number;
  maxPending?: number;
  maxWaiters?: number;
  clock?: () => number;
}
interface MetadataWork<T> {
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}
export class MetadataCache<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();
  private pending = new Map<string, MetadataWork<T>>();
  private ttlMs: number;
  private maxEntries: number;
  private options: Required<MetadataCacheOptions>;
  constructor(ttlMs = 30_000, maxEntries = 128, options: MetadataCacheOptions = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 ||
      !Number.isSafeInteger(maxEntries) || maxEntries <= 0 || maxEntries > 4096)
      throw new QuoteFault('INVALID_CACHE', false);
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.options = { loadTimeoutMs: 10000, maxPending: maxEntries, maxWaiters: 128, clock: Date.now, ...options };
    for (const name of ['loadTimeoutMs', 'maxPending', 'maxWaiters'] as const) {
      const value = this.options[name];
      if (!Number.isSafeInteger(value) || value < 1 || value > (name === 'loadTimeoutMs' ? 30000 : 4096))
        throw new QuoteFault('INVALID_CACHE', false);
    }
    if (typeof this.options.clock !== 'function') throw new QuoteFault('INVALID_CACHE', false);
  }
  async get(key: string, load: (signal: AbortSignal) => Promise<T>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const timeout = options.timeoutMs ?? this.options.loadTimeoutMs;
    if (typeof key !== 'string' || key.length > 8192 || typeof load !== 'function' || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000)
      throw new QuoteFault('INVALID_CACHE_REQUEST', false);
    if (options.signal?.aborted) throw new QuoteFault('CANCELLED', false);
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.options.clock()) return structuredClone(cached.value);
    this.entries.delete(key);
    let work = this.pending.get(key);
    if (!work) {
      if (this.pending.size >= this.options.maxPending) throw new QuoteFault('METADATA_CAPACITY', false);
      const controller = new AbortController();
      const cutoff = performance.now() + this.options.loadTimeoutMs;
      const loading: MetadataWork<T> = { controller, waiters: 0, settled: false, promise: undefined! };
      let rejectAbort!: (reason: unknown) => void;
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const onAbort = () => rejectAbort(new QuoteFault(controller.signal.reason === 'timeout' ? 'METADATA_TIMEOUT' : 'CANCELLED', false));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort('timeout'), this.options.loadTimeoutMs);
      const actual = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new QuoteFault('CANCELLED', false);
        return load(controller.signal);
      }).then(value => {
        if (controller.signal.aborted || performance.now() >= cutoff) throw new QuoteFault('METADATA_TIMEOUT', false);
        while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
        this.entries.set(key, { value: structuredClone(value), expiresAt: this.options.clock() + this.ttlMs });
        return value;
      }).finally(() => {
        // An ignored abort retains its pending slot until the actual transport ends.
        loading.settled = true; clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort);
        controller.abort('settled');
        if (this.pending.get(key) === loading) this.pending.delete(key);
      });
      loading.promise = Promise.race([actual, aborted]); loading.promise.catch(() => {});
      work = loading;
      this.pending.set(key, work);
    }
    if (work.waiters >= this.options.maxWaiters) throw new QuoteFault('METADATA_CAPACITY', false);
    work.waiters++;
    const shared = work;
    let subscribed = true;
    const release = () => {
      if (!subscribed) return;
      subscribed = false;
      if (--shared.waiters === 0 && !shared.settled) shared.controller.abort('no-waiters');
    };
    let rejectWait!: (reason: unknown) => void;
    const stopped = new Promise<never>((_resolve, reject) => { rejectWait = reject; });
    const cancelled = () => { release(); rejectWait(new QuoteFault('CANCELLED', false)); };
    options.signal?.addEventListener('abort', cancelled, { once: true });
    if (options.signal?.aborted) cancelled();
    const cutoff = performance.now() + timeout;
    const timer = setTimeout(() => { release(); rejectWait(new QuoteFault('METADATA_TIMEOUT', false)); }, timeout);
    try {
      const result = await Promise.race([shared.promise, stopped]);
      if (options.signal?.aborted) throw new QuoteFault('CANCELLED', false);
      if (performance.now() >= cutoff) throw new QuoteFault('METADATA_TIMEOUT', false);
      return structuredClone(result);
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', cancelled);
      release();
    }
  }
  clear() {
    this.entries.clear();
    for (const work of this.pending.values()) work.controller.abort('cleared');
  }
}
