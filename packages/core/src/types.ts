/** Portable contracts for explicit, provider-validated routing capabilities. */
export type ChainId = `${string}:${string}`;

export interface Asset {
  readonly chainId: ChainId;
  readonly address: string;
  readonly decimals: number;
}

export interface OptimizationPolicy {
  readonly objective: 'BALANCED' | 'BEST_OUTPUT' | 'FASTEST';
  readonly maxOutputShortfallBps: number;
}

export interface NativeFeeBudget {
  readonly chainId: ChainId;
  /** null removes the caller's preset ceiling; reviewed gas costs remain finite. */
  readonly maxAmountRaw: string | null;
}

export interface NativeCost {
  readonly chainId: ChainId;
  readonly amountRaw: string;
}

export interface ChainWallet {
  readonly chainId: ChainId;
  readonly address: string;
}

export interface RouterRequest {
  readonly requestId: string;
  readonly source: Asset;
  readonly destination: Asset;
  readonly amountRaw: string;
  readonly sender: string;
  readonly recipient: string;
  readonly slippageBps: number;
  /** null removes the caller's fee ceiling, without waiving cost evidence. */
  readonly maxFeeBps: number | null;
  readonly maxPriceImpactBps: number;
  readonly maxCompletionMs: number;
  readonly deadlineMs: number;
  readonly optimization: OptimizationPolicy;
  readonly nativeFeeBudgets?: readonly NativeFeeBudget[];
  readonly wallets?: readonly ChainWallet[];
}

export type ValidationTier = 'UNVERIFIED' | 'QUOTE_VALIDATED' | 'EXECUTION_VALIDATED';
export type ExecutionTier = 'NONE' | 'WALLET_SIGNED';
export type LegKind = 'SWAP' | 'BRIDGE' | 'SWAP_BRIDGE';
export type LiquidityStatus = 'UNKNOWN' | 'AVAILABLE' | 'UNAVAILABLE';

/** A trusted adapter registers each directed asset pair, without wildcards. */
export interface RouteCapability {
  readonly id: string;
  readonly adapterId: string;
  readonly kind: LegKind;
  readonly source: Asset;
  readonly destination: Asset;
  readonly validationTier: ValidationTier;
  readonly executionTier: ExecutionTier;
  readonly liquidity: LiquidityStatus;
  readonly validUntilMs: number;
}

export interface PlannedLeg {
  readonly index: number;
  readonly capabilityId: string;
  readonly adapterId: string;
  readonly kind: LegKind;
  readonly source: Asset;
  readonly destination: Asset;
  readonly validationTier: ValidationTier;
  readonly executionTier: ExecutionTier;
  readonly quoteProbe: boolean;
  readonly amountSource: 'REQUEST_AMOUNT' | 'ACTUAL_PREVIOUS_SETTLED_OUTPUT';
  readonly requiresRequoteAfterSettlement: boolean;
}

/** Graph discovery is never authorization, even for a direct path. */
export interface PlannedPath {
  readonly id: string;
  readonly kind: 'DIRECT' | 'COMPOSED';
  readonly source: Asset;
  readonly destination: Asset;
  readonly legs: readonly PlannedLeg[];
  readonly quoteBasis: 'FIRM_FIRST_LEG' | 'CONDITIONAL_FUTURE_LEGS';
  readonly quoteProbe: boolean;
  readonly executionReady: false;
}

export interface LegQuote {
  readonly capabilityId: string;
  readonly adapterId: string;
  readonly source: Asset;
  readonly destination: Asset;
  readonly amountInRaw: string;
  readonly expectedOutRaw: string;
  readonly minimumOutRaw: string;
  /** Costs are already reflected in provider output; never subtract twice. */
  readonly feeBps: number | null;
  readonly protocolFeeBps?: number;
  readonly priceImpactBps: number | null;
  /** Composed-route costs must be repriced against the original input. Bps
   * against unrelated intermediate balances cannot safely be summed. */
  readonly costDenominator?: { readonly source: Asset; readonly amountRaw: string };
  readonly estimatedCompletionMs: number | null;
  readonly protocolEstimateMs?: number | null;
  readonly verificationMs?: { readonly sourceConfirmationMs: number; readonly destinationVerificationMs: number };
  readonly expiresAtMs: number;
  readonly pricingValidUntilMs?: number;
  readonly quoteId: string;
  readonly executableRecipeId?: string;
  readonly conditional: boolean;
  readonly liquidityConfirmed: boolean;
  readonly nativeCosts?: readonly NativeCost[];
}

export interface CompletionTiming {
  readonly protocolMs: number | null;
  readonly walletMs: number | null;
  readonly observationMs: number | null;
  readonly uncertaintyMs: number;
  readonly basis: 'CONFIGURED' | 'OBSERVED_CLEAN_NETWORK';
}

export interface RouteCandidate {
  readonly id: string;
  readonly requestId: string;
  readonly path: PlannedPath;
  readonly legQuotes: readonly LegQuote[];
  readonly source: Asset;
  readonly destination: Asset;
  readonly inputAmountRaw: string;
  readonly expectedOutputRaw: string;
  readonly minimumOutputRaw: string;
  readonly feeBps: number | null;
  readonly priceImpactBps: number | null;
  readonly completionMs: number | null;
  readonly deadlineMs: number;
  readonly quotedAtMs: number;
  readonly executionReady: boolean;
  readonly conditional: boolean;
  readonly validationTier: ValidationTier;
  readonly finalOutputDebitRaw?: string;
  readonly timing?: CompletionTiming;
}

export interface PlanningExclusion {
  readonly capabilityId: string;
  readonly reason: string;
}

export interface PlanningResult {
  readonly paths: readonly PlannedPath[];
  readonly exclusions: readonly PlanningExclusion[];
  readonly truncated: boolean;
}
