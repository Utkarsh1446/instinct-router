import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetadataCache, QuoteScheduler, QuoteFault } from '../dist/scheduler.js';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test('hung transport cannot delay caller or increase actual concurrency', async () => {
  const scheduler = new QuoteScheduler({ maxConcurrency: 1 });
  let stop!: () => void;
  const hung = scheduler.schedule('hung', () => new Promise<void>(resolve => { stop = resolve; }),
    { deadlineMs: Date.now() + 500, timeoutMs: 25 });
  await assert.rejects(hung, /QUOTE_TIMEOUT/);
  let invoked = false;
  await assert.rejects(scheduler.schedule('next', async () => { invoked = true; },
    { deadlineMs: Date.now() + 500, timeoutMs: 20 }), /QUOTE_TIMEOUT/);
  assert.equal(invoked, false);
  assert.equal(scheduler.snapshot().active, 1);
  stop();
  await wait(1);
  assert.equal(scheduler.snapshot().active, 0);
});
test('requests overlap with bounded concurrency', async () => {
  const scheduler = new QuoteScheduler({ maxConcurrency: 2 });
  let active = 0, peak = 0;
  const release: (() => void)[] = [], entered: (() => void)[] = [];
  const started = [0, 1, 2, 3].map(n => new Promise<void>(resolve => { entered[n] = resolve; }));
  const work = [0, 1, 2, 3].map(n => scheduler.schedule(`p${n}`, async () => {
    peak = Math.max(peak, ++active); entered[n]!();
    await new Promise<void>(resolve => { release[n] = resolve; }); active--; return n;
  }, { deadlineMs: Date.now() + 5000, timeoutMs: 5000 }));
  // Prove concurrency by holding transports, rather than racing a 100ms timer
  // against the complete suite and TypeScript compiler on a busy machine.
  await Promise.all(started.slice(0, 2));
  assert.equal(scheduler.snapshot().active, 2); assert.equal(scheduler.snapshot().queued, 2);
  release[0]!(); await started[2]; release[1]!(); await started[3];
  release[2]!(); release[3]!();
  const values = await Promise.all(work);
  assert.equal(peak, 2);
  assert.deepEqual(values, [0, 1, 2, 3]);
});
test('failing provider circuit permits one recovery probe after cooldown', async () => {
  const scheduler = new QuoteScheduler({ failureThreshold: 1, circuitCooldownMs: 15 });
  const opts = () => ({ deadlineMs: Date.now() + 500, timeoutMs: 100 });
  await assert.rejects(scheduler.schedule('p', async () => { throw new Error('network'); }, opts()));
  await assert.rejects(scheduler.schedule('p', async () => 1, opts()), /CIRCUIT_OPEN/);
  await wait(20);
  const probe = scheduler.schedule('p', async () => { await wait(10); return 1; }, opts());
  await assert.rejects(scheduler.schedule('p', async () => 2, opts()), /CIRCUIT_OPEN/);
  assert.equal(await probe, 1);
});
test('cancellation removes queued work without invoking it', async () => {
  const scheduler = new QuoteScheduler({ maxConcurrency: 1 });
  const first = scheduler.schedule('p1', async () => wait(20), { deadlineMs: Date.now() + 500, timeoutMs: 100 });
  const controller = new AbortController();
  let invoked = false;
  const second = scheduler.schedule('p2', async () => { invoked = true; },
    { deadlineMs: Date.now() + 500, timeoutMs: 100, signal: controller.signal });
  controller.abort();
  await assert.rejects(second, /CANCELLED/); await first;
  assert.equal(invoked, false); assert.equal(scheduler.snapshot().queued, 0);
});
test('metadata single-flight clones values and never caches failed loads', async () => {
  const cache = new MetadataCache<{ names: string[] }>();
  let loads = 0;
  const load = async () => { loads++; await wait(5); return { names: ['Base'] }; };
  const [a, b] = await Promise.all([cache.get('catalog', load), cache.get('catalog', load)]);
  a.names.push('poison'); assert.deepEqual(b.names, ['Base']); assert.equal(loads, 1);
  assert.deepEqual((await cache.get('catalog', load)).names, ['Base']);
  await assert.rejects(cache.get('error', async () => { throw new Error('failed'); }));
  assert.deepEqual(await cache.get('error', load), { names: ['Base'] });
  assert.equal(loads, 2);
});
test('late microtask results cannot bypass deadlines or start expired queued work', async t => {
  const scheduler = new QuoteScheduler({ maxConcurrency: 1 });
  let finish!: () => void, nextInvoked = false;
  const first = scheduler.schedule('p1', () => new Promise<void>(resolve => { finish = resolve; }),
    { deadlineMs: Date.now() + 500, timeoutMs: 500 });
  await Promise.resolve();
  const queued = scheduler.schedule('p2', async () => { nextInvoked = true; },
    { deadlineMs: Date.now() + 500, timeoutMs: 500 });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); t.mock.timers.tick(1000); finish();
  await assert.rejects(first, /QUOTE_TIMEOUT/); await assert.rejects(queued, /QUOTE_DEADLINE/);
  assert.equal(nextInvoked, false);
});
test('immediate cancellation prevents even an already-drained deferred transport from starting', async () => {
  const scheduler = new QuoteScheduler(); const controller = new AbortController(); let called = false;
  const work = scheduler.schedule('p', async () => { called = true; },
    { deadlineMs: Date.now() + 500, timeoutMs: 100, signal: controller.signal });
  controller.abort(); await assert.rejects(work, /CANCELLED/); await Promise.resolve(); assert.equal(called, false);
  assert.throws(() => new QuoteScheduler({ maxConcurrency: 1000 }), /WORKLOAD_BOUND/);
});

