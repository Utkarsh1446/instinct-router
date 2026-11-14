const ETH = '0x0000000000000000000000000000000000000000';
const PREVIEW_SENDER = '0x1111111111111111111111111111111111111111';
const PREVIEW_RECIPIENT = '0x2222222222222222222222222222222222222222';

/** Pinned 1Click asset ids from GET /v0/tokens. Amounts stay small and quotes stay dry. */
export const PRESETS = [
  {
    id: 'eth-base-usdc',
    label: 'ETH on Ethereum → USDC on Base',
    amount: '0.05',
    relay: true,
    note: 'Both NEAR Intents 1Click and Relay can quote this pair. Nothing is signed or sent.',
    source: {
      chainId: 'eip155:1', address: ETH, decimals: 18, symbol: 'ETH', blockchain: 'eth',
      assetId: 'nep141:eth.omft.near', relayChainId: 1, relayProtocolChainId: 'ethereum', confirmationMs: 12_000,
    },
    destination: {
      chainId: 'eip155:8453', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, symbol: 'USDC',
      blockchain: 'base', assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
      relayChainId: 8453, relayProtocolChainId: 'base', confirmationMs: 2_000,
    },
    sender: PREVIEW_SENDER,
    recipient: PREVIEW_RECIPIENT,
  },
  {
    id: 'eth-near-usdc',
    label: 'ETH on Ethereum → USDC on NEAR',
    amount: '0.05',
    relay: false,
    note: 'Destination is USDC on NEAR. Relay is not registered for this chain. The 1Click quote is still dry.',
    source: {
      chainId: 'eip155:1', address: ETH, decimals: 18, symbol: 'ETH', blockchain: 'eth',
      assetId: 'nep141:eth.omft.near', relayChainId: 1, relayProtocolChainId: 'ethereum', confirmationMs: 12_000,
    },
    destination: {
      chainId: 'near:mainnet', address: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
      decimals: 6, symbol: 'USDC', blockchain: 'near',
      assetId: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', confirmationMs: 2_000,
    },
    sender: PREVIEW_SENDER,
    recipient: 'a'.repeat(64),
  },
];

export function previewBand(objective) {
  if (objective === 'BEST_OUTPUT') return 0;
  if (objective === 'FASTEST') return 200;
  return 50;
}
