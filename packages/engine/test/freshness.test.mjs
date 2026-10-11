import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@instinct/router-core';
import { createQuoteService } from '../src/index.mjs';
import { input } from '../../../tests/fixtures/provider.mjs';
const start = 1900000000000;
function candidate(request, { provider = 'relay', cutoff = start + 60000, feeBps = 10, out = '1000' } = {}) {
  const source = request.source, destination = request.destination;
  const leg = { index: 0, capabilityId: 'cap-' + provider, adapterId: provider, source, destination,
    kind: 'SWAP_BRIDGE', validationTier: 'QUOTE_VALIDATED', executionTier: 'NONE', quoteProbe: true,
    amountSource: 'REQUEST_AMOUNT', requiresRequoteAfterSettlement: false };
  const quote = { capabilityId: leg.capabilityId, adapterId: provider, source, destination,
    amountInRaw: request.amountRaw, expectedOutRaw: out, minimumOutRaw: out, feeBps, priceImpactBps: 0,
    estimatedCompletionMs: 1000, expiresAtMs: request.deadlineMs, pricingValidUntilMs: cutoff,
    quoteId: 'quote-' + provider, conditional: false, liquidityConfirmed: true };
  return { id: 'path-' + provider, requestId: request.requestId, source, destination, inputAmountRaw: request.amountRaw,
    path: { id: 'path-' + provider, kind: 'DIRECT', source, destination, legs: [leg], quoteBasis: 'FIRM_FIRST_LEG', quoteProbe: true, executionReady: false },
    legQuotes: [quote], expectedOutputRaw: out, minimumOutputRaw: out, feeBps, priceImpactBps: 0,
    completionMs: 1000, deadlineMs: request.deadlineMs, quotedAtMs: start, conditional: false,
    validationTier: 'QUOTE_VALIDATED', executionReady: false };
}
function fixture(t, rows, { advance = 0, emit = false, mutate } = {}) {
  let stamp = start;
  t.mock.method(core.RouterRuntime.prototype, 'quote', async (request, controls) => {
    const candidates = rows.map(row => candidate(request, row));
    const initial = core.rankCandidates(request, candidates, { nowMs: stamp });
    if (emit) for (const value of candidates) controls.onCandidate?.(structuredClone(value));
    mutate?.(candidates); stamp += advance;
    // The runtime's earlier ranking must not survive a later pricing cutoff.
    return { ...initial, candidates, quoteRttMs: advance, comparisonComplete: true, failures: [], planning: { paths: [] } };
  });
  return createQuoteService({ now: () => stamp, fetch: () => { throw new Error('No network expected'); } });
}

test('an expired ineligible CCTP preview cannot poison a fresh selected Relay snapshot', async t => {
  const service = fixture(t, [{ cutoff: start + 60000 }, { provider: 'cctp-fast', cutoff: start + 5, feeBps: null }], { advance: 10 });
  const quote = await service.quote(input);
  const relay = quote.candidates.find(row => row.provider === 'relay'), stale = quote.candidates.find(row => row.provider === 'cctp-fast');
  assert.equal(quote.winner, relay.id); assert.equal(relay.eligible, true);
  assert.equal(stale.validUntilMs, start + 5); assert.equal(stale.eligible, false);
  assert.equal(quote.validUntilMs, relay.validUntilMs); assert.equal(quote.validUntilMs, start + 60000);
  assert.ok(quote.excluded.some(row => row.id === stale.id));
  assert.equal(quote.execution.enabled, false);
});

test('a longer diagnostic preview never extends the selected winner cutoff', async t => {
  const service = fixture(t, [{ cutoff: start + 1000 }, { provider: 'cctp-standard', cutoff: start + 60000, feeBps: null }]);
  const quote = await service.quote(input);
  assert.ok(quote.winner); assert.equal(quote.validUntilMs, start + 1000);
  assert.equal(quote.candidates.find(row => row.provider === 'cctp-standard').validUntilMs, start + 60000);
});

test('no winner uses the last individual preview cutoff without extending any preview', async t => {
  const service = fixture(t, [{ provider: 'cctp-fast', cutoff: start + 1000, feeBps: null },
    { provider: 'cctp-standard', cutoff: start + 5000, feeBps: null }]);
  const quote = await service.quote(input);
  assert.equal(quote.winner, null); assert.equal(quote.validUntilMs, start + 5000);
  assert.deepEqual(quote.candidates.map(row => row.validUntilMs), [start + 1000, start + 5000]);
  assert.ok(quote.candidates.every(row => !row.eligible));
});

test('final projection re-ranks an initially eligible arrival that expires before completion', async t => {
  const service = fixture(t, [{ cutoff: start + 5 }], { advance: 10, emit: true });
  const arrivals = [], quote = await service.quote(input, undefined, row => arrivals.push(row));
  assert.equal(arrivals[0].eligible, true); assert.equal(quote.candidates[0].eligible, false); assert.equal(quote.winner, null);
  assert.equal(quote.validUntilMs, start + 5);
  assert.deepEqual(quote.excluded[0].reasons, ['STALE_PRICING_EVIDENCE']);
  const { eligible: before, ...arrival } = arrivals[0], { eligible: after, ...final } = quote.candidates[0];
  assert.deepEqual(arrival, final);
});

test('all expired previews remain expired and an empty comparison has no invented pricing TTL', async t => {
  const expired = await fixture(t, [{ provider: 'cctp-fast', cutoff: start + 3, feeBps: null },
    { provider: 'cctp-standard', cutoff: start + 7, feeBps: null }], { advance: 10 }).quote(input);
  assert.equal(expired.validUntilMs, start + 7); assert.equal(expired.winner, null);
  t.mock.restoreAll();
  const empty = await fixture(t, []).quote(input);
  assert.equal(empty.validUntilMs, null); assert.equal(empty.winner, null); assert.deepEqual(empty.candidates, []);
});

test('fresh final ranking rejects altered request bindings rather than retaining earlier eligibility', async t => {
  const quote = await fixture(t, [{}], { mutate: rows => { rows[0].inputAmountRaw = '1'; } }).quote(input);
  assert.equal(quote.winner, null); assert.equal(quote.candidates[0].eligible, false);
  assert.deepEqual(quote.excluded[0].reasons, ['REQUEST_BINDING_MISMATCH']);
});