test('old work cannot release a new recovery probe or erase a newer open circuit', async t => {
  for (const success of [true, false]) {
    const scheduler = new QuoteScheduler({ failureThreshold: 1, circuitCooldownMs: 15, maxConcurrency: 4 });
    let oldResolve!: () => void, oldReject!: (error: unknown) => void, probeResolve!: () => void;
    const options = () => ({ deadlineMs: Date.now() + 1000, timeoutMs: 500 });
    const old = scheduler.schedule('provider', () => new Promise<void>((resolve, reject) => { oldResolve = resolve; oldReject = reject; }), options());
    old.catch(() => {});
    await assert.rejects(scheduler.schedule('provider', async () => { throw new Error('network failure'); }, options()));
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); t.mock.timers.tick(20);
    const probe = scheduler.schedule('provider', () => new Promise<void>(resolve => { probeResolve = resolve; }), options());
    await Promise.resolve();
    if (success) { oldResolve(); await old; }
    else { oldReject(new QuoteFault('ASSET_UNSUPPORTED', false)); await assert.rejects(old); }
    await Promise.resolve();
    assert.equal(scheduler.snapshot().providers[0]!.probing, true);
    assert.ok(scheduler.snapshot().providers[0]!.openUntil > 0);
    let duplicate = false;
    await assert.rejects(scheduler.schedule('provider', async () => { duplicate = true; }, options()), /CIRCUIT_OPEN/);
    assert.equal(duplicate, false);
    probeResolve(); await probe; await Promise.resolve();
    assert.equal(await scheduler.schedule('provider', async () => 'recovered', options()), 'recovered');
    t.mock.timers.reset();
  }
});

test('metadata subscribers share one transport but cancel independently and receive isolated clones', async () => {
  const cache = new MetadataCache<{ values: string[] }>();
  let calls = 0, complete!: (value: { values: string[] }) => void, shared!: AbortSignal;
  const load = (signal: AbortSignal) => { calls++; shared = signal; return new Promise<{ values: string[] }>(resolve => { complete = resolve; }); };
  const first = new AbortController();
  const a = cache.get('catalog', load, { signal: first.signal });
  const b = cache.get('catalog', load);
  await Promise.resolve(); first.abort(); await assert.rejects(a, /CANCELLED/);
  assert.equal(shared.aborted, false);
  complete({ values: ['SOL'] });
  const result = await b; result.values.push('mutated');
  assert.deepEqual(await cache.get('catalog', load), { values: ['SOL'] }); assert.equal(calls, 1);
});

test('metadata timeout releases callers but retains uncooperative transport capacity and discards late results', async () => {
  const cache = new MetadataCache<number>(1000, 2, { maxPending: 1, loadTimeoutMs: 20 });
  let finish!: (value: number) => void, signal!: AbortSignal;
  const hung = cache.get('hung', current => { signal = current; return new Promise<number>(resolve => { finish = resolve; }); });
  await assert.rejects(hung, /METADATA_TIMEOUT/); assert.equal(signal.aborted, true);
  let newCalls = 0;
  await assert.rejects(cache.get('another', async () => { newCalls++; return 2; }), /METADATA_CAPACITY/);
  assert.equal(newCalls, 0); finish(999); await wait(0);
  assert.equal(await cache.get('hung', async () => 1), 1);
});

test('last metadata waiter cancellation prevents deferred fetch, and clearing cannot repopulate old data', async () => {
  const cache = new MetadataCache<number>(); const controller = new AbortController(); let calls = 0;
  const cancelled = cache.get('early', async () => { calls++; return 1; }, { signal: controller.signal });
  controller.abort(); await assert.rejects(cancelled, /CANCELLED/); await wait(0);
  assert.equal(calls, 0);
  let finish!: (value: number) => void;
  const pending = cache.get('clear', () => new Promise<number>(resolve => { finish = resolve; }));
  await Promise.resolve(); cache.clear(); await assert.rejects(pending, /CANCELLED/);
  finish(999); await wait(0);
  assert.equal(await cache.get('clear', async () => 2), 2);
});
