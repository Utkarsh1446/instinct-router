export type Asset = { chainId: string; address: string; decimals: number };
export interface QuoteInput {
  source: Asset; destination: Asset; amount: string; sender: string; recipient: string;
  slippageBps?: number; objective?: 'BALANCED' | 'FASTEST' | 'BEST_OUTPUT';
  maxOutputShortfallBps?: number;
  /** Null disables the user's fee ceiling; fees must still be known and reviewed. */
  maxFeeBps?: number | null; maxPriceImpactBps?: number;
  routeScope?: 'ALL' | 'INDEPENDENT';
}
export interface InspectionInput {
  source: Asset; destination: Asset; amount: string; sender: string; recipient: string; slippageBps?: number;
}
export interface QuoteService {
  config(): Record<string, unknown>;
  resolveAsset(input: { chainId: string; address: string }, signal?: AbortSignal): Promise<Record<string, unknown>>;
  quote(input: QuoteInput, signal?: AbortSignal, onCandidate?: (candidate: Record<string, unknown>) => void): Promise<Record<string, unknown>>;
  inspectExecution(input: InspectionInput, signal?: AbortSignal): Promise<Record<string, unknown>>;
}
/** Pricing mappings only. These never supply RPC endpoints or execution pins. */
export interface QuoteCatalogChain {
  id: string; name: string; chainId: string; relayChainId: number; relayProtocolChainId: string;
}
export interface QuoteCatalogAsset extends Asset {
  id: string; symbol: string; native: boolean; decimalsSource: 'PROVIDER_CATALOG';
}
export interface QuoteCatalog {
  additionalChains: readonly QuoteCatalogChain[];
  additionalAssets: readonly QuoteCatalogAsset[];
}
export interface EngineOptions {
  providerKeys?: { RELAY_API_KEY?: string; AURORA_API_KEY?: string };
  fetch?: typeof globalThis.fetch; now?: () => number;
  resolveAsset?: (input: { chainId: string; address: string }, signal?: AbortSignal) => Promise<Record<string, unknown>>;
  auroraPolicy?: { feeRecipient?: string; referral?: string; tokenFeeBps?: number; nativeFeeBps?: number };
  chainTiming?: Record<string, { sourceConfirmationMs?: number; destinationVerificationMs?: number }>;
  /** Opt in to direct DEX pricing and conditional DEX-CCTP composition. */
  independentRoutes?: boolean;
  /** Public development estimates only; unknown full costs cannot win. */
  debridgeRoutes?: boolean;
  /** Validated operator-owned EVM pricing mappings; original pinned identities remain fixed. */
  additionalChains?: readonly QuoteCatalogChain[];
  /** Provider catalog suggestions; token discovery never grants wallet execution. */
  additionalAssets?: readonly QuoteCatalogAsset[];
}
export class ServiceError extends Error { code: string; status: number; constructor(code: string, message?: string, status?: number) }
export function createQuoteService(options?: EngineOptions): QuoteService;
export function discoverQuoteCatalog(options?: Pick<EngineOptions, 'fetch' | 'providerKeys' | 'now'>): Promise<QuoteCatalog>;

