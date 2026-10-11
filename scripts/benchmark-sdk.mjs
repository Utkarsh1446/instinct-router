/** Local deterministic fixtures only: no provider network calls or wallet actions. */
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createMetadataResolver } from '../packages/engine/src/metadata.mjs';
import { createQuoteService } from '@instinct/router-engine';
import { createRouterApi } from '@instinct/router-server';
import { createRouterServerClient } from '@instinct/router-sdk/server';
import { fixtureWire, input, SOL } from '../tests/fixtures/provider.mjs';

const round = value => Math.round(value * 100) / 100;
const reportPath = process.argv[2];
const report = reportPath ? JSON.parse(await readFile(reportPath, 'utf8')) : {};
const asset = { chainId: SOL, address: 'F6EDRhRzXGmkBabhSHdAnqx26XLhG6NCa83wwuqFpump' };
let rpcCalls = 0;
const resolver = createMetadataResolver({ fetch: async () => {
  rpcCalls++;
  await new Promise(resolve => setTimeout(resolve, 35));
  return new Response(JSON.stringify([
    { jsonrpc: '2.0', id: 1, result: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' },
    { jsonrpc: '2.0', id: 2, result: { context: { slot: 123 }, value: {
      owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', executable: false,
      data: { program: 'spl-token', parsed: { type: 'mint', info: { isInitialized: true, decimals: 6 } } },
    } } },
  ]));
} });
const started = performance.now();
const requests = await Promise.allSettled(Array.from({ length: 12 }, () => resolver.resolveAsset(asset)));
report.afterMetadataBurst = { requests: requests.length, rpcCalls,
  succeeded: requests.filter(row => row.status === 'fulfilled').length,
  failed: requests.filter(row => row.status === 'rejected').length,
  elapsedMs: round(performance.now() - started), mode: 'DETERMINISTIC_DELAYED_RPC_FIXTURE', fixtureDelayMs: 35 };

const calls = [], apps = [{ id: 'benchmark', serverKey: 'server_fixture_benchmark', publishableKey: 'public_fixture_benchmark',
  allowedOrigins: ['https://benchmark.example'], rateLimitPerMinute: 1000, maxConcurrent: 2 }];
const service = createQuoteService({ fetch: fixtureWire({ calls }) });
const api = createRouterApi({ service, apps });
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
try {
  const client = createRouterServerClient({ baseUrl: 'http://127.0.0.1:' + api.address().port, serverKey: apps[0].serverKey });
  const samples = [];
  for (let index = 0; index < 35; index++) {
    const start = performance.now();
    const quote = await client.quote(input);
    if (!quote.winner) throw new Error('Fixture pricing has no winner.');
    samples.push({ totalMs: round(performance.now() - start), engineMs: quote.serviceRttMs, providerMs: quote.quoteRttMs });
  }
  const values = samples.slice(5).map(row => row.totalMs).sort((a, b) => a - b);
  report.localSdkApiOverhead = { mode: 'LOOPBACK_HTTP_WITH_IN_MEMORY_PROVIDER_FIXTURE', requests: samples.length,
    warmupRequests: 5, measuredRequests: values.length, coldFirstMs: samples[0].totalMs,
    p50Ms: values[Math.ceil(values.length * 0.5) - 1], p95Ms: values[Math.ceil(values.length * 0.95) - 1],
    minMs: values[0], maxMs: values.at(-1), samples,
    providerCalls: { relayQuotes: calls.filter(call => call.url.includes('relay.link')).length,
      cctpFeeMatrices: calls.filter(call => call.url.includes('/fees/')).length,
      cctpFastAllowances: calls.filter(call => call.url.includes('/allowance')).length },
    interpretation: 'Combined SDK validation, loopback HTTP, API and engine with immediate provider fixtures. Excludes real provider network latency and trade settlement.' };
} finally { api.close(); api.closeAllConnections(); }
report.benchmarkedAt = new Date().toISOString();
report.runtime = process.version;
if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ beforeMetadataBurst: report.beforeMetadataBurst, afterMetadataBurst: report.afterMetadataBurst,
  localSdkApiOverhead: { ...report.localSdkApiOverhead, samples: undefined }, benchmarkedAt: report.benchmarkedAt, runtime: report.runtime }, null, 2));
