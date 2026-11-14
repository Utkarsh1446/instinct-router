/**
 * Collect dry 1Click quotes and unsigned Relay quotes for a fixed pair list.
 * Writes one dated JSON file. Does not sign, submit, or request a deposit address.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapabilityRegistry, DynamicRouter, createNearIntentsOneClickAdapter, createRelayAdapter } from '../packages/core/dist/index.js';
import { parseDecimalAmount, formatRawAmount } from '../examples/near-intents/units.js';
import { COMPARISON_POLICY, buildDocument, deriveWinner, explainPair } from './route-comparison-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ZERO = `0x${'0'.repeat(40)}`;
const SOL_NATIVE = '11111111111111111111111111111111';
const EVM_SENDER = '0x1111111111111111111111111111111111111111';
const EVM_RECIPIENT = '0x2222222222222222222222222222222222222222';
const SOL_SENDER = 'UESswspTzReuVj9qqKYGQc5yvjQYaTVb2QTGVhKDR8J';
const SOL_RECIPIENT = 'C3w7nDe5L3yhX5qsKhCY7Jx3V9XEatRquENUVfRVZXKR';
const NEAR_ACCOUNT = 'a'.repeat(64);
const RETRYABLE = new Set(['PROVIDER_RATE_LIMIT', 'PROVIDER_FETCH_OR_PARSE_FAILED', 'QUOTE_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'QUOTE_DEADLINE', 'PROVIDER_HTTP_ERROR']);

const chains = {
  ethereum: { chainId: 'eip155:1', blockchain: 'eth', name: 'Ethereum', relayChainId: 1, relayProtocolChainId: 'ethereum', confirmationMs: 12_000, family: 'evm' },
  base: { chainId: 'eip155:8453', blockchain: 'base', name: 'Base', relayChainId: 8453, relayProtocolChainId: 'base', confirmationMs: 2_000, family: 'evm' },
  arbitrum: { chainId: 'eip155:42161', blockchain: 'arb', name: 'Arbitrum', relayChainId: 42161, relayProtocolChainId: 'arbitrum', confirmationMs: 2_000, family: 'evm' },
  solana: { chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', blockchain: 'sol', name: 'Solana', relayChainId: 792703809, relayProtocolChainId: 'solana', confirmationMs: 2_000, family: 'solana' },
  near: { chainId: 'near:mainnet', blockchain: 'near', name: 'NEAR', confirmationMs: 2_000, family: 'near' },
};

const token = (chain, symbol, decimals, address, assetId) => ({ chain, symbol, decimals, address, assetId });
const assets = {
  eth: token('ethereum', 'ETH', 18, ZERO, 'nep141:eth.omft.near'),
  baseEth: token('base', 'ETH', 18, ZERO, 'nep141:base.omft.near'),
  arbEth: token('arbitrum', 'ETH', 18, ZERO, 'nep141:arb.omft.near'),
  ethUsdc: token('ethereum', 'USDC', 6, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near'),
  baseUsdc: token('base', 'USDC', 6, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'),
  arbUsdc: token('arbitrum', 'USDC', 6, '0xaf88d065e77c8cc2239327c5edb3a432268e5831', 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near'),
  ethUsdt: token('ethereum', 'USDT', 6, '0xdac17f958d2ee523a2206206994597c13d831ec7', 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near'),
  ethWbtc: token('ethereum', 'WBTC', 8, '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', 'nep141:eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near'),
  sol: token('solana', 'SOL', 9, SOL_NATIVE, 'nep141:sol.omft.near'),
  solUsdc: token('solana', 'USDC', 6, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near'),
  nearUsdc: token('near', 'USDC', 6, '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'),
};

const pair = (id, amount, source, destination, relay = true) => ({ id, amount, source, destination, relay });
const PAIRS = [
  pair('eth-ethereum-usdc-base', '0.05', assets.eth, assets.baseUsdc),
  pair('eth-ethereum-usdc-arbitrum', '0.05', assets.eth, assets.arbUsdc),
  pair('eth-ethereum-usdc-solana', '0.05', assets.eth, assets.solUsdc),
  pair('eth-ethereum-sol-solana', '0.02', assets.eth, assets.sol),
  pair('eth-base-usdc-ethereum', '0.02', assets.baseEth, assets.ethUsdc),
  pair('eth-arbitrum-usdc-base', '0.02', assets.arbEth, assets.baseUsdc),
  pair('usdc-ethereum-usdc-base', '100', assets.ethUsdc, assets.baseUsdc),
  pair('usdc-ethereum-usdc-arbitrum', '100', assets.ethUsdc, assets.arbUsdc),
  pair('usdc-ethereum-usdc-solana', '100', assets.ethUsdc, assets.solUsdc),
  pair('usdc-base-usdc-arbitrum', '100', assets.baseUsdc, assets.arbUsdc),
  pair('usdc-arbitrum-usdc-base', '100', assets.arbUsdc, assets.baseUsdc),
  pair('usdc-arbitrum-eth-ethereum', '80', assets.arbUsdc, assets.eth),
  pair('sol-solana-usdc-base', '0.4', assets.sol, assets.baseUsdc),
  pair('sol-solana-usdc-ethereum', '0.4', assets.sol, assets.ethUsdc),
  pair('usdc-solana-eth-ethereum', '40', assets.solUsdc, assets.eth),
  pair('usdt-ethereum-usdc-base', '100', assets.ethUsdt, assets.baseUsdc),
  pair('wbtc-ethereum-usdc-arbitrum', '0.001', assets.ethWbtc, assets.arbUsdc),
  pair('usdc-solana-eth-base', '40', assets.solUsdc, assets.baseEth),
  pair('eth-ethereum-usdc-near', '0.05', assets.eth, assets.nearUsdc, false),
  pair('usdc-base-usdc-near', '75', assets.baseUsdc, assets.nearUsdc, false),
];

function flag(name, fallback) {
  const found = process.argv.find(arg => arg.startsWith(`--${name}=`));
  return found ? Number(found.slice(name.length + 3)) : fallback;
}

function wallet(family) {
  if (family === 'evm') return { sender: EVM_SENDER, recipient: EVM_RECIPIENT };
  if (family === 'solana') return { sender: SOL_SENDER, recipient: SOL_RECIPIENT };
  return { sender: NEAR_ACCOUNT, recipient: NEAR_ACCOUNT };
}

function assetOf(endpoint) {
  return { chainId: chains[endpoint.chain].chainId, address: endpoint.address, decimals: endpoint.decimals };
}

function providerOf(pathId) {
  const text = decodeURIComponent(String(pathId));
  if (text.includes('near-intents-1click')) return 'near-intents-1click';
  if (text.includes('relay')) return 'relay';
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function quoteOnce(spec, amountRaw) {
  const sourceChain = chains[spec.source.chain];
  const destinationChain = chains[spec.destination.chain];
  const source = assetOf(spec.source);
  const destination = assetOf(spec.destination);
  const sender = wallet(sourceChain.family).sender;
  const recipient = wallet(destinationChain.family).recipient;
  const edge = (adapterId) => ({
    id: `${adapterId}:direct`, adapterId, source, destination, kind: 'SWAP_BRIDGE',
    validationTier: 'QUOTE_VALIDATED', executionTier: 'NONE', liquidity: 'UNKNOWN', validUntilMs: Date.now() + 600_000,
  });
  const capabilities = [edge('near-intents-1click')];
  const adapters = [createNearIntentsOneClickAdapter({
    chains: [sourceChain, destinationChain].map(chain => ({
      chainId: chain.chainId, blockchain: chain.blockchain,
      sourceConfirmationMs: chain.confirmationMs, destinationVerificationMs: chain.confirmationMs,
    })),
    assets: [
      { asset: source, assetId: spec.source.assetId },
      { asset: destination, assetId: spec.destination.assetId },
    ],
    fetch: (url, init) => fetch(url, init),
    dry: true,
  })];
  if (spec.relay) {
    capabilities.push(edge('relay'));
    adapters.push(createRelayAdapter({
      chains: [sourceChain, destinationChain].map(chain => ({
        chainId: chain.chainId, relayChainId: chain.relayChainId, relayProtocolChainId: chain.relayProtocolChainId,
        sourceConfirmationMs: chain.confirmationMs, destinationVerificationMs: chain.confirmationMs,
      })),
      fetch: (url, init) => fetch(url, init),
    }));
  }
  const request = {
    requestId: `cmp-${spec.id}-${Date.now()}`,
    source, destination, amountRaw, sender, recipient,
    slippageBps: COMPARISON_POLICY.slippageBps,
    maxFeeBps: COMPARISON_POLICY.maxFeeBps,
    maxPriceImpactBps: COMPARISON_POLICY.maxPriceImpactBps,
    maxCompletionMs: COMPARISON_POLICY.maxCompletionMs,
    deadlineMs: Date.now() + 60 * 60 * 1000,
    optimization: { objective: COMPARISON_POLICY.objective, maxOutputShortfallBps: COMPARISON_POLICY.maxOutputShortfallBps },
  };
  const result = await new DynamicRouter(new CapabilityRegistry(capabilities), adapters, {
    quoteBudgetMs: 10_000, providerTimeoutMs: 9_000, disablePreparation: true,
  }).quote(request);
  if (result.executionAuthorized !== false) throw new Error('EXECUTION_AUTHORIZED');
  return result;
}

function snapshotQuote(candidate, decimals) {
  const leg = candidate.legQuotes[0];
  const quote = {
    expectedOutRaw: candidate.expectedOutputRaw,
    minimumOutRaw: candidate.minimumOutputRaw,
    expectedOut: formatRawAmount(candidate.expectedOutputRaw, decimals),
    minimumOut: formatRawAmount(candidate.minimumOutputRaw, decimals),
    feeBps: candidate.feeBps,
    priceImpactBps: candidate.priceImpactBps,
    completionMs: candidate.completionMs,
  };
  if (leg.adapterId === 'near-intents-1click') {
    if (leg.dryQuote !== true || leg.dryDeposit?.depositAddress != null) throw new Error('DRY_QUOTE_REQUIRED');
    quote.dryQuote = true;
    quote.depositAddress = null;
    quote.quoteHash = leg.quoteHash;
    if (leg.amountInUsd) quote.amountInUsd = leg.amountInUsd;
    if (leg.amountOutUsd) quote.amountOutUsd = leg.amountOutUsd;
  }
  return quote;
}

function shape(spec, result) {
  const quotes = {};
  for (const candidate of result.candidates) {
    const provider = candidate.legQuotes[0]?.adapterId;
    if (provider !== 'near-intents-1click' && provider !== 'relay') continue;
    quotes[provider] = snapshotQuote(candidate, spec.destination.decimals);
  }
  const failures = [];
  for (const failure of result.failures) {
    const provider = providerOf(failure.pathId);
    if (!provider || quotes[provider]) continue;
    failures.push({ provider, code: failure.code });
  }
  const excluded = [];
  for (const row of result.excluded ?? []) {
    const provider = providerOf(row.id);
    if (!provider || !quotes[provider]) continue;
    excluded.push({ provider, reasons: [...row.reasons] });
  }
  const sourceChain = chains[spec.source.chain];
  const destinationChain = chains[spec.destination.chain];
  return {
    id: spec.id,
    label: `${spec.source.symbol} on ${sourceChain.name} → ${spec.destination.symbol} on ${destinationChain.name}`,
    amount: spec.amount,
    amountRaw: parseDecimalAmount(spec.amount, spec.source.decimals),
    sourceSymbol: spec.source.symbol,
    sourceChain: sourceChain.name,
    destinationSymbol: spec.destination.symbol,
    destinationChain: destinationChain.name,
    destinationDecimals: spec.destination.decimals,
    relayRegistered: spec.relay,
    quotedAt: new Date().toISOString(),
    quotes,
    failures,
    excluded,
    winner: result.winner?.legQuotes[0]?.adapterId ?? null,
    selectionReason: result.selectionReason,
  };
}

function shouldRetry(row) {
  return row.failures.some(failure => RETRYABLE.has(failure.code)) && Object.keys(row.quotes).length < (row.relayRegistered ? 2 : 1);
}

async function collectOne(spec) {
  const amountRaw = parseDecimalAmount(spec.amount, spec.source.decimals);
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await quoteOnce(spec, amountRaw);
      last = shape(spec, result);
      if (!shouldRetry(last) || attempt === 3) return last;
      const wait = last.failures.some(failure => failure.code === 'PROVIDER_RATE_LIMIT') ? 4000 * attempt : 1500 * attempt;
      console.error(`retry ${spec.id} attempt ${attempt} after ${last.failures.map(failure => failure.code).join(',')}`);
      await sleep(wait);
    } catch (error) {
      console.error(`skip ${spec.id} attempt ${attempt}: ${error?.code || error?.message || error}`);
      if (error?.message === 'DRY_QUOTE_REQUIRED') throw error;
      await sleep(1500 * attempt);
    }
  }
  return last;
}

const limit = flag('limit', PAIRS.length);
const minimum = flag('min', 10);
const selected = PAIRS.slice(0, Number.isInteger(limit) && limit > 0 ? limit : PAIRS.length);
const pairs = [];
for (const spec of selected) {
  console.error(`quoting ${spec.id}`);
  const row = await collectOne(spec);
  if (!row || Object.keys(row.quotes).length === 0) {
    console.error(`drop ${spec.id}: no quote`);
    await sleep(400);
    continue;
  }
  if (deriveWinner(row, COMPARISON_POLICY) !== row.winner) {
    throw new Error(`WINNER_MISMATCH ${spec.id} ranker=${row.winner} derived=${deriveWinner(row, COMPARISON_POLICY)}`);
  }
  const explained = explainPair(row, COMPARISON_POLICY);
  row.reasonCode = explained.reasonCode;
  row.why = explained.why;
  pairs.push(row);
  console.error(`kept ${spec.id} winner=${row.winner ?? 'none'} ${explained.reasonCode}`);
  await sleep(400);
}

const collectedAt = new Date().toISOString();
const { counts, summary } = buildDocument(pairs, collectedAt, COMPARISON_POLICY);
if (pairs.length < minimum) {
  console.error(summary);
  console.error(`only ${pairs.length} pairs; need ${minimum}`);
  process.exitCode = 1;
} else {
  const day = collectedAt.slice(0, 10);
  const document = {
    schemaVersion: 1,
    collectedAt,
    executionAuthorized: false,
    quoteMode: '1click-dry-and-relay-unsigned',
    oneClick: 'https://1click.chaindefuser.com/v0/quote',
    relay: 'https://api.relay.link/quote/v2',
    policy: COMPARISON_POLICY,
    counts,
    summary,
    pairs,
  };
  const directory = join(root, 'examples', 'near-intents', 'data');
  const target = join(directory, `route-comparison-${day}.json`);
  await mkdir(directory, { recursive: true });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`);
  await rename(temporary, target);
  console.log(target);
  console.log(summary);
}
