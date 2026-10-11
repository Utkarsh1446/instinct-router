/** Opt-in public read-only probe; no wallet, journal, signature or broadcast. */
import { readFile, writeFile } from 'node:fs/promises';
import { readOwnedJson } from './config.mjs';
import { createExecutionEngine } from '@instinct/router-engine';

const sender = process.env.ROUTER_TEST_SENDER, recipient = process.env.ROUTER_TEST_RECIPIENT;
const noPresetLimits = process.env.ROUTER_TEST_NO_PRESET_LIMITS === '1';
const reviewDelayMs = Number(process.env.ROUTER_TEST_REVIEW_DELAY_MS ?? 0);
if (!Number.isSafeInteger(reviewDelayMs) || reviewDelayMs < 0 || reviewDelayMs > 30000)
  throw Error('ROUTER_TEST_REVIEW_DELAY_MS must be between 0 and 30000.');
if (!/^0x[0-9a-fA-F]{40}$/.test(sender ?? '') || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(recipient ?? ''))
  throw Error('Supply public ROUTER_TEST_SENDER (Base) and ROUTER_TEST_RECIPIENT (Solana).');
const executionPins = await readOwnedJson(process.env.ROUTER_EXECUTION_PINS_FILE ?? './config/base-execution-pins.json');
const rpcEndpoints = await readOwnedJson(process.env.ROUTER_EXECUTION_RPC_FILE ?? './.dev/execution-rpc.json');
const input = { source: { chainId: 'eip155:8453', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
  destination: { chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  sender, recipient, slippageBps: 50, maxFeeBps: noPresetLimits ? null : 500, maxPriceImpactBps: 500,
  nativeFeeBudgets: [{ chainId: 'eip155:8453', maxAmountRaw: noPresetLimits ? null : '20000000000000' }] };
const reportPath = './docs/validation/2026-10-10-base-usdc-solana-readiness.json';
let report;
try { report = JSON.parse(await readFile(reportPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
report ??= { scope: 'READ_ONLY_LIVE_USDC_PREPARATION', transactionSubmitted: false, tradeRttMs: null, samples: [] };
for (const amount of process.argv.slice(2).length ? process.argv.slice(2) : ['0.1', '1']) {
  const calls = [];
  const wire = async (url, init) => {
    const rows = init?.body ? JSON.parse(init.body) : [];
    const batch = Array.isArray(rows) ? rows : [rows];
    if (batch.some(row => typeof row.method === 'string' && /send|sign/i.test(row.method))) throw Error('Signing and broadcasting are forbidden in this probe.');
    const start = performance.now();
    try { return await fetch(url, init); }
    finally { calls.push({ host: new URL(url).host, methods: batch.map(row => row.method ?? 'quote'), elapsedMs: Math.round(performance.now() - start) }); }
  };
  const engine = createExecutionEngine({ executionPins, rpcEndpoints, fetch: wire });
  const start = performance.now(), row = { checkedAt: new Date().toISOString(), sender, recipient, amount, maxFeeBps: input.maxFeeBps,
    nativeFeeBudgets: input.nativeFeeBudgets };
  try {
    const prepared = await engine.prepare({ ...input, amount });
    const plan = await engine.recipes.find(recipe => recipe.id === prepared.candidate.legQuotes[0].executableRecipeId).verify(prepared.request, prepared.candidate);
    Object.assign(row, { outcome: 'READY_FOR_USER_REVIEW', prepareAndPreflightMs: Math.round(performance.now() - start),
      expectedOutRaw: prepared.candidate.expectedOutputRaw, minimumOutRaw: plan.minimumOutRaw, feeBps: prepared.candidate.feeBps,
      nativeCosts: plan.nativeCosts, reviewRemainingMs: plan.expiresAtMs - Date.now(),
      actions: plan.actions.map(action => ({ id: action.id, to: action.payload.transaction.to, selector: action.payload.transaction.data.slice(0,10),
        nativeValue: action.payload.transaction.value, gas: action.payload.transaction.gas, nativeFeeCapRaw: action.payload.nativeFeeCapRaw })),
      depositSimulation: plan.actions.length > 1 ? 'Deferred until actual allowance exists; deposit claim requires actual RPC simulation' : 'Actual allowance and wallet simulation verified' });
    if (reviewDelayMs) {
      await new Promise(resolve => setTimeout(resolve, reviewDelayMs));
      const recheckStarted = performance.now();
      try {
        const evidence = await engine.verifier.preflight(plan, plan.actions[0]);
        row.reviewRecheck = {outcome:'READY',delayMs:reviewDelayMs,elapsedMs:Math.round(performance.now()-recheckStarted),
          freshReserveRaw:evidence.nativeFeeReserveRaw,reviewedReserveRaw:plan.nativeCosts[0].amountRaw};
      } catch (error) {
        row.reviewRecheck = {outcome:'BLOCKED',code:error.code ?? error.name,delayMs:reviewDelayMs,elapsedMs:Math.round(performance.now()-recheckStarted)};
      }
    }
  } catch (error) { Object.assign(row, { outcome: 'BLOCKED', code: error.code ?? error.name,
    ...(error.economicLimits ? { economicLimits: error.economicLimits } : {}), elapsedMs: Math.round(performance.now() - start) }); }
  console.log(JSON.stringify(row)); row.calls = calls; report.samples.push(row);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
