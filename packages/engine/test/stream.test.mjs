import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteService } from '../src/index.mjs';
import { fixtureWire, input } from '../../../tests/fixtures/provider.mjs';
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

test('validated fast candidate arrives while another provider is still blocked, with final identical public bindings', async () => {
  const release = deferred(), arrived = deferred(), calls = [];
  const wire = fixtureWire({ calls });
  const service = createQuoteService({ fetch: async (url, init) => {
    if (url.includes('/fees/')) await release.promise;
    return wire(url, init);
  } });
  let finished = false;
  const early = [];
  const pending = service.quote(input, undefined, candidate => {
    early.push(structuredClone(candidate));
    if (candidate.provider === 'relay') arrived.resolve(candidate);
    // A public consumer cannot mutate the provider snapshot or final candidate.
    candidate.minimumOutputRaw = '1'; candidate.steps[0].source.address = 'hostile';
  }).then(value => { finished = true; return value; });
  const first = await arrived.promise;
  assert.equal(finished, false); assert.equal(first.eligible, true);
  assert.doesNotMatch(JSON.stringify(early), /orderData|orderId|calldata|signature|executableRecipeId/);
  release.resolve(); const complete = await pending;
  assert.equal(complete.comparisonComplete, true);
  const final = complete.candidates.find(row => row.provider === 'relay');
  assert.deepEqual(final, early.find(row => row.id === final.id));
  assert.ok(early.some(row => row.provider.startsWith('cctp') && row.eligible === false));
  assert.equal(calls.filter(row => row.url.includes('relay')).length, 1);
});

test('provider binding mismatch never becomes a public candidate and listener errors do not change RFQs', async () => {
  const early = [];
  const service = createQuoteService({ fetch: fixtureWire({ mutate: raw => { raw.details.recipient = 'mismatch'; } }) });
  const value = await service.quote(input, undefined, candidate => { early.push(candidate); throw new Error('listener'); });
  assert.equal(early.some(row => row.provider === 'relay'), false);
  assert.equal(value.candidates.some(row => row.provider === 'relay'), false);
  assert.ok(value.failures.length > 0);
  assert.ok(early.every(row => row.eligible === false));
});

test('abort at first result suppresses subsequent candidate callbacks and final snapshot', async () => {
  const controller = new AbortController(); let count = 0;
  const service = createQuoteService({ fetch: fixtureWire() });
  await assert.rejects(service.quote(input, controller.signal, () => { count++; controller.abort(); }), error => error.code === 'CANCELLED');
  assert.equal(count, 1);
});
