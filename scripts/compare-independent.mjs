/** Read-only provider quotes via the running SDK API; never signs or broadcasts. */
import { writeFile } from 'node:fs/promises';
import { createRouterServerClient } from '@instinct/router-sdk/server';
import { readOwnedJson } from './config.mjs';
const baseWallet = process.env.ROUTER_TEST_BASE_WALLET, solWallet = process.env.ROUTER_TEST_SOLANA_WALLET;
if (!baseWallet || !solWallet) throw new Error('Supply public ROUTER_TEST_BASE_WALLET and ROUTER_TEST_SOLANA_WALLET addresses.');
const apps = await readOwnedJson(new URL('../.dev/apps.json', import.meta.url).pathname);
const client = createRouterServerClient({ baseUrl: 'http://127.0.0.1:8791', serverKey: apps.apps[0].serverKey });
const config = await client.getConfig();
if (!config.capabilities.independentRoutes) throw new Error('Enable independentRoutes in the trusted local provider policy and restart the API.');
const asset = id => { const { chainId, address, decimals } = config.assets.find(row => row.id === id); return { chainId, address, decimals }; };
const samples = [];
for (const [name, sourceId, destinationId, amount, scopes] of [
  ['Solana SOL → Base ETH', 'solana-sol', 'base-eth', '0.01', ['INDEPENDENT', 'ALL']],
  ['Base ETH → Solana SOL', 'base-eth', 'solana-sol', '0.001', ['INDEPENDENT', 'ALL']],
  ['Solana SOL → Solana USDC', 'solana-sol', 'solana-usdc', '0.01', ['INDEPENDENT']],
  ['Base ETH → Base USDC', 'base-eth', 'base-usdc', '0.001', ['INDEPENDENT']],
]) for (const routeScope of scopes) {
  const source = asset(sourceId), destination = asset(destinationId);
  const request = { source, destination, amount, routeScope,
    sender: source.chainId.startsWith('solana:') ? solWallet : baseWallet,
    recipient: destination.chainId.startsWith('solana:') ? solWallet : baseWallet };
  const start = performance.now();
  try {
    const result = await client.quote(request);
    const sample = { name, routeScope, source, destination, amount, recordedAt: new Date().toISOString(),
      sdkRttMs: Math.round(performance.now() - start), serviceRttMs: result.serviceRttMs, quoteRttMs: result.quoteRttMs,
      comparisonComplete: result.comparisonComplete, winner: result.winner, candidates: result.candidates,
      failures: result.failures, excluded: result.excluded, providerTimings: result.providerTimings,
      executionEnabled: result.execution.enabled, tradeRttMs: null };
    samples.push(sample);
    console.log(JSON.stringify({ name, routeScope, sdkRttMs: sample.sdkRttMs,
      candidates: result.candidates.map(row => ({ providers: row.providers, output: row.expectedOutputRaw, minimum: row.minimumOutputRaw })), failures: result.failures }));
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code ?? '') ? error.code : 'REQUEST_FAILED';
    samples.push({ name, routeScope, error: code, sdkRttMs: Math.round(performance.now() - start) });
    console.log(JSON.stringify({ name, routeScope, error: code }));
  }
}
const report = { capturedAt: new Date().toISOString(), mode: 'READ_ONLY_LIVE_SDK_QUOTES',
  interpretation: 'Sequential small-sample quote comparisons, not settlement benchmarks. Prices and connection/cache warmth vary between calls. Independent routes remain conditional and excluded from ranking without full cost evidence.', samples };
const path = process.argv[2];
if (path) await writeFile(path, JSON.stringify(report, null, 2) + '\n');
