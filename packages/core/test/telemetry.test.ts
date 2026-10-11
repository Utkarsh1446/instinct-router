import assert from 'node:assert/strict';
import test from 'node:test';
import { dollarBucket, TimingHistory, type NetworkSample } from '../dist/telemetry.js';
const sample = (id: string, ms = 100): NetworkSample => ({ measurementId: id, routeId: 'route-A',
  amountUsdMicros: 1_000_000n, outcome: 'SUCCESS', complete: true, measurement: 'MONOTONIC_NETWORK_INTERVAL',
  networkStartMs: 1000, networkEndMs: 1000 + ms, humanDelayed: false, debugDelayed: false, observationDelayed: false });
const cold = { protocolMs: 200, walletMs: 100, observationMs: 50, uncertaintyMs: 25 };
test('exact bucket boundaries isolate route and size observations', () => {
  assert.equal(dollarBucket(1_000_000n), 'USD_LE_1'); assert.equal(dollarBucket(1_000_001n), 'USD_LE_10');
  const h = new TimingHistory({ minimumSamples: 2 }); h.record(sample('a', 500)); h.record(sample('b', 500));
  assert.equal(h.estimate('route-A', 1_000_000n, cold).cold, false);
  assert.equal(h.estimate('route-A', 1_000_001n, cold).cold, true);
  assert.equal(h.estimate('route-B', 1_000_000n, cold).cold, true);
  assert.throws(() => dollarBucket(0n));
});
test('cold estimates are labeled; unknown wallet timing remains unknown', () => {
  const h = new TimingHistory(); assert.deepEqual(h.estimate('route-A', 1n, cold), {
    ...cold, completionMs: 375, basis: 'CONFIGURED', cleanSamples: 0, sampleP95Ms: null, ewmaP95Ms: null, cold: true });
  assert.equal(h.estimate('route-A', 1n, { ...cold, walletMs: null }).completionMs, null);
});
test('refunds, failures, partial or delayed observations never train speed', () => {
  const h = new TimingHistory();
  for (const change of [{ outcome: 'REFUND' }, { outcome: 'FAILED' }, { outcome: 'INCOMPLETE' }, { complete: false },
    { humanDelayed: true }, { debugDelayed: true }, { observationDelayed: true }, { measurement: 'WALL_CLOCK' }]) {
    assert.equal(h.record({ ...sample('bad'), ...change } as NetworkSample).accepted, false);
  }
  assert.equal(h.estimate('route-A', 1_000_000n, cold).cleanSamples, 0);
});
test('p95 EWMA is conservative and does not reduce configured protocol estimates', () => {
  const h = new TimingHistory({ minimumSamples: 2 }); h.record(sample('a', 100)); h.record(sample('b', 300));
  const out = h.estimate('route-A', 1_000_000n, cold);
  assert.equal(out.protocolMs, 300); assert.equal(out.sampleP95Ms, 300); assert.equal(out.uncertaintyMs, 200);
  assert.equal(out.completionMs, 650); assert.equal(out.basis, 'OBSERVED_CLEAN_NETWORK');
  assert.equal(h.estimate('route-A', 1_000_000n, { ...cold, protocolMs: 1000 }).protocolMs, 1000);
});
test('invalid intervals, duplicates and malformed explicit components are rejected', () => {
  const h = new TimingHistory(); assert.equal(h.record(sample('a')).accepted, true); assert.equal(h.record(sample('a')).reason, 'DUPLICATE_MEASUREMENT');
  for (const end of [NaN, Infinity, -1, 1000, 1000 + 86_400_001]) assert.equal(h.record({ ...sample('x'), networkEndMs: end }).accepted, false);
  assert.throws(() => h.estimate('route-A', 1n, { ...cold, uncertaintyMs: NaN }));
  assert.throws(() => new TimingHistory({ windowSize: 1 }));
});
test('bounded windows and keys never leak unbounded history', () => {
  const h = new TimingHistory({ windowSize: 8, minimumSamples: 2, maximumKeys: 1 });
  for (let i = 0; i < 12; i++) h.record(sample(String(i), 100 + i));
  assert.equal(h.estimate('route-A', 1_000_000n, cold).cleanSamples, 8);
  h.record({ ...sample('other'), routeId: 'route-B' }); assert.equal(h.estimate('route-A', 1_000_000n, cold).cleanSamples, 0);
});
