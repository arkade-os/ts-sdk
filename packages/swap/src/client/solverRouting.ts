import {
    orderSolverMarkets,
    rankSolverMarkets,
    solverDirectionKey,
    solverId,
    type SolverRoutingPreferences,
} from "@arkade-os/solver-discovery";
import type { NetworkName } from "@arkade-os/sdk";
import { ASSET_CARRIER_SATS } from "../offer";
import { SwapRefusal } from "../rfq";
import { SolverUnavailable } from "../transportErrors";
import { QuoteExpired, QuoteVerificationFailed } from "./errors";
import type { MarketCandidate } from "./market";
import type { SwapPolicy } from "./policy";
import type { Swap } from "./record";
import type { ResolvedRoute } from "./resolve";

export interface SolverCandidate extends MarketCandidate {
    readonly solverId: string;
    readonly direction: string;
}

export interface SolverRoutingContext {
    readonly network: NetworkName;
    readonly direction: string;
    readonly candidates: readonly SolverCandidate[];
}

/** Optional direction-specific policy for quote preparation; accepted swaps keep their solver. */
export interface SolverRoutingPolicy {
    /** Try another candidate on solver-local quote failure; defaults to true. An explicit
     * `selectMarket` remains an authoritative pin or veto and disables failover. */
    readonly failover?: boolean;
    /** Read current preferences before selection. Absent means discovery order; rejection stops
     * the operation before negotiation. Modes, priority and usage follow {@link SolverRoutingPreferences}. */
    readonly preferences?: (
        context: SolverRoutingContext,
    ) => SolverRoutingPreferences | Promise<SolverRoutingPreferences>;
}

export const orderedSolverCandidates = async (
    route: ResolvedRoute,
    network: NetworkName,
    policy: SwapPolicy | undefined,
    fetchImpl: typeof fetch,
    estimate = true,
): Promise<SolverCandidate[]> => {
    const candidates = (
        policy?.selectMarket ? (route.market === undefined ? [] : [route.market]) : route.candidates
    ).map((candidate) => ({
        ...candidate,
        solverId: solverId(candidate.card, network),
        direction: solverDirectionKey(candidate.card, candidate.give, network),
    }));
    if (candidates.length === 0) return [];
    const preferences = await policy?.solverRouting?.preferences?.({
        network,
        direction: candidates[0].direction,
        candidates,
    });
    const options = { network, preferences };
    return estimate
        ? rankSolverMarkets(candidates, {
              ...options,
              amount:
                  route.amount === undefined
                      ? undefined
                      : { on: route.amount.on, value: route.amount.value },
              carrierSats: ASSET_CARRIER_SATS,
              fetchImpl,
          })
        : orderSolverMarkets(candidates, options);
};

export const canFailoverQuote = (error: unknown): boolean => {
    if (
        error instanceof SolverUnavailable ||
        error instanceof QuoteExpired ||
        error instanceof QuoteVerificationFailed
    ) {
        return true;
    }
    if (!(error instanceof SwapRefusal)) return false;
    if (error.errorCode !== undefined) {
        return (
            error.errorCode === "amount_side_unsupported" ||
            error.errorCode === "exact_out_unsupported"
        );
    }
    return [
        "unsupported_pair",
        "amount_out_of_range",
        "exposure_cap",
        "pricing_unavailable",
        "rate_limited",
    ].includes(error.reason);
};

export class SolverRoutesUnavailable extends AggregateError {
    override readonly name = "SolverRoutesUnavailable";
    constructor(readonly attempts: readonly { solverId: string; error: unknown }[]) {
        super(
            attempts.map(({ error }) => error),
            "No available solver could quote this swap",
        );
    }
}

export const completedSolverUsage = (
    swaps: readonly Swap[],
    network: string,
    direction: string,
): Record<string, number> => {
    const usage: Record<string, number> = {};
    const seen = new Set<string>();
    for (const swap of swaps) {
        if (
            seen.has(swap.id) ||
            !["filled", "paid", "claimed"].includes(swap.outcome) ||
            swap.market.kind !== "card"
        )
            continue;
        if (JSON.stringify([network, swap.route.give.asset, swap.route.take.asset]) !== direction)
            continue;
        seen.add(swap.id);
        const id = solverId(
            {
                solver: swap.market.solver,
                source: swap.market.source,
                sourceType: swap.market.sourceType,
                discovery_pubkey: swap.market.discoveryPubkey,
            },
            network,
        );
        usage[id] = (usage[id] ?? 0) + 1;
    }
    return usage;
};
