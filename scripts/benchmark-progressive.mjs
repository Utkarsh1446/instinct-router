/** Read-only live quotes through the real SDK/API; no signing, approvals or funds. */
import { writeFile } from 'node:fs/promises';
import { createRouterServerClient } from '@instinct/router-sdk/server';
import { readOwnedJson } from './config.mjs';
const baseWallet = process.env.ROUTER_TEST_BASE_WALLET, solWallet = process.env.ROUTER_TEST_SOLANA_WALLET;
if (!baseWallet || !solWallet) throw new Error('Supply public ROUTER_TEST_BASE_WALLET and ROUTER_TEST_SOLANA_WALLET.');
const apps = await readOwnedJson(new URL('../.dev/apps.json', import.meta.url).pathname);
const client = createRouterServerClient({ baseUrl: 'http://127.0.0.1:8791', serverKey: apps.apps[0].serverKey });
const config = await client.getConfig();
const asset = id => { const row = config.assets.find(row => row.id === id); if (!row) throw new Error('Missing configured asset.'); return { chainId: row.chainId, address: row.address, decimals: row.decimals }; };
const samples = [];
const pairs = [
  ['Solana SOL → Base ETH', 'solana-sol', 'base-eth', '0.01', 'ALL'],
  ['Base ETH → Solana SOL', 'base-eth', 'solana-sol', '0.001', 'ALL'],
  ['Solana SOL → Base ETH', 'solana-sol', 'base-eth', '0.01', 'ALL'],
  ['Base ETH → Solana SOL', 'base-eth', 'solana-sol', '0.001', 'ALL'],
  ['Solana SOL → Solana USDC', 'solana-sol', 'solana-usdc', '0.01', 'INDEPENDENT'],
  ['Base ETH → Base USDC', 'base-eth', 'base-usdc', '0.001', 'INDEPENDENT'],
  ['Base ETH → Arbitrum USDC', 'base-eth', 'arbitrum-usdc', '0.001', 'ALL'],
];
for (const [name, sourceId, destinationId, amount, routeScope] of pairs) {
  const source = asset(sourceId), destination = asset(destinationId);
  const request = { source, destination, amount, routeScope,
    sender: source.chainId.startsWith('solana:') ? solWallet : baseWallet,
    recipient: destination.chainId.startsWith('solana:') ? solWallet : baseWallet };
  const started = performance.now(); let firstCandidateRttMs = null, firstEligibleCandidateRttMs = null;
  const arrivals = [];
  try {
    const result = await client.quoteStream(request, { onCandidate(candidate, metadata) {
      const rttMs = Math.round(performance.now() - started);
      firstCandidateRttMs ??= rttMs;
      if (candidate.eligible) firstEligibleCandidateRttMs ??= rttMs;
      arrivals.push({ sequence: metadata.sequence, providers: candidate.providers, rttMs, eligibleAtArrival: candidate.eligible });
    } });
    const fullRttMs = Math.round(performance.now() - started);
    const sample = { name, source, destination, amount, routeScope, recordedAt: new Date().toISOString(),
      firstCandidateRttMs, firstEligibleCandidateRttMs, fullRttMs, arrivals, serviceRttMs: result.serviceRttMs,
      quoteRttMs: result.quoteRttMs, comparisonComplete: result.comparisonComplete, winner: result.winner,
      candidates: result.candidates, providerTimings: result.providerTimings, failures: result.failures, excluded: result.excluded,
      executionEnabled: result.execution.enabled, tradeRttMs: null };
    samples.push(sample);
    console.log(JSON.stringify({ name, firstCandidateRttMs, firstEligibleCandidateRttMs, fullRttMs,
      providers: result.candidates.map(row => row.providers.join(' → ')), failures: result.failures.map(row => ({ providers: row.providers, code: row.code })) }));
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code ?? '') ? error.code : 'REQUEST_FAILED';
    samples.push({ name, amount, routeScope, error: code, firstCandidateRttMs, firstEligibleCandidateRttMs, fullRttMs: Math.round(performance.now() - started), arrivals });
    console.log(JSON.stringify({ name, error: code }));
  }
}
const report = { capturedAt: new Date().toISOString(), mode: 'READ_ONLY_PROGRESSIVE_SDK_QUOTES',
  interpretation: 'Sequential small samples, varying live markets and connection warmth. First candidate is a provisional preview, not necessarily eligible pricing. Completion means the bounded comparison ended, not all providers succeeded. No wallet actions or trade latency measurements.', samples };
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
