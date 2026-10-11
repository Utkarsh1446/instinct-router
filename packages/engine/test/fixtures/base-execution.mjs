/** Synthetic public chain evidence; router bytes reuse the independently matched offline artifact. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BASE_V3 } from '@instinct/router-core';
import { MULTICALL3_ADDRESS, MULTICALL3_RUNTIME } from '../../../core/dist/multicall3.js';
export const ROUTER = '0x2626664c2603336e57b271c5c0b26f421741e481', ORACLE = '0x420000000000000000000000000000000000000f';
export const OWNER = '0x' + '11'.repeat(20), RECIPIENT = '0x' + '33'.repeat(20), POOL = '0x' + '44'.repeat(20);
export const TXHASH = '0x' + '56'.repeat(32), BLOCKHASH = '0x' + '12'.repeat(32);
export const word = value => BigInt(value).toString(16).padStart(64, '0');
export const abi = (...values) => '0x' + values.map(word).join('');
const routerRuntime = /const ROUTER_RUNTIME = '(0x[0-9a-f]+)';/.exec(readFileSync(new URL('../base-readiness.test.mjs', import.meta.url), 'utf8'))[1];
const sha = code => createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex');
const impl = '0x' + '66'.repeat(20), oracleImpl = '0x' + '77'.repeat(20);
const SLOT = '0x' + '88'.repeat(32);
const codes = new Map([[ROUTER, routerRuntime], [MULTICALL3_ADDRESS, MULTICALL3_RUNTIME], [BASE_V3.weth, '0x' + '60'.repeat(100)],
  [BASE_V3.usdc, '0x' + '61'.repeat(100)], [impl, '0x' + '62'.repeat(100)], [ORACLE, '0x' + '63'.repeat(100)],
  [oracleImpl, '0x' + '64'.repeat(100)], [BASE_V3.factory, '0x' + '65'.repeat(100)], [POOL, '0x' + '66'.repeat(100)]]);
export const pins = { base: { weth: { codeSha256: sha(codes.get(BASE_V3.weth)) },
  usdc: { codeSha256: sha(codes.get(BASE_V3.usdc)), implementation: { slot: SLOT, address: impl, codeSha256: sha(codes.get(impl)) } },
  oracle: { codeSha256: sha(codes.get(ORACLE)), implementation: { slot: SLOT, address: oracleImpl, codeSha256: sha(codes.get(oracleImpl)) } },
  factory: { codeSha256: sha(codes.get(BASE_V3.factory)) } } };
export const input = () => ({ source: { chainId: BASE_V3.chainId, address: BASE_V3.native, decimals: 18 },
  destination: { chainId: BASE_V3.chainId, address: BASE_V3.usdc, decimals: 6 }, amount: '0.00005', sender: OWNER, recipient: RECIPIENT,
  slippageBps: 50, maxFeeBps: 1000, maxPriceImpactBps: 500, nativeFeeBudgets: [{ chainId: BASE_V3.chainId, maxAmountRaw: '10000000000000' }] });
function aggregate() {
  const rows = [abi(18), abi(6), ...Array.from({ length: 7 }, () => abi(BigInt(POOL))),
    ...Array.from({ length: 7 }, (_, i) => abi(i === 4 ? 100003 : 90000, 1n << 96n, 0, 40000))];
  const tuples = rows.map(data => word(1) + word(64) + word((data.length - 2) / 2) + data.slice(2));
  let next = rows.length * 32;
  return abi(32, rows.length) + tuples.map(tuple => { const offset = word(next); next += tuple.length / 2; return offset; }).join('') + tuples.join('');
}
function sqrt(value) { let x = value, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + value / x) / 2n; } return x; }
export function fixture() {
  let stamp = Date.now(), mutate = rows => rows, transaction = null;
  const batches = [];
  const header = () => ({ number: '0x1234', hash: BLOCKHASH, transactions: [TXHASH], timestamp: '0x' + Math.floor(stamp / 1000).toString(16), baseFeePerGas: '0x4c4b40' });
  const receipt = () => ({ transactionHash: TXHASH, transactionIndex: '0x0', from: OWNER, to: ROUTER, type: '0x2', blockNumber: '0x1234', blockHash: BLOCKHASH,
    status: '0x1', gasUsed: '0x186a0', effectiveGasPrice: '0x5b8d80', l1Fee: '0x186a0',
    logs: [{ transactionHash: TXHASH, blockHash: BLOCKHASH, blockNumber: '0x1234', removed: false, logIndex: '0x0', address: BASE_V3.usdc,
      topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + POOL.slice(2).padStart(64, '0'), '0x' + RECIPIENT.slice(2).padStart(64, '0')], data: abi(100003) }] });
  const wire = async (url, init) => {
    if (![BASE_V3.rpc, BASE_V3.rpc + '/', 'https://base.drpc.org/'].includes(url)) throw new Error('Unexpected endpoint');
    const calls = JSON.parse(init.body); batches.push(calls);
    const rows = calls.map(call => {
      let result;
      switch (call.method) {
        case 'eth_chainId': result = '0x2105'; break;
        case 'eth_getBlockByNumber': case 'eth_getBlockByHash': result = header(); break;
        case 'eth_blockNumber': result = '0x123f'; break;
        case 'eth_getTransactionReceipt': result = receipt(); break;
        case 'eth_getTransactionByHash': result = transaction; break;
        case 'eth_getBalance': result = '0xde0b6b3a7640000'; break;
        case 'eth_maxPriorityFeePerGas': result = '0xf4240'; break;
        case 'eth_estimateGas': result = '0x186a0'; break;
        case 'eth_getCode': result = call.params[0] === OWNER ? '0x' : codes.get(call.params[0]); break;
        case 'eth_getStorageAt': result = abi(BigInt(call.params[0] === BASE_V3.usdc ? impl : oracleImpl)); break;
        case 'eth_call': {
          const { to, data } = call.params[0];
          if (to === MULTICALL3_ADDRESS) result = aggregate();
          else if (data === '0xc45a0155') result = abi(BigInt(BASE_V3.factory));
          else if (data === '0x4aa4a4fc' || data === '0x0dfe1681') result = abi(BigInt(BASE_V3.weth));
          else if (data === '0xd21220a7') result = abi(BigInt(BASE_V3.usdc));
          else if (data === '0xddca3f43') result = abi(500);
          else if (data.startsWith('0x1698ee82')) result = abi(BigInt(POOL));
          else if (data === '0x3850c7bd') result = abi(sqrt((102000n << 192n) / 50000000000000n), 0, 0, 1, 1, 0, 1);
          else if (to === ROUTER && data.startsWith('0x5ae401dc')) result = abi(32, 2, 64, 128, 32, 100003, 0);
          else if (data === '0x313ce567') result = abi(to === BASE_V3.usdc ? 6 : 18);
          else if (to === ORACLE && ['0x960e3a23', '0x105d0b81'].includes(data)) result = abi(1);
          else if (to === ORACLE && data.startsWith('0xf1c7a58b')) result = abi(100000);
          else if (to === ORACLE && data.startsWith('0x275aedd2')) result = abi(0);
          else throw new Error('Unexpected calldata'); break;
        }
        default: throw new Error('Signing/broadcasting/unexpected RPC forbidden');
      }
      return { jsonrpc: '2.0', id: call.id, result };
    });
    return new Response(JSON.stringify(mutate(rows, calls)));
  };
  return { wire, batches, now: () => stamp, advance: delta => { stamp += delta; }, mutate: fn => { mutate = fn; },
    setTransaction: tx => { transaction = { ...tx, hash: TXHASH, transactionIndex: '0x0', input: tx.data, blockHash: BLOCKHASH, blockNumber: '0x1234' }; delete transaction.data; } };
}
