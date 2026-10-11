export const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const ZERO = '0x0000000000000000000000000000000000000000';
export const SYSTEM = '11111111111111111111111111111111';
export const chains = [
  { id: 'base', name: 'Base', chainId: 'eip155:8453', relayChainId: 8453, relayProtocolChainId: 'base', auroraBlockchain: 'base', cctpDomain: 6 },
  { id: 'solana', name: 'Solana', chainId: SOL, relayChainId: 792703809, relayProtocolChainId: 'solana', auroraBlockchain: 'sol', cctpDomain: 5 },
  { id: 'ethereum', name: 'Ethereum', chainId: 'eip155:1', relayChainId: 1, relayProtocolChainId: 'ethereum', auroraBlockchain: 'eth', cctpDomain: 0 },
  { id: 'arbitrum', name: 'Arbitrum', chainId: 'eip155:42161', relayChainId: 42161, relayProtocolChainId: 'arbitrum', auroraBlockchain: 'arb', cctpDomain: 3 },
].map(row => ({ ...row, sourceConfirmationMs: 24000, destinationVerificationMs: 24000 }));
const token = (id, chainId, address, decimals, symbol, native = false) => ({ id, chainId, address, decimals, symbol, native, decimalsSource: 'PINNED_CONFIG' });
export const assets = [
  token('base-eth', chains[0].chainId, ZERO, 18, 'ETH', true),
  token('solana-sol', SOL, SYSTEM, 9, 'SOL', true),
  token('base-usdc', chains[0].chainId, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 6, 'USDC'),
  token('solana-usdc', SOL, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6, 'USDC'),
  token('ethereum-eth', chains[2].chainId, ZERO, 18, 'ETH', true),
  token('ethereum-usdc', chains[2].chainId, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 6, 'USDC'),
  token('arbitrum-eth', chains[3].chainId, ZERO, 18, 'ETH', true),
  token('arbitrum-usdc', chains[3].chainId, '0xaf88d065e77c8cc2239327c5edb3a432268e5831', 6, 'USDC'),
];

export const auroraNativeAssetIds = {
  "base": "nep141:base.omft.near",
  "solana": "nep141:sol.omft.near"
};

export const assetClasses = Object.freeze([{ id: "token", pricing: true, execution: false }, { id: "tokenized_stock", pricing: "BY_ONCHAIN_ASSET_AND_LIQUIDITY", execution: false }, { id: "broker_stock", pricing: false, execution: false, reason: "A broker venue adapter and account authorization are required." }, { id: "prediction_position", pricing: false, execution: false, reason: "A market venue adapter and position identifiers are required." }]);
