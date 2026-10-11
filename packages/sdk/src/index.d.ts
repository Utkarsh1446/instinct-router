import type { WalletAccount, WalletChallenge, WalletSession, WalletRequestOptions, ExecutionInput, ExecutionResponse, ClaimResponse, ExecutionWatchOptions, ExecutionWatchResult } from './execution.js';
export * from './execution.js';
export const API_VERSION: '1';
export type ChainId = `eip155:${string}` | `solana:${string}`;
export type Objective = 'BALANCED' | 'FASTEST' | 'BEST_OUTPUT';
export interface Asset { readonly chainId: ChainId; readonly address: string; readonly decimals: number }
export interface AssetBalanceInput { readonly chainId:ChainId; readonly address:string; readonly owner:string }
export interface AssetBalanceResponse extends ApiEnvelope, AssetBalanceInput {readonly decimals:number;readonly balanceRaw:string;readonly observedAtMs:number}
export interface AssetLookup { readonly chainId: ChainId; readonly address: string }
export interface QuoteRequest {
  readonly source: Asset;
  readonly destination: Asset;
  /** Positive plain decimal string in source token units; never a JS number. */
  readonly amount: string;
  readonly sender: string;
  readonly recipient: string;
  readonly slippageBps?: number;
  readonly objective?: Objective;
  readonly maxOutputShortfallBps?: number;
  readonly maxFeeBps?: number | null;
  readonly maxPriceImpactBps?: number;
  /** INDEPENDENT excludes Relay/Aurora; requires server opt-in. Pricing only. */
  readonly routeScope?: 'ALL' | 'INDEPENDENT';
}
export interface RequestOptions { readonly signal?: AbortSignal; readonly timeoutMs?: number; readonly idempotencyKey?: string }
export interface ProvisionalQuoteMetadata {
  readonly requestId: string; readonly appId: string; readonly sequence: number;
  readonly provisional: true; readonly comparisonComplete: false; readonly readOnly: true; readonly executionReady: false;
}
export interface QuoteStreamOptions {
  readonly signal?: AbortSignal; readonly timeoutMs?: number;
  /** Awaited for backpressure; receives a detached candidate, never a selected winner or trade authorization. */
  readonly onCandidate?: (candidate: Candidate, metadata: ProvisionalQuoteMetadata) => void | Promise<void>;
}
export interface ClientOptions {
  readonly baseUrl: string;
  /** Public, origin-scoped app identifier. Never a provider key or server secret. */
  readonly publishableKey: string;
  /** Must return a standard streaming Response; buffered response shims are rejected. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}
export interface ApiEnvelope { readonly apiVersion: '1'; readonly requestId: string }
export interface ExecutionUnavailable { readonly enabled: false; readonly reason?: string }
export interface ConfigAsset extends Asset {
  readonly id?: string; readonly symbol?: string; readonly name?: string; readonly native?: boolean;
  readonly decimalsSource?: string; readonly metadataVerified?: boolean;
}
export interface AssetResponse extends ApiEnvelope, ConfigAsset { readonly metadataVerified: true; readonly tokenProgram?: string }
export interface Provider {
  readonly id: string; readonly name: string; readonly available?: boolean; readonly enabled?: boolean; readonly reason?: string | null;
  readonly quoteMode?: 'DRY_PREVIEW' | 'PROTOCOL_PRICING' | 'PROVIDER_QUOTE' | 'DEX_PREVIEW';
  readonly fullCostVerification?: 'PROVIDER_FIELDS_REQUIRED' | 'NOT_CONFIGURED';
  readonly chainIds?: readonly ChainId[];
  readonly exactAssets?: readonly Asset[];
  readonly nativeAssetPins?: readonly Asset[];
}
export interface ChainConfig {
  readonly id?: string; readonly name?: string; readonly chainId: ChainId;
  readonly nativeCurrency?: {readonly decimals:number;readonly symbol:string;readonly name?:string};
  /** Configured policy values, not measured settlement durations. */
  readonly sourceConfirmationMs?: number | null; readonly destinationVerificationMs?: number | null;
  readonly timingBasis?: 'CONFIGURED_UNMEASURED_POLICY' | 'UNKNOWN';
}
export interface AssetClass {
  readonly id: 'token' | 'tokenized_stock' | 'broker_stock' | 'prediction_position';
  readonly pricing: boolean | 'BY_ONCHAIN_ASSET_AND_LIQUIDITY';
  readonly execution: false;
  readonly reason?: string;
}
export interface VenueCapability { readonly id: string; readonly enabled: boolean; readonly reason?: string }
export interface ExecutionProfile { readonly recipeId:string; readonly sourceChainId?:string; readonly destinationChainId?:string; readonly sourceChainIds?:readonly string[]; readonly destinationChainIds?:readonly string[]; readonly verification?:'PROVIDER_MANAGED'; readonly sourceAssetTypes:readonly ('NATIVE'|'ERC20'|'SPL')[]; readonly destinationAssetTypes:readonly ('NATIVE'|'ERC20'|'SPL')[]; readonly requiresFreshValidation:true }
export interface ExecutionCapability { readonly enabled: boolean; readonly reason?: string | null; readonly executionProfiles?: readonly ExecutionProfile[]; readonly supportedRoutes?: readonly {readonly source:Asset; readonly destination:Asset}[] }
export interface ConfigResponse extends ApiEnvelope {
  readonly version?: number;
  readonly readOnly: true;
  readonly chains: readonly ChainConfig[];
  readonly assets: readonly ConfigAsset[];
  readonly providers: readonly Provider[];
  readonly execution: ExecutionCapability | false;
  readonly assetClasses?: readonly AssetClass[];
  readonly venues?: readonly VenueCapability[];
  readonly defaults?: Partial<QuoteRequest>;
  readonly unknownTokenPolicy?: string;
  readonly timingBasis?: string;
  readonly capabilities?: { readonly pricing: boolean; readonly walletExecution: boolean; readonly providerDiscoveryIsAuthorization?: false; readonly independentRoutes?: boolean; readonly debridgeRoutes?: boolean; readonly executionInspection?: boolean };
}
export interface CapabilitiesResponse extends ApiEnvelope {
  readonly execution: ExecutionCapability | false;
  readonly assetClasses?: readonly AssetClass[];
  readonly venues?: readonly VenueCapability[];
  readonly providers?: readonly Provider[];
  readonly readOnly?: true;
  readonly capabilities?: { readonly pricing: boolean; readonly walletExecution: boolean; readonly providerDiscoveryIsAuthorization?: false; readonly independentRoutes?: boolean; readonly debridgeRoutes?: boolean; readonly executionInspection?: boolean };
}
export interface Candidate {
  readonly id: string; readonly provider?: string; readonly providerName?: string; readonly providers: readonly string[];
  readonly expectedOutputRaw: string; readonly minimumOutputRaw: string;
  readonly feeBps: number | null; readonly priceImpactBps: number | null; readonly protocolFeeBps?: number | null;
  readonly estimatedCompletionMs?: number | null; readonly protocolEstimateMs?: number | null;
  readonly executionReady: false; readonly conditional: boolean; readonly eligible: boolean;
  readonly quotedAtMs?: number; readonly deadlineMs?: number; readonly validUntilMs?: number;
  readonly validationTier?: 'UNVERIFIED' | 'QUOTE_VALIDATED' | 'EXECUTION_VALIDATED'; readonly timingBasis?: string;
  readonly routeKind?: 'DIRECT' | 'COMPOSED';
  readonly routingFamily?: 'AGGREGATOR' | 'INDEPENDENT';
  readonly steps?: readonly QuoteStep[];
}
export interface QuoteStep {
  readonly provider: string; readonly kind: 'SWAP' | 'BRIDGE' | 'SWAP_BRIDGE';
  readonly source: Asset; readonly destination: Asset;
  readonly amountInRaw: string; readonly expectedOutputRaw: string; readonly minimumOutputRaw: string;
  readonly requiresRequoteAfterSettlement: boolean; readonly conditional: boolean; readonly executionReady: false;
}
export interface ExcludedRoute { readonly id: string; readonly reasons: readonly string[]; readonly provider?: string; readonly providerName?: string; readonly providers?: readonly string[] }
export interface FailedRoute { readonly id: string; readonly code: string; readonly provider?: string; readonly providerName?: string; readonly providers?: readonly string[] }
export interface ProviderTiming {
  readonly provider: string; readonly providerName?: string;
  /** Adapter operation only; preparation can overlap another provider. Do not sum as route RTT. Older servers omit phase. */
  readonly phase?: 'PREPARATION' | 'QUOTE';
  readonly rttMs: number; readonly outcome: string;
}
export interface QuoteResponse extends ApiEnvelope {
  readonly quoteId: string;
  /** Ownership is derived from authentication by the server. */
  readonly appId: string;
  readonly request: QuoteRequest;
  readonly readOnly: true;
  readonly execution: ExecutionUnavailable | false;
  readonly winner: string | null;
  readonly candidates: readonly Candidate[];
  readonly excluded: readonly ExcludedRoute[];
  readonly failures: readonly FailedRoute[];
  readonly providerTimings: readonly ProviderTiming[];
  readonly quoteRttMs: number;
  /** Metadata resolution plus provider RFQ work measured on the service. */
  readonly serviceRttMs?: number;
  readonly comparisonComplete: boolean;
  readonly quotedAtMs?: number;
  /** Selected pricing cutoff; if no winner, latest preview cutoff. Individual candidate expiries still apply. */
  readonly validUntilMs?: number | null;
  readonly timingBasis?: string;
  readonly costBasis?: string;
  readonly snapshotExpiresAtMs?: number;
  readonly requestHash?: string;
  readonly routeScope?: 'ALL' | 'INDEPENDENT';
}
export interface InspectionRequest {
  readonly source: Asset; readonly destination: Asset; readonly amount: string;
  readonly sender: string; readonly recipient: string; readonly slippageBps?: number;
}
export interface InspectionFees {
  readonly complete: boolean; readonly estimateOnly: true;
  readonly gasEstimateRaw: string | null; readonly gasLimitRaw: string | null;
  readonly maxFeePerGasRaw: string | null; readonly maxPriorityFeePerGasRaw: string | null;
  readonly l2BudgetRaw: string | null; readonly l1FeeUpperBoundRaw: string | null; readonly l1BudgetRaw: string | null;
  readonly operatorFeeBudgetRaw: string | null; readonly totalNativeBudgetRaw: string | null; readonly balanceRaw: string | null;
}
export interface InspectionResponse extends ApiEnvelope {
  readonly appId: string; readonly request: InspectionRequest; readonly amountRaw: string;
  readonly status: 'READY_FOR_REVIEW' | 'BLOCKED'; readonly readOnly: true; readonly executionReady: false;
  readonly requiresWalletSignature: true; readonly transactionPrepared: boolean;
  readonly checkedAtMs: number; readonly validUntilMs: number; readonly inspectionRttMs: number;
  readonly quote: { readonly expectedOutputRaw: string; readonly minimumOutputRaw: string; readonly pricingValidUntilMs: number } | null;
  readonly fees: InspectionFees | null; readonly evidence: Readonly<Record<string, unknown>> | null;
  readonly blockers: readonly { readonly code: string; readonly message: string }[];
  readonly execution: ExecutionUnavailable;
}
export interface PrepareRequest { readonly quoteId: string; readonly candidateId?: string }
export interface PrepareResponse extends ApiEnvelope {
  readonly quoteId: string; readonly appId: string; readonly execution: ExecutionUnavailable | false;
}
export class RouterSdkError extends Error {
  readonly code: string; readonly status: number | null; readonly requestId: string | null;
  readonly retryable: boolean; readonly retryAfterMs?: number;
  constructor(code: string, message: string, details?: { status?: number; requestId?: string; retryable?: boolean; retryAfterMs?: number });
}
export interface RouterClient {
  getConfig(options?: RequestOptions): Promise<ConfigResponse>;
  getCapabilities(options?: RequestOptions): Promise<CapabilitiesResponse>;
  getAssetBalance(input: AssetBalanceInput, options?: RequestOptions): Promise<AssetBalanceResponse>;
  resolveAsset(input: AssetLookup, options?: RequestOptions): Promise<AssetResponse>;
  quote(input: QuoteRequest, options?: RequestOptions): Promise<QuoteResponse>;
  /** Delivers provisional candidates; resolves only after a validated final snapshot and clean EOF. No idempotency or automatic retries. */
  quoteStream(input: QuoteRequest, options?: QuoteStreamOptions): Promise<QuoteResponse>;
  /** Retrieve the same app-owned snapshot; this never requests a fresh quote. */
  getQuote(quoteId: string, options?: RequestOptions): Promise<QuoteResponse>;
  /** Fresh read-only Base ETH to USDC check; returns no signing artifacts. */
  inspectExecution(input: InspectionRequest, options?: RequestOptions): Promise<InspectionResponse>;
  /** Server-side preparation boundary only; no signing or broadcasting. */
  prepareExecution(input: PrepareRequest, options?: RequestOptions): Promise<PrepareResponse>;
  prepareExecution(input: ExecutionInput, options: WalletRequestOptions): Promise<ExecutionResponse>;
  createWalletChallenge(input: WalletAccount, options?: RequestOptions): Promise<WalletChallenge>;
  verifyWallet(input: {challengeId:string;signature:string}, options?: RequestOptions): Promise<WalletSession>;
  getExecution(id:string, options:WalletRequestOptions): Promise<ExecutionResponse>;
  getActiveExecution(options:WalletRequestOptions): Promise<ApiEnvelope & {readonly execution: import('./execution.js').ExecutionRecord|null}>;
  claimExecution(id:string, input:{reviewHash:string;revision:number}, options:WalletRequestOptions): Promise<ClaimResponse>;
  submitExecution(id:string, input:{transactionHash:string}, options:WalletRequestOptions): Promise<ExecutionResponse>;
  markExecutionUncertain(id:string, options:WalletRequestOptions): Promise<ExecutionResponse>;
  watchExecution(id:string, options:ExecutionWatchOptions): Promise<ExecutionWatchResult>;
  refreshExecution(id:string, options:WalletRequestOptions): Promise<ExecutionResponse>;
  cancelExecution(id:string, input:{reviewHash:string;revision:number}, options:WalletRequestOptions): Promise<ExecutionResponse>;
}
export function createRouterClient(options: ClientOptions): RouterClient;
