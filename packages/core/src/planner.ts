import { assetKey, boundedInteger, CapabilityRegistry, normalizeAsset, RouterCoreError, validateRequest, validationRank } from './capabilities.js';
import type { Asset, PlannedLeg, PlannedPath, PlanningExclusion, PlanningResult, RouteCapability, RouterRequest, ValidationTier } from './types.js';

export interface PlannerOptions {
  readonly intermediates?: readonly Asset[];
  readonly maxHops?: number;
  readonly maxPaths?: number;
  readonly maxEdges?: number;
  readonly allowedAdapterIds?: readonly string[];
  readonly minimumValidationTier?: ValidationTier;
  readonly nowMs?: number;
}

function plannedPath(edges: readonly RouteCapability[]): PlannedPath {
  const legs: PlannedLeg[] = edges.map((edge, index) => Object.freeze({ index, capabilityId: edge.id, adapterId: edge.adapterId,
    kind: edge.kind, source: edge.source, destination: edge.destination, validationTier: edge.validationTier,
    executionTier: edge.executionTier, quoteProbe: edge.liquidity === 'UNKNOWN',
    amountSource: index === 0 ? 'REQUEST_AMOUNT' : 'ACTUAL_PREVIOUS_SETTLED_OUTPUT', requiresRequoteAfterSettlement: index > 0 }));
  return Object.freeze({ id: `route:${encodeURIComponent(JSON.stringify(edges.map(edge => [edge.adapterId, edge.id])))}`,
    kind: edges.length === 1 ? 'DIRECT' : 'COMPOSED', source: edges[0]!.source, destination: edges.at(-1)!.destination,
    legs: Object.freeze(legs), quoteBasis: edges.length === 1 ? 'FIRM_FIRST_LEG' : 'CONDITIONAL_FUTURE_LEGS',
    quoteProbe: legs.some(leg => leg.quoteProbe), executionReady: false });
}

/** Bounded graph discovery; adapter quotes must independently verify every leg. */
export function planRoutes(rawRequest: RouterRequest, registry: CapabilityRegistry, options: PlannerOptions = {}): PlanningResult {
  const nowMs = options.nowMs ?? Date.now();
  const request = validateRequest(rawRequest, nowMs);
  const maxHops = boundedInteger(options.maxHops ?? 3, 1, 3, 'INVALID_HOP_LIMIT');
  const maxPaths = boundedInteger(options.maxPaths ?? 32, 1, 64, 'INVALID_PATH_LIMIT');
  const maxEdges = boundedInteger(options.maxEdges ?? 256, 1, 512, 'INVALID_EDGE_LIMIT');
  const minimumTier = validationRank(options.minimumValidationTier ?? 'QUOTE_VALIDATED');
  const intermediates = options.intermediates ?? [];
  if (!Array.isArray(intermediates) || intermediates.length > 64) throw new RouterCoreError('INVALID_INTERMEDIATES');
  const assets = [request.source, request.destination, ...intermediates.map(normalizeAsset)];
  const nodes = new Set(assets.map(assetKey));
  const allowed = options.allowedAdapterIds;
  if (allowed !== undefined && (!Array.isArray(allowed) || allowed.length > 128 || allowed.some(id =>
      typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)))) throw new RouterCoreError('INVALID_ADAPTER_ALLOWLIST');
  const exclusions: PlanningExclusion[] = [];
  const eligible: RouteCapability[] = [];
  for (const capability of registry.list()) {
    if (!nodes.has(assetKey(capability.source)) || !nodes.has(assetKey(capability.destination))) continue;
    let reason: string | undefined;
    if (allowed !== undefined && !allowed.includes(capability.adapterId)) reason = 'ADAPTER_NOT_ALLOWED';
    else if (capability.validUntilMs <= nowMs) reason = 'CAPABILITY_EXPIRED';
    else if (validationRank(capability.validationTier) < minimumTier) reason = 'VALIDATION_TIER_INSUFFICIENT';
    else if (capability.liquidity === 'UNAVAILABLE') reason = 'LIQUIDITY_UNAVAILABLE';
    if (reason) exclusions.push(Object.freeze({ capabilityId: capability.id, reason }));
    else eligible.push(capability);
  }
  let truncated = eligible.length > maxEdges;
  for (const capability of eligible.slice(maxEdges)) exclusions.push(Object.freeze({ capabilityId: capability.id, reason: 'EDGE_LIMIT_REACHED' }));
  const adjacency = new Map<string, RouteCapability[]>();
  for (const edge of eligible.slice(0, maxEdges)) {
    const key = assetKey(edge.source), items = adjacency.get(key) ?? [];
    items.push(edge); adjacency.set(key, items);
  }
  const source = assetKey(request.source), target = assetKey(request.destination);
  const queue: { edges: RouteCapability[]; vertex: string; visited: Set<string> }[] = [{ edges: [], vertex: source, visited: new Set([source]) }];
  const paths: PlannedPath[] = [], seen = new Set<string>();
  // Bound partial-path expansion too, even when the destination has no liquidity.
  let explored = 0;
  const expansionLimit = Math.min(4096, maxEdges * maxHops * maxPaths);
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of adjacency.get(current.vertex) ?? []) {
      if (++explored > expansionLimit) { truncated = true; queue.length = 0; break; }
      const destination = assetKey(edge.destination);
      if (current.visited.has(destination)) continue;
      const edges = [...current.edges, edge];
      if (destination === target) {
        const path = plannedPath(edges);
        if (!seen.has(path.id)) {
          if (paths.length >= maxPaths) { truncated = true; queue.length = 0; break; }
          seen.add(path.id); paths.push(path);
        }
      } else if (edges.length < maxHops) {
        queue.push({ edges, vertex: destination, visited: new Set([...current.visited, destination]) });
      }
    }
  }
  return Object.freeze({ paths: Object.freeze(paths), exclusions: Object.freeze(exclusions), truncated });
}
