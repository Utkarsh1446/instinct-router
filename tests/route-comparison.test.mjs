import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { COMPARISON_POLICY, buildDocument, deriveWinner, explainPair } from '../scripts/route-comparison-lib.mjs';

const policy = COMPARISON_POLICY;

function quote(minimumOutRaw, completionMs, feeBps = 20, priceImpactBps = 10) {
  const expected = (BigInt(minimumOutRaw) * 10000n / 9950n).toString();
  return {
    expectedOutRaw: expected,
    minimumOutRaw,
    expectedOut: expected,
    minimumOut: minimumOutRaw,
    feeBps,
    priceImpactBps,
    completionMs,
  };
}

function pair(overrides) {
  return {
    id: 'sample',
    destinationSymbol: 'USDC',
    relayRegistered: true,
    quotes: {},
    failures: [],
    excluded: [],
    winner: null,
    selectionReason: 'BALANCED_WITHIN_OUTPUT_BAND',
    ...overrides,
  };
}

test('shorter ETA inside the band beats a slightly higher minimum', () => {
  const row = pair({
    quotes: {
      'near-intents-1click': quote('100000000', 61000),
      relay: quote('99800000', 15000, 14, 13),
    },
    winner: 'relay',
  });
  assert.equal(deriveWinner(row, policy), 'relay');
  const explained = explainPair(row, policy);
  assert.equal(explained.reasonCode, 'SHORTER_ETA');
  assert.match(explained.why, /Relay won under BALANCED/);
  assert.match(explained.why, /15000 ms was shorter/);
});

test('a minimum outside the band loses even when its ETA is shorter', () => {
  const row = pair({
    quotes: {
      'near-intents-1click': quote('100000000', 61000),
      relay: quote('90000000', 15000, 14, 13),
    },
    winner: 'near-intents-1click',
  });
  assert.equal(deriveWinner(row, policy), 'near-intents-1click');
  assert.equal(explainPair(row, policy).reasonCode, 'OUTSIDE_BAND');
});

test('an excluded quote does not win', () => {
  const row = pair({
    quotes: {
      'near-intents-1click': quote('100000000', 61000),
      relay: quote('101000000', 15000, 140, 10),
    },
    excluded: [{ provider: 'relay', reasons: ['FEE_LIMIT'] }],
    winner: 'near-intents-1click',
  });
  assert.equal(deriveWinner(row, policy), 'near-intents-1click');
  const explained = explainPair(row, policy);
  assert.equal(explained.reasonCode, 'OTHER_EXCLUDED');
  assert.match(explained.why, /FEE_LIMIT/);
});

test('a NEAR destination asks only 1Click', () => {
  const row = pair({
    relayRegistered: false,
    quotes: { 'near-intents-1click': quote('1000000', 40000) },
    winner: 'near-intents-1click',
  });
  assert.equal(deriveWinner(row, policy), 'near-intents-1click');
  assert.equal(explainPair(row, policy).reasonCode, 'ONLY_QUOTE');
});

test('no eligible route when every quote is excluded or missing', () => {
  const row = pair({
    quotes: { relay: quote('100', 15000, 400, 10) },
    excluded: [{ provider: 'relay', reasons: ['FEE_LIMIT'] }],
    failures: [{ provider: 'near-intents-1click', code: 'PROVIDER_HTTP_ERROR' }],
    winner: null,
    selectionReason: 'NO_ELIGIBLE_ROUTE',
  });
  assert.equal(deriveWinner(row, policy), null);
  assert.equal(explainPair(row, policy).reasonCode, 'NO_ELIGIBLE');
});

test('stored comparison matches the ranker summary and contains no deposit address', async () => {
  const directory = new URL('../examples/near-intents/data/', import.meta.url);
  const names = readdirSync(directory).filter(name => /^route-comparison-\d{4}-\d{2}-\d{2}\.json$/.test(name));
  assert.equal(names.length, 1);
  const document = JSON.parse(await readFile(new URL(names[0], directory), 'utf8'));
  assert.equal(document.executionAuthorized, false);
  assert.equal(document.quoteMode, '1click-dry-and-relay-unsigned');
  assert.equal(document.oneClick, 'https://1click.chaindefuser.com/v0/quote');
  assert.equal(names[0], `route-comparison-${document.collectedAt.slice(0, 10)}.json`);
  assert.equal(Number.isNaN(Date.parse(document.collectedAt)), false);
  assert.ok(document.pairs.length >= 10 && document.pairs.length <= 20);
  const built = buildDocument(document.pairs, document.collectedAt, document.policy);
  assert.deepEqual(document.counts, built.counts);
  assert.equal(document.summary, built.summary);
  assert.equal(document.counts.pairs, document.pairs.length);
  assert.equal(
    document.counts.oneClickWins + document.counts.relayWins + document.counts.noWinner,
    document.pairs.length,
  );
  const app = readFileSync(new URL('../examples/near-intents/app.js', import.meta.url), 'utf8');
  assert.match(app, new RegExp(names[0].replace(/[.]/g, '\\.')));
  for (const row of document.pairs) {
    assert.equal(deriveWinner(row, document.policy), row.winner);
    const explained = explainPair(row, document.policy);
    assert.equal(row.reasonCode, explained.reasonCode);
    assert.equal(row.why, explained.why);
    assert.equal(typeof row.why, 'string');
    assert.ok(row.why.length > 20);
    const oneClick = row.quotes['near-intents-1click'];
    if (oneClick) {
      assert.equal(oneClick.dryQuote, true);
      assert.equal(oneClick.depositAddress, null);
      assert.match(oneClick.quoteHash, /^[0-9a-f]{64}$/);
    }
    if (row.quotes.relay) assert.equal(row.quotes.relay.depositAddress, undefined);
    assert.equal(JSON.stringify(row).includes('"' + 'depositAddress": "'), false);
  }
  assert.equal(JSON.stringify(document).includes('BEGIN PRIVATE'), false);
});
