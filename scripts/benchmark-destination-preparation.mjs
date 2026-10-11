/** Controlled local latency fixture only. No endpoints, keys, wallets or trades. */
import { writeFile } from 'node:fs/promises';
import { CapabilityRegistry, DynamicRouter, QuoteScheduler, BASE_V3, createUniswapV3Adapter } from '../packages/core/dist/index.js';
const source = { chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
// Custom-token isolated-read path avoids treating fixture ABI data as live liquidity.
const middle = { chainId: BASE_V3.chainId, address: '0x' + '22'.repeat(20), decimals: 6 };
const destination = { chainId: BASE_V3.chainId, address: BASE_V3.native, decimals: 18 };
const delays = { directMs: 120, fastBridgeMs: 180, standardBridgeMs: 220, headerMs: 80, amountQuoteMs: 95 };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const word = value => BigInt(value).toString(16).padStart(64, '0');
const abi = (...values) => '0x' + values.map(word).join('');
const edge = (id, adapterId, from, to, kind) => ({ id, adapterId, source: from, destination: to, kind,
  validationTier: 'QUOTE_VALIDATED', executionTier: 'NONE', liquidity: 'UNKNOWN', validUntilMs: Date.now() + 60000 });
async function run(disablePreparation) {
  let headerReads = 0, amountRounds = 0, amountSimulations = 0, firstCandidateMs = null;
  const expectedInputFloors = [], observedQuoteInputs = [];
  const request = { requestId: 'controlled-preparation', source, destination, amountRaw: '1000000', sender: 'publicSolWallet',
    recipient: '0x' + '11'.repeat(20), slippageBps: 50, maxFeeBps: 1000, maxPriceImpactBps: 1000,
    maxCompletionMs: 400000, deadlineMs: Date.now() + 60000, optimization: { objective: 'BALANCED', maxOutputShortfallBps: 50 } };
  const fixedQuote = (ctx, out) => ({ capabilityId: ctx.leg.capabilityId, adapterId: ctx.leg.adapterId,
    source: ctx.leg.source, destination: ctx.leg.destination, amountInRaw: ctx.amountRaw, expectedOutRaw: out,
    minimumOutRaw: out, feeBps: 10, priceImpactBps: 10, estimatedCompletionMs: 30000,
    costDenominator: { source: ctx.request.source, amountRaw: ctx.request.amountRaw }, expiresAtMs: ctx.deadlineMs,
    quoteId: `fixture:${ctx.leg.adapterId}:${ctx.amountRaw}`, conditional: true, liquidityConfirmed: true });
  const adapters = [
    { id: 'direct-control', quote: async ctx => { await pause(delays.directMs); return fixedQuote(ctx, '980000000000000'); } },
    ...[['fast', delays.fastBridgeMs, '995000'], ['standard', delays.standardBridgeMs, '990000']].map(([id, delay, output]) => ({
      id, quote: async ctx => { await pause(delay); expectedInputFloors.push(output); return fixedQuote(ctx, output); },
    })),
    createUniswapV3Adapter({ estimatedCompletionMs: 30000, fetch: async (_fixedUrl, init) => {
      const calls = JSON.parse(init.body);
      const header = calls[0].method === 'eth_chainId';
      if (header) { headerReads++; await pause(delays.headerMs); } else { amountRounds++; await pause(delays.amountQuoteMs); }
      return new Response(JSON.stringify(calls.map(call => {
        let result;
        if (call.method === 'eth_chainId') result = '0x2105';
        else if (call.method === 'eth_getBlockByNumber') result = { number: '0x1234', hash: '0x' + '12'.repeat(32), timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) };
        else {
          const data = call.params[0].data;
          if (data === '0x313ce567') result = abi(call.params[0].to === middle.address ? 6 : 18);
          else if (data.startsWith('0x1698ee82')) result = abi(1);
          else {
            const amount = BigInt('0x' + data.slice(138, 202)), fee = BigInt('0x' + data.slice(202, 266));
            amountSimulations++; if (fee === 500n) observedQuoteInputs.push(amount.toString());
            result = abi(amount * (fee === 500n ? 1000000000n : 900000000n), 1n << 96n, 0, 40000);
          }
        }
        return { jsonrpc: '2.0', id: call.id, result };
      })));
    } }),
  ];
  const registry = new CapabilityRegistry([edge('direct', 'direct-control', source, destination, 'SWAP_BRIDGE'),
    edge('fast', 'fast', source, middle, 'BRIDGE'), edge('standard', 'standard', source, middle, 'BRIDGE'),
    edge('destination', 'uniswap-v3', middle, destination, 'SWAP')]);
  const started = performance.now();
  const result = await new DynamicRouter(registry, adapters, { planner: { intermediates: [middle] },
    quoteBudgetMs: 2000, providerTimeoutMs: 1000, scheduler: new QuoteScheduler({ maxConcurrency: 4 }), disablePreparation }).quote(request,
    { onCandidate() { firstCandidateMs ??= performance.now() - started; } });
  if (result.failures.length || result.candidates.length !== 3) throw new Error('Fixture comparison did not complete');
  return { responseMs: +(performance.now() - started).toFixed(3), firstCandidateMs: +firstCandidateMs.toFixed(3),
    headerReads, amountRounds, amountSimulations, expectedInputFloors: expectedInputFloors.sort(), observedQuoteInputs: observedQuoteInputs.sort(),
    candidates: result.candidates.map(candidate => ({ id: candidate.id, minimumOutputRaw: candidate.minimumOutputRaw,
      executionReady: candidate.executionReady, conditional: candidate.conditional, feeBps: candidate.feeBps, priceImpactBps: candidate.priceImpactBps })) };
}
const samples = [];
for (let i = 0; i < 5; i++) {
  const before = await run(true), after = await run(false);
  if (JSON.stringify(before.candidates) !== JSON.stringify(after.candidates)) throw new Error('Preparation changed candidate economics');
  if (before.headerReads !== 2 || after.headerReads !== 1 || before.amountRounds !== 2 || after.amountRounds !== 2 ||
    JSON.stringify(after.observedQuoteInputs) !== JSON.stringify(after.expectedInputFloors)) throw new Error('Fixture preparation/read-count invariant failed');
  samples.push({ before, after });
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const beforeMedianMs = median(samples.map(row => row.before.responseMs)), afterMedianMs = median(samples.map(row => row.after.responseMs));
const report = { basis: 'CONTROLLED_LOCAL_LATENCY_FIXTURE_NOT_LIVE_SETTLEMENT', capturedAt: new Date().toISOString(),
  delays, schedulerConcurrency: 4, comparisons: samples.length, beforeMedianMs, afterMedianMs,
  reductionMs: +(beforeMedianMs - afterMedianMs).toFixed(3), reductionPercent: +((beforeMedianMs - afterMedianMs) / beforeMedianMs * 100).toFixed(2),
  invariant: 'Same final output floors/costs; two fresh amount-dependent quotes; header reads 2 to 1; no signing or execution', samples };
const json = JSON.stringify(report, null, 2) + '\n';
if (process.argv[2]) await writeFile(process.argv[2], json, { flag: 'wx' });
console.log(json);