export interface ExecutionContractPin { codeSha256: string; implementation?: { slot: string; address: string; codeSha256: string } }
/** Operator-trusted deployment metadata. RFQs and API callers cannot choose RPCs or contracts. */
export interface ProviderExecutionChain {
  chainId: string; providerChainId: number; protocolChainId: string; vm: 'EVM' | 'SOLANA'; rpcUrl: string;
  nativeCurrency: { address: string; decimals: number; symbol: string };
  contracts: Partial<Record<'multicall3'|'multicaller'|'onlyOwnerMulticaller'|'relayReceiver'|'erc20Router'|'approvalProxy',string>>;
  depository?: string; solverAddresses: string[]; confirmations: 1 | 12;
  feeModel: 'STANDARD' | 'OPSTACK' | 'PROVIDER_ESTIMATE'; gasOracle?: string;
}
export function discoverProviderExecutionChains(options?: { fetch?: typeof globalThis.fetch; rpcOverrides?: Record<string,string>; feeModels?: Record<string,'STANDARD'|'OPSTACK'|'PROVIDER_ESTIMATE'>; signal?: AbortSignal }): Promise<ProviderExecutionChain[]>;
export function validateProviderExecutionChains(chains: readonly ProviderExecutionChain[]): ProviderExecutionChain[];
export function providerExecutionChainsFromCatalog(catalog: unknown, options?: {rpcOverrides?: Record<string,string>; feeModels?: Record<string,'STANDARD'|'OPSTACK'|'PROVIDER_ESTIMATE'>}): ProviderExecutionChain[];
export interface ExecutionEngineOptions extends EngineOptions {
  /** Requires executionPins.providerManaged.enabled. Official Relay construction/status trust is explicit. */
  providerExecutionChains?: readonly ProviderExecutionChain[];
  executionPins?: { providerManaged?: { enabled: boolean }; solanaRelay?: {solver:string;program:{address:string;owner:string;codeSha256:string;programData:{address:string;codeSha256:string}};config:{address:string;owner:string;allocator:string};vault:string}; base?: { weth: ExecutionContractPin; usdc: ExecutionContractPin; oracle: ExecutionContractPin; factory: ExecutionContractPin }; relay?: {depository:{codeSha256:string;owner:string;allocator:string};solver:string;solanaSolverSigners:readonly string[]} };
  /** Trusted server configuration only. Whole checks use one endpoint; no mixed snapshots. */
  rpcEndpoints?: { base?: readonly string[]; solana?: readonly [string] };
}
export interface ExecutionPrepareInput extends QuoteInput {
  /** Null selects a fresh finite reviewed reserve without a preset user ceiling. */
  nativeFeeBudgets: readonly { chainId: string; maxAmountRaw: string | null }[];
}
export interface ExecutionEngine {
  prepare(input: ExecutionPrepareInput, signal?: AbortSignal): Promise<{request: import('@instinct/router-core').RouterRequest; candidate: import('@instinct/router-core').RouteCandidate}>;
  readonly recipes: readonly import('@instinct/router-core').ExecutionRecipe[];
  readonly verifier: import('@instinct/router-core').ExecutionVerifier;
  capabilities(): Record<string, unknown>;
  preflight(record: import('@instinct/router-core').ExecutionRecord, signal?: AbortSignal): Promise<{ready:boolean}>;
  verify(record: import('@instinct/router-core').ExecutionRecord, txHash: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
}
export function createExecutionEngine(options?: ExecutionEngineOptions): ExecutionEngine;
export class ExecutionEngineError extends Error {
  code: string; status: number;
  readonly economicLimits?: Readonly<{ feeBps: number; maxFeeBps: number | null; priceImpactBps: number; maxPriceImpactBps: number }>;
  /** Display-only evidence; never authorizes completion or another wallet action. */
  readonly progress?: Readonly<SettlementProgress>;
}
export interface SettlementProgress {
  routeId: string; actionId: string; sourceTransactionHash: string;
  stage: 'SOURCE_CONFIRMED' | 'DESTINATION_CONFIRMED'; observedAtMs: number;
  sourceConfirmations: number; requiredSourceConfirmations: 1 | 12;
  destination?: { chainId: string; transactionHash: string; asset: Asset; recipient: string;
    amountRaw: string; commitment: 'confirmed' | 'finalized' | 'canonical' };
}

export function createAssetBalanceReader(options:{chains:readonly {chainId:string;vm:'EVM'|'SOLANA';rpcUrl:string;rpcUrls?:readonly string[];nativeCurrency:{address:string;decimals:number}}[];fetch?:typeof fetch;now?:()=>number;timeoutMs?:number}):{getAssetBalance(input:{chainId:string;address:string;owner:string},signal?:AbortSignal):Promise<{chainId:string;address:string;owner:string;decimals:number;balanceRaw:string;observedAtMs:number}>};
