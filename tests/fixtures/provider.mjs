/** Deterministic quote transports; these never access an RPC or wallet. */
export const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const BASE = 'eip155:8453';
export const evmWallet = '0x1111111111111111111111111111111111111111';
export const solWallet = '11111111111111111111111111111112';
export const baseUsdc = { chainId: BASE, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 };
export const solUsdc = { chainId: SOL, address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
export const input = { source: baseUsdc, destination: solUsdc, amount: '1', sender: evmWallet, recipient: solWallet };
const mappings = { 8453: ['base', BASE], 792703809: ['solana', SOL], 1: ['ethereum', 'eip155:1'], 42161: ['arbitrum', 'eip155:42161'] };
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
export function fixtureWire({ now = Date.now, mutate = () => {}, calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/fees/')) return response([{ finalityThreshold: 1000, minimumFee: '1.3' }, { finalityThreshold: 2000, minimumFee: '0' }]);
    if (url.includes('/allowance')) return response({ allowance: '10000000000', lastUpdated: new Date(now()).toISOString() });
    if (url !== 'https://api.relay.link/quote/v2') throw new Error('Unexpected fixture endpoint.');
    const sent = JSON.parse(init.body);
    const native = id => id === 792703809 ? 9 : 18;
    const decimals = (id, token) => /^(?:0x0{40}|1{32})$/.test(token) ? native(id) : 6;
    const raw = {
      details: { sender: sent.user, recipient: sent.recipient,
        currencyIn: { currency: { chainId: sent.originChainId, address: sent.originCurrency, decimals: decimals(sent.originChainId, sent.originCurrency) }, amount: sent.amount, amountUsd: '100' },
        currencyOut: { currency: { chainId: sent.destinationChainId, address: sent.destinationCurrency, decimals: decimals(sent.destinationChainId, sent.destinationCurrency) }, amount: '1000000', minimumAmount: '995000' },
        timeEstimate: 12, swapImpact: { percent: '0.1' }, expandedPriceImpact: { execution: { usd: '0.1' }, relay: { usd: '0.1' }, app: { usd: '0' } } },
      fees: { gas: { amountUsd: '0.01' } },
      protocol: { v2: { orderId: '0x' + '11'.repeat(32), orderData: {
        inputs: [{ payment: { chainId: mappings[sent.originChainId][0], currency: sent.originCurrency, amount: sent.amount } }],
        output: { chainId: mappings[sent.destinationChainId][0], calls: [], payments: [{ recipient: sent.recipient, currency: sent.destinationCurrency, expectedAmount: '1000000', minimumAmount: '995000' }], deadline: Math.floor((now() + 30000) / 1000) },
      } } },
    };
    mutate(raw); return response(raw);
  };
}
