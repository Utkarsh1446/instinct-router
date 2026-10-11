/** Controlled DEX/CCTP prices; intercepts every transport without network access. */
import { BASE_V3 } from '@instinct/router-core';
import { MULTICALL3_RUNTIME } from '../../packages/core/dist/multicall3.js';
import { fixtureWire, solUsdc } from './provider.mjs';
const WSOL = 'So11111111111111111111111111111111111111112';
const abi = (...values) => '0x' + values.map(value => BigInt(value).toString(16).padStart(64, '0')).join('');
function poolRead(tx) {
  const data = tx.data;
  if (data === '0x313ce567') return abi(tx.to === BASE_V3.usdc ? 6 : 18);
  if (data.startsWith('0x1698ee82')) return abi(BigInt('0x' + data.slice(-64)) + 1n);
  if (data.startsWith('0xc6a5026a')) {
    const input = '0x' + data.slice(34, 74), amount = BigInt('0x' + data.slice(138, 202));
    const output = input === BASE_V3.weth ? amount * 2200n / 1000000000000n : amount * 1000000000000n / 2200n;
    return abi(output, 1n << 96n, 0, 40000);
  }
  throw new Error('Unexpected RPC selector.');
}
function aggregateFixture(data) {
  const body = data.slice(10), read = offset => Number(BigInt('0x' + body.slice(offset * 2, offset * 2 + 64)));
  if (read(0) !== 32 || read(32) !== 16) throw new Error('Unexpected Multicall request.');
  const tuples = Array.from({ length: 16 }, (_, index) => {
    const tuple = 64 + read(64 + index * 32), tail = tuple + read(tuple + 64);
    const result = poolRead({ to: '0x' + body.slice(tuple * 2 + 24, tuple * 2 + 64),
      data: '0x' + body.slice((tail + 32) * 2, (tail + 32 + read(tail)) * 2) }).slice(2);
    return abi(1, 64, result.length / 2).slice(2) + result.padEnd(Math.ceil(result.length / 64) * 64, '0');
  });
  let offset = tuples.length * 32;
  const offsets = tuples.map(tuple => { const value = abi(offset).slice(2); offset += tuple.length / 2; return value; });
  return abi(32, tuples.length) + offsets.join('') + tuples.join('');
}
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
export function independentWire({ calls = [], now = Date.now } = {}) {
  const other = fixtureWire({ now });
  return async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith('https://transaction-v1.raydium.io/compute/swap-base-in?')) {
      const query = new URL(url).searchParams, inputMint = query.get('inputMint'), outputMint = query.get('outputMint');
      const amount = BigInt(query.get('amount')), slippage = Number(query.get('slippageBps'));
      if (![WSOL, solUsdc.address].includes(inputMint) || ![WSOL, solUsdc.address].includes(outputMint))
        return json({ success: false, msg: 'ROUTE_NOT_FOUND' });
      const output = inputMint === WSOL ? amount / 10n : amount * 10n;
      return json({ id: 'fixture-raydium', success: true, version: 'V1', data: { swapType: 'BaseIn', inputMint, outputMint,
        inputAmount: amount.toString(), actualInputAmount: amount.toString(), outputAmount: output.toString(),
        otherAmountThreshold: (output * BigInt(10000 - slippage) / 10000n).toString(), slippageBps: slippage,
        priceImpactPct: 0.01, referrerAmount: '0', routePlan: [{ poolId: WSOL, inputMint, outputMint,
          feeMint: inputMint, feeRate: 25, feeAmount: '1', remainingAccounts: [] }] } });
    }
    if (url === BASE_V3.rpc) {
      const batch = JSON.parse(init.body);
      return json(batch.map(call => {
        let result;
        if (call.method === 'eth_chainId') result = '0x2105';
        else if (call.method === 'eth_blockNumber') result = '0x123456';
        else if (call.method === 'eth_getBlockByNumber') result = { number: '0x123456', hash: '0x' + '11'.repeat(32), timestamp: '0x' + Math.floor(now() / 1000).toString(16) };
        else if (call.method === 'eth_getCode') result = MULTICALL3_RUNTIME;
        else if (call.method === 'eth_call') {
          const tx = call.params[0];
          result = tx.data.startsWith('0x82ad56cb') ? aggregateFixture(tx.data) : poolRead(tx);
        } else throw new Error('Unexpected RPC method.');
        return { jsonrpc: '2.0', id: call.id, result };
      }));
    }
    return other(url, init);
  };
}
