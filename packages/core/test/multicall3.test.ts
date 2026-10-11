import test from 'node:test';
import assert from 'node:assert/strict';
import { MULTICALL3_ADDRESS, MULTICALL3_RUNTIME, encodeAggregate3, decodeAggregate3, isSolidityRevert } from '../dist/multicall3.js';
import { BASE_V3, createUniswapV3Adapter } from '../dist/uniswap-v3-provider.js';
import type { QuoteContext } from '../src/router.ts';
const NOW = 1800000000000, HASH = '0x' + '12'.repeat(32);
const word = (n: number | bigint) => BigInt(n).toString(16).padStart(64, '0');
const abi = (...n: (number | bigint)[]) => '0x' + n.map(word).join('');
interface Result { success: boolean; data: string }
/** Independent fixture encoder, not the production decoder. */
function encodeResults(results: Result[]): string {
  const tuples = results.map(row => word(Number(row.success)) + word(64) + word((row.data.length - 2) / 2) +
    row.data.slice(2).padEnd(Math.ceil((row.data.length - 2) / 64) * 64, '0'));
  let next = results.length * 32;
  const offsets = tuples.map(tuple => { const offset = word(next); next += tuple.length / 2; return offset; });
  return abi(32, results.length) + offsets.join('') + tuples.join('');
}
function replaceWord(data: string, index: number, value: number): string {
  return data.slice(0, 2 + index * 64) + word(value) + data.slice(66 + index * 64);
}
const REVERT = '0x08c379a0' + word(32) + word(2) + '4949'.padEnd(64, '0');
function context(reverse = false): QuoteContext {
  const eth = { chainId: BASE_V3.chainId, address: BASE_V3.native, decimals: 18 };
  const usdc = { chainId: BASE_V3.chainId, address: BASE_V3.usdc, decimals: 6 };
  const source = reverse ? usdc : eth, destination = reverse ? eth : usdc, owner = '0x' + '11'.repeat(20);
  const request = { requestId: 'multicall', source, destination, amountRaw: reverse ? '1000000' : '50000000000000',
    sender: owner, recipient: owner, slippageBps: 50, maxFeeBps: 500, maxPriceImpactBps: 500,
    maxCompletionMs: 100000, deadlineMs: NOW + 60000, optimization: { objective: 'BALANCED' as const, maxOutputShortfallBps: 50 } };
  return { request, leg: { index: 0, capabilityId: 'eth-usdc', adapterId: 'uniswap-v3', kind: 'SWAP', source, destination,
    validationTier: 'QUOTE_VALIDATED', executionTier: 'NONE', quoteProbe: true, amountSource: 'REQUEST_AMOUNT', requiresRequoteAfterSettlement: false },
    amountRaw: request.amountRaw, sender: owner, recipient: owner, slippageBps: 50,
    deadlineMs: request.deadlineMs, transportDeadlineMs: NOW + 2000, signal: new AbortController().signal };
}
function fixture() {
  const batches: any[][] = [], inners: { target: string; allowFailure: number; data: string }[] = [];
  let mutate: (rows: Result[]) => Result[] = rows => rows;
  let code = MULTICALL3_RUNTIME, outerError = false;
  const options = { clock: () => NOW, fetch: async (url: string, init: RequestInit) => {
    assert.equal(url, BASE_V3.rpc); assert.equal(init.redirect, 'error');
    const batch = JSON.parse(init.body as string); batches.push(batch);
    return new Response(JSON.stringify(batch.map((call: any) => {
      let result;
      if (call.method === 'eth_chainId') result = '0x2105';
      else if (call.method === 'eth_getBlockByNumber') result = { number: '0x1234', hash: HASH, timestamp: '0x' + (NOW / 1000).toString(16) };
      else if (call.method === 'eth_getCode') { assert.equal(call.params[0], MULTICALL3_ADDRESS); result = code; }
      else {
        assert.equal(call.method, 'eth_call'); assert.equal(call.params[0].to, MULTICALL3_ADDRESS);
        assert.deepEqual(call.params[1], { blockHash: HASH, requireCanonical: true });
        if (outerError) return { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'execution reverted', data: REVERT } };
        const encoded = call.params[0].data as string; assert.equal(encoded.slice(0, 10), '0x82ad56cb');
        const hex = encoded.slice(10), read = (byte: number) => Number(BigInt('0x' + hex.slice(byte * 2, byte * 2 + 64)));
        assert.equal(read(0), 32); const count = read(32); assert.equal(count, 16);
        const values = Array.from({ length: count }, (_, i) => {
          const tuple = 64 + read(64 + i * 32), target = '0x' + hex.slice(tuple * 2 + 24, tuple * 2 + 64);
          const allowFailure = read(tuple + 32); assert.equal(read(tuple + 64), 96);
          const length = read(tuple + 96), data = '0x' + hex.slice((tuple + 128) * 2, (tuple + 128 + length) * 2);
          inners.push({ target, allowFailure, data });
          if (data === '0x313ce567') { assert.equal(allowFailure, 0); return { success: true, data: abi(target === BASE_V3.usdc ? 6 : 18) }; }
          if (data.startsWith('0x1698ee82')) { assert.equal(target, BASE_V3.factory); assert.equal(allowFailure, 0); return { success: true, data: abi(1) }; }
          assert.equal(target, BASE_V3.quoter); assert.equal(allowFailure, 1); assert.equal(data.length, 330);
          const fee = BigInt('0x' + data.slice(202, 266));
          return { success: true, data: abi(fee === 500n ? 100003 : 90000, 1n << 96n, 0, 40000) };
        });
        result = encodeResults(mutate(values));
      }
      return { jsonrpc: '2.0', id: call.id, result };
    })));
  } };
  return { options, batches, inners, mutate: (fn: typeof mutate) => { mutate = fn; }, code: (value: string) => { code = value; }, outerError: () => { outerError = true; } };
}
test('strict aggregate3 codec roundtrips canonical result offsets/bytes and exact call selector', () => {
  const calls = [{ target: BASE_V3.weth, allowFailure: false, data: '0x313ce567' }];
  const input = encodeAggregate3(calls);
  assert.equal(input, '0x82ad56cb' + word(32) + word(1) + word(32) + BASE_V3.weth.slice(2).padStart(64, '0') + word(0) + word(96) + word(4) + '313ce567'.padEnd(64, '0'));
  const results = [{ success: true, data: abi(18) }, { success: false, data: REVERT }];
  assert.deepEqual(decodeAggregate3(encodeResults(results), 2), results);
  for (const bad of [replaceWord(encodeResults(results), 0, 64), replaceWord(encodeResults(results), 1, 1),
    replaceWord(encodeResults(results), 2, 0), replaceWord(encodeResults(results), 3, 64),
    replaceWord(encodeResults(results), 4, 2), replaceWord(encodeResults(results), 5, 96),
    replaceWord(encodeResults(results), 6, 65535), encodeResults(results) + word(0), encodeResults(results).slice(0, -2)])
    assert.throws(() => decodeAggregate3(bad, 2), /V3_INVALID_MULTICALL_ABI/);
  const padded = encodeResults([{ success: false, data: '0x01' }]);
  assert.throws(() => decodeAggregate3(padded.slice(0, -2) + '01', 1), /V3_INVALID_MULTICALL_ABI/);
  assert.throws(() => encodeAggregate3([{ ...calls[0]!, allowFailure: 2 as unknown as boolean }]));
  assert.throws(() => decodeAggregate3(encodeResults(results), 17));
});
test('pinned WETH/USDC directions use two HTTP rounds/four RPC methods and same canonical code proof', async () => {
  for (const reverse of [false, true]) {
    const f = fixture(), result = await createUniswapV3Adapter(f.options).quote(context(reverse));
    assert.equal(result.expectedOutRaw, '100003'); assert.equal(result.minimumOutRaw, '99502');
    assert.equal(result.feeBps, null); assert.equal(result.conditional, true); assert.equal(result.executableRecipeId, undefined);
    assert.equal(f.batches.length, 2); assert.equal(f.batches.flat().length, 4); assert.equal(f.inners.length, 16);
    assert.deepEqual(f.batches[1]![0]!.params[1], { blockHash: HASH, requireCanonical: true });
    assert.equal(f.inners[0]!.target, reverse ? BASE_V3.usdc : BASE_V3.weth);
  }
});
test('only canonical inner Quoter revert can be skipped; empty/OOG and metadata failure reject comparison', async () => {
  const f = fixture(); f.mutate(rows => rows.map((row, i) => i === 13 ? { success: false, data: REVERT } : row));
  assert.equal((await createUniswapV3Adapter(f.options).quote(context())).expectedOutRaw, '90000');
  for (const data of ['0x', '0x1234', '0x08c379a0', REVERT.slice(0, -2), abi(1), '0x4e487b71' + word(999), '0x4e487b71' + word(65)]) {
    const unavailable = fixture(); unavailable.mutate(rows => rows.map((row, i) => i === 13 ? { success: false, data } : row));
    await assert.rejects(createUniswapV3Adapter(unavailable.options).quote(context()), /V3_RPC_UNAVAILABLE/);
  }
  const metadata = fixture(); metadata.mutate(rows => rows.map((row, i) => i === 0 ? { success: false, data: REVERT } : row));
  await assert.rejects(createUniswapV3Adapter(metadata.options).quote(context()), /V3_RPC_UNAVAILABLE/);
  assert.equal(isSolidityRevert(REVERT), true); assert.equal(isSolidityRevert('0x4e487b71' + word(17)), true);
});
test('absent pools never grant liquidity; exact deployment runtime and top-level success are mandatory', async () => {
  const absent = fixture(); absent.mutate(rows => rows.map((row, i) => i === 6 ? { success: true, data: abi(0) } : row));
  assert.equal((await createUniswapV3Adapter(absent.options).quote(context())).expectedOutRaw, '90000');
  for (const code of ['0x', MULTICALL3_RUNTIME.slice(0, -2), MULTICALL3_RUNTIME.slice(0, -2) + '00']) {
    const f = fixture(); f.code(code); await assert.rejects(createUniswapV3Adapter(f.options).quote(context()), /V3_MULTICALL_CODE_MISMATCH/);
  }
  const failed = fixture(); failed.outerError();
  await assert.rejects(createUniswapV3Adapter(failed.options).quote(context()), error => (error as { code: string; retryable: boolean }).code === 'V3_RPC_UNAVAILABLE' && (error as { retryable: boolean }).retryable);
});
