import {
    cardErrors,
    indexMarketFromCard,
    sideLimits,
    stableStringify,
    solverDirectionKey,
    solverId,
    validateCard,
    verifyCardSig,
    type Card,
    type DiscoveredMarket,
} from "@arkade-os/solver-discovery";
import type { OpenRfqBid } from "../openRfq";
import { eligibleMarkets, type MarketCandidate } from "./market";
import type { QuoteInput } from "./quote";
import type { ResolvedRoute } from "./resolve";
import type { SwapPolicy } from "./policy";
import type { NetworkName } from "@arkade-os/sdk";

export interface OpenRfqOffer {
    readonly id: string;
    readonly solverPubkey: string;
    readonly solverName: string;
    readonly market: DiscoveredMarket;
    readonly signedCard: Card;
    readonly fromAmount: bigint;
    readonly toAmount: bigint;
    readonly expiresAt: number;
}

export interface OpenRfqAuction {
    readonly id: string;
    readonly input: QuoteInput;
    readonly pair: string;
    readonly bids: readonly OpenRfqOffer[];
    readonly closedAt: number;
}

/** Public pair and size discovery. Bids are indicative until quoteBid verifies binding terms. */
export interface OpenRfqOptions {
    /** Conversation-only key supplied by the application; use a fresh key for every request. */
    readonly secretKey: Uint8Array;
    /** Shared rendezvous with bidders. Absent means card relays, then opportunistic public defaults;
     * no relay discovers operators that do not listen there. */
    readonly relays?: readonly string[];
    readonly windowMs?: number;
    readonly signal?: AbortSignal;
    readonly onBids?: (bids: readonly OpenRfqOffer[]) => void;
}

export const DEFAULT_OPEN_RFQ_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"] as const;

export const freezeOpenRfqValue = <T>(value: T): T => {
    if (value !== null && typeof value === "object") {
        for (const nested of Object.values(value)) freezeOpenRfqValue(nested);
        Object.freeze(value);
    }
    return value;
};

export const openBidCandidates = (
    bid: OpenRfqBid,
    route: ResolvedRoute,
    network: string,
    policy?: SwapPolicy,
): { signedCard: Card; candidates: MarketCandidate[] } | undefined => {
    const checked = validateCard(bid.card);
    if (
        !checked.ok ||
        checked.value === undefined ||
        checked.value.discovery_pubkey !== bid.solverPubkey ||
        !verifyCardSig(checked.value) ||
        cardErrors(checked.value, network).length !== 0
    )
        return undefined;
    const signedCard = freezeOpenRfqValue(JSON.parse(JSON.stringify(checked.value)) as Card);
    const markets = (signedCard.markets ?? []).flatMap((market) => {
        const projected = indexMarketFromCard(signedCard, market);
        if (!projected.ok) return [];
        const matches = route.snapshot.ref.live
            ? route.snapshot.markets.filter((entry) => {
                  const { source: _source, sourceType: _sourceType, ...content } = entry;
                  return stableStringify(content) === stableStringify(projected.market);
              })
            : [];
        const known =
            policy?.allowedRegistries === undefined
                ? matches[0]
                : matches.find((entry) => policy.allowedRegistries!.includes(entry.source));
        return [
            freezeOpenRfqValue({
                ...projected.market,
                source: known?.source ?? `nostr:${bid.solverPubkey}`,
                sourceType: known?.sourceType ?? "local",
            } satisfies DiscoveredMarket),
        ];
    });
    const candidates = eligibleMarkets(
        { markets, ref: { ...route.snapshot.ref, live: true } },
        route.legs,
        policy,
    ).filter((candidate) => {
        if (candidate.backend !== "rfq") return false;
        const takeSide = candidate.give === "base" ? "quote" : "base";
        const to = sideLimits(candidate.card, takeSide);
        return to !== null && bid.toAmount >= to.min && bid.toAmount <= to.max;
    });
    return { signedCard, candidates };
};

export const hasPausedKnownBidder = async (
    signer: string,
    name: string,
    route: ResolvedRoute,
    network: NetworkName,
    policy?: SwapPolicy,
): Promise<boolean> => {
    if (!route.snapshot.ref.live || policy?.solverRouting?.preferences === undefined) return false;
    const candidates = eligibleMarkets(route.snapshot, route.legs)
        .filter(
            (candidate) =>
                candidate.card.discovery_pubkey === signer && candidate.card.solver === name,
        )
        .map((candidate) => ({
            ...candidate,
            solverId: solverId(candidate.card, network),
            direction: solverDirectionKey(candidate.card, candidate.give, network),
        }));
    if (candidates.length === 0) return false;
    const preferences = await policy.solverRouting.preferences({
        network,
        direction: candidates[0].direction,
        candidates,
    });
    return candidates.some((candidate) => preferences.disabled?.includes(candidate.solverId));
};
