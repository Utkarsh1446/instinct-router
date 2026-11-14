import { CapabilityRegistry, DynamicRouter, createNearIntentsOneClickAdapter, createRelayAdapter } from '../packages/core/dist/index.js';
import { PRESETS } from '../examples/near-intents/presets.js';

const preset = PRESETS[0];
const source = { chainId: preset.source.chainId, address: preset.source.address, decimals: preset.source.decimals };
const destination = { chainId: preset.destination.chainId, address: preset.destination.address, decimals: preset.destination.decimals };
const chain = (asset) => ({ chainId: asset.chainId, blockchain: asset.blockchain, sourceConfirmationMs: asset.confirmationMs, destinationVerificationMs: asset.confirmationMs });
const relayChain = (asset) => ({ chainId: asset.chainId, relayChainId: asset.relayChainId, relayProtocolChainId: asset.relayProtocolChainId, sourceConfirmationMs: asset.confirmationMs, destinationVerificationMs: asset.confirmationMs });
const edge = (adapterId) => ({ id: `${adapterId}:direct`, adapterId, source, destination, kind: 'SWAP_BRIDGE', validationTier: 'QUOTE_VALIDATED', executionTier: 'NONE', liquidity: 'UNKNOWN', validUntilMs: Date.now() + 600_000 });
const request = {
  requestId: `smoke-${Date.now()}`, source, destination, amountRaw: '50000000000000000',
  sender: preset.sender, recipient: preset.recipient, slippageBps: 50, maxFeeBps: 100, maxPriceImpactBps: 500,
  maxCompletionMs: 600_000, deadlineMs: Date.now() + 60 * 60 * 1000,
  optimization: { objective: 'BEST_OUTPUT', maxOutputShortfallBps: 0 },
};
const near = createNearIntentsOneClickAdapter({
  chains: [chain(preset.source), chain(preset.destination)],
  assets: [{ asset: source, assetId: preset.source.assetId }, { asset: destination, assetId: preset.destination.assetId }],
  fetch: (url, init) => fetch(url, init),
});
const relay = createRelayAdapter({ chains: [relayChain(preset.source), relayChain(preset.destination)], fetch: (url, init) => fetch(url, init) });
const result = await new DynamicRouter(new CapabilityRegistry([edge('near-intents-1click'), edge('relay')]), [near, relay],
  { quoteBudgetMs: 8_000, providerTimeoutMs: 7_000 }).quote(request);
const summary = {
  executionAuthorized: result.executionAuthorized,
  winner: result.winner?.legQuotes[0]?.adapterId ?? null,
  failures: result.failures,
  routes: result.candidates.map(candidate => {
    const leg = candidate.legQuotes[0];
    return {
      provider: leg.adapterId, expectedOutRaw: candidate.expectedOutputRaw, minimumOutRaw: candidate.minimumOutputRaw,
      feeBps: candidate.feeBps, priceImpactBps: candidate.priceImpactBps, completionMs: candidate.completionMs,
      dryQuote: leg.dryQuote === true, depositAddress: leg.dryDeposit?.depositAddress ?? null,
    };
  }),
};
console.log(JSON.stringify(summary, null, 2));
if (summary.executionAuthorized !== false) process.exitCode = 1;
if (!summary.routes.some(route => route.provider === 'near-intents-1click' && route.dryQuote && route.depositAddress === null)) process.exitCode = 1;
