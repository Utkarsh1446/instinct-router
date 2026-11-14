import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBps, formatDuration, formatRawAmount, parseDecimalAmount } from '../examples/near-intents/units.js';

test('decimal amounts convert without floating point', () => {
  assert.equal(parseDecimalAmount('0.05', 18), '50000000000000000');
  assert.equal(parseDecimalAmount('95.282149', 6), '95282149');
  assert.equal(parseDecimalAmount('1', 6), '1000000');
  assert.equal(formatRawAmount('50000000000000000', 18), '0.05');
  assert.equal(formatRawAmount('95282149', 6), '95.282149');
  assert.equal(formatRawAmount('1000000', 6), '1');
  assert.throws(() => parseDecimalAmount('0.0000001', 6), /INVALID_AMOUNT/);
  assert.throws(() => parseDecimalAmount('0', 6), /INVALID_AMOUNT/);
  assert.equal(formatDuration(45000), '45 s');
  assert.equal(formatBps(20), '0.20% (20 bps)');
});
