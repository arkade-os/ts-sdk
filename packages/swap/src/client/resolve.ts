/**
 * Route resolution: the single place `to` is parsed, the corridor pair is
 * decided, the amount is pinned and the market is chosen — everything that has
 * to happen before a solver is told anything.
 *
 * The order is §3.1's and it is load-bearing. `to` is parsed first, because a
 * destination fault is the caller's most likely mistake and the parse needs no
 * market data. The corridor pair follows from the parse (or from `via` on a
 * receive, the one flow where no instrument can exist yet), and it selects the
 * `Route` variant — a pair outside the union is `UnsupportedRoute` here, before
 * an RFQ round trip, an artifact or a record. Only then does the market index
 * come in, and only then can a ticker be canonicalized, since the table a ticker
 * resolves against is built out of the cards themselves.
 *
 * The amount is pinned last and before any network call: exactly one may be
 * pinned, by the caller or by an invoice, and two is `AmountMismatch` — thrown
 * with nothing disclosed, which is the whole reason it is thrown here.
 */
import type { NetworkName } from "@arkade-os/sdk";
import {
    canonicalAssetId,
    toDiscoveryLeg,
    type AssetAliasTable,
    type DiscoveryLeg,
} from "./aliases";
import { btcOn, type AssetId } from "./assetId";
import { railOfCorridor, type Corridor } from "./corridor";
import type { CorridorSet } from "./corridors/registry";
import type { DiscoveryIndex, DiscoverySnapshot } from "./discovery";
import { AmountMismatch, UnsupportedRoute } from "./errors";
import { aliasTableFrom, scopedToRail } from "./aliasTable";
import { chooseMarket, eligibleMarkets, marketRefOf, type MarketCandidate } from "./market";
import type { SwapPolicy } from "./policy";
import type { PinnedAmount, QuoteInput, ResolvedEndpoint, RouteResolution } from "./quote";
import type { Instrument, Route } from "./route";

/** The four implemented corridor pairs, spelled as the route union spells them. */
const SUPPORTED_PAIRS = [
    "arkade->arkade",
    "arkade->lightning",
    "lightning->arkade",
    "arkade->onchain",
] as const;

type SupportedPair = (typeof SUPPORTED_PAIRS)[number];

const isSupportedPair = (pair: string): pair is SupportedPair =>
    (SUPPORTED_PAIRS as readonly string[]).includes(pair);

export interface ResolveDeps {
    readonly corridors: CorridorSet;
    /** The network the wallet reported; every defaulted asset id is on it. */
    readonly network: NetworkName;
    readonly discovery: DiscoveryIndex;
    readonly policy?: SwapPolicy;
    /**
     * `resolve()` reads what is in hand; `quote()` may fetch.
     *
     * The one difference between the two paths, and the reason it is a flag
     * rather than two functions: everything else about resolution — the parse,
     * the pair, the pin, the veto — has to be identical, or the resolution a
     * caller vetoed would not be the one they quoted.
     */
    readonly mode: "resolve" | "quote";
}

/** What the quote path needs from a resolution, over what a caller sees. */
export interface ResolvedRoute {
    readonly resolution: RouteResolution;
    /** Both legs in discovery's vocabulary — what the market lookup matched on. */
    readonly legs: { readonly give: DiscoveryLeg; readonly take: DiscoveryLeg };
    readonly give: ResolvedEndpoint;
    readonly take: ResolvedEndpoint;
    readonly pair: SupportedPair;
    readonly candidates: readonly MarketCandidate[];
    /** The chosen card, absent when nothing eligible survived. */
    readonly market?: MarketCandidate;
    readonly snapshot: DiscoverySnapshot;
    readonly amount?: PinnedAmount;
    /** The alias table the snapshot produced, so the quote path can reuse it. */
    readonly aliases: AssetAliasTable;
}

/**
 * Assemble the closed `Route` from two fully-instrumented legs.
 *
 * The one cast in the quote path, and it is confined to this function. The
 * checker cannot correlate `corridor` and `asset` across two independently
 * resolved values, but the pairing is a fact by the time we are here: every
 * asset went through `toDiscoveryLeg`, which is what decided the corridor. The
 * runtime re-check is cheap and turns a broken invariant into a throw at the
 * boundary rather than a covenant built against the wrong rail.
 */
export const assembleRoute = (
    give: ResolvedEndpoint & { instrument: Instrument },
    take: ResolvedEndpoint & { instrument: Instrument },
): Route => {
    for (const leg of [give, take]) {
        const rail = railOfCorridor(leg.corridor);
        if (!leg.asset.startsWith(`${rail}:`)) {
            throw new Error(
                `route leg ${leg.corridor} carries ${leg.asset}, which is not on the ${rail} rail`,
            );
        }
    }
    return { give, take } as unknown as Route;
};

/** A leg's endpoint, with the corridor cross-checked against the asset's rail. */
const endpoint = (
    corridor: Corridor,
    asset: AssetId,
    instrument: Instrument | undefined,
): ResolvedEndpoint => ({
    corridor,
    asset,
    ...(instrument === undefined ? {} : { instrument }),
});

/**
 * The corridor an id implies, refusing an id no corridor carries.
 *
 * The corridor is never an input on a leg whose asset is named: §4 makes it a
 * cross-check, because every id already carries its rail. Where the destination
 * or `via` also named one, the two must agree — an id on another rail is a
 * different route, not a correction.
 */
const legFor = (asset: AssetId, expected: Corridor | undefined): DiscoveryLeg => {
    const leg = toDiscoveryLeg(asset);
    if (expected !== undefined && leg.corridor !== expected) {
        throw new UnsupportedRoute(
            `${asset} settles on ${leg.corridor}, and this leg is ${expected}`,
            { give: leg.corridor, take: expected },
        );
    }
    return leg;
};

export const resolveRoute = async (
    input: QuoteInput,
    deps: ResolveDeps,
): Promise<ResolvedRoute> => {
    // 1. The destination, parsed once. Before the market index, because a
    //    destination fault needs no market data to be a fault.
    const claimed = input.to === undefined ? undefined : deps.corridors.claim(input.to);
    if (input.to !== undefined && claimed === undefined) {
        // Core classified it and no corridor serves it — an LNURL today. The
        // fault is the absence of a route, not an ambiguous destination.
        throw new UnsupportedRoute(`no corridor serves ${JSON.stringify(input.to)}`);
    }
    if (claimed?.corridor === "arkade") {
        // A well-formed Arkade address for this operator, which is a plain
        // Arkade payment: core's own `ark` rail owns it and the swap client
        // would only wrap it in a covenant nobody needs (spec section 5).
        throw new UnsupportedRoute(
            "an Arkade address is a plain Arkade payment, not a swap — send it with the wallet",
            { take: "arkade" },
        );
    }

    // 2. The market index. `resolve()` reads what is in hand and throws
    //    `DiscoverySnapshotUnavailable` when there is nothing; `quote()` may
    //    fetch first.
    const snapshot =
        deps.mode === "quote" ? await deps.discovery.load() : await deps.discovery.peek();
    const aliases = aliasTableFrom(snapshot.markets, deps.network);

    // 3. The two assets. A destination or a `via` names the corridor for the
    //    leg whose asset the caller left out; everything else comes off the id.
    if (input.via !== undefined && (input.via === "arkade" || !isCorridor(input.via))) {
        // `via` exists for the leg with no instrument, which is the give leg of
        // a receive. Naming arkade there says the value arrives from the wallet
        // itself, and an `eip155:` corridor names one section 9 defers.
        throw new UnsupportedRoute(
            `via names ${input.via}, which is not a corridor a receive can arrive over`,
        );
    }
    const giveCorridor: Corridor | undefined = input.via;
    const takeCorridor = claimed?.corridor ?? (giveCorridor === undefined ? undefined : "arkade");

    const takeAsset = assetFor(input.take, takeCorridor ?? "arkade", deps.network, aliases);
    const giveAsset = assetFor(input.give, giveCorridor ?? "arkade", deps.network, aliases);

    const takeLeg = legFor(takeAsset, takeCorridor);
    const giveLeg = legFor(giveAsset, giveCorridor);
    if (giveLeg.corridor === takeLeg.corridor && giveLeg.assetId === takeLeg.assetId) {
        // One leg twice is not a swap, and it is what an `exchange` with no
        // `take` resolves to — said here rather than left to surface as an
        // empty market set, which would name the registry for the caller's
        // omission.
        throw new UnsupportedRoute(
            `both legs are ${giveAsset} on ${giveLeg.corridor} — name the other side with take, ` +
                "a destination, or via",
            { give: giveLeg.corridor, take: takeLeg.corridor },
        );
    }

    // 4. The corridor pair selects the route variant. Outside the union is a
    //    refusal here, before disclosure, artifact, persistence or funding —
    //    `onchain -> arkade` included, and named as the deferral it is.
    const pair = `${giveLeg.corridor}->${takeLeg.corridor}`;
    if (!isSupportedPair(pair)) {
        throw new UnsupportedRoute(
            pair === "onchain->arkade"
                ? "onchain -> arkade is not served until the client owns the trader's L1 refund path end to end"
                : `${pair} is not an implemented route`,
            { give: giveLeg.corridor, take: takeLeg.corridor },
        );
    }

    // 5. Instruments, by the supply law: the caller provides non-wallet TAKE
    //    instruments (that is what `to` is), the quote provides non-wallet GIVE
    //    instruments (that is exactly what the artifact is), and every
    //    remaining slot is the wallet.
    const give = endpoint(
        giveLeg.corridor,
        giveAsset,
        giveLeg.corridor === "arkade" ? { kind: "wallet" } : undefined,
    );
    const take = endpoint(
        takeLeg.corridor,
        takeAsset,
        claimed?.instrument ?? (takeLeg.corridor === "arkade" ? { kind: "wallet" } : undefined),
    );

    // 6. Exactly one amount is pinned, and the check runs before any round trip.
    const amount = pinAmount(input, take.instrument);

    // 7. The market, after the policy filters that must run before disclosure.
    const candidates = eligibleMarkets(snapshot, { give: giveLeg, take: takeLeg }, deps.policy);
    const market = chooseMarket(candidates, deps.policy);

    const resolution: RouteResolution = {
        give,
        take,
        ...(market === undefined ? {} : { market: marketRefOf(market, snapshot.ref) }),
        eligible: market === undefined ? 0 : candidates.length,
        snapshot: snapshot.ref,
        ...(amount === undefined ? {} : { amount }),
    };

    return {
        resolution,
        legs: { give: giveLeg, take: takeLeg },
        give,
        take,
        pair,
        candidates,
        ...(market === undefined ? {} : { market }),
        snapshot,
        ...(amount === undefined ? {} : { amount }),
        aliases,
    };
};

const isCorridor = (value: string): value is Corridor =>
    value === "arkade" || value === "lightning" || value === "onchain";

/**
 * A caller's asset spelling, or the corridor's own BTC when they left it out.
 *
 * Defaulting to BTC is what makes `pay(bolt11)` and `receive({via})` need no
 * asset at all: lightning and L1 carry BTC and nothing else, and the arkade side
 * of a corridor swap is the BTC that crosses it. On an asset swap both sides are
 * named, which is the only route where a default would be a guess.
 */
const assetFor = (
    ref: string | undefined,
    corridor: Corridor,
    network: NetworkName,
    aliases: AssetAliasTable,
): AssetId =>
    ref === undefined
        ? btcOn(railOfCorridor(corridor), network)
        : // Scoped to the leg's rail, because BTC has one id per rail and a
          // whole-table lookup would refuse `"BTC"` as ambiguous on any snapshot
          // carrying a corridor market — see `scopedToRail`.
          canonicalAssetId(ref, scopedToRail(aliases, railOfCorridor(corridor)));

/**
 * The one pinned amount.
 *
 * An invoice pins the take leg by existing, so a caller passing an amount
 * beside one is pinning a second — refused even when the two agree, because
 * "they agreed this time" is not a rule anyone can rely on and the invoice is
 * the one both sides settle against.
 */
const pinAmount = (
    input: QuoteInput,
    takeInstrument: Instrument | undefined,
): PinnedAmount | undefined => {
    const invoiced =
        takeInstrument?.kind === "invoice" && takeInstrument.amount !== undefined
            ? takeInstrument.amount
            : undefined;
    if (input.amount !== undefined && invoiced !== undefined) {
        throw new AmountMismatch([`the invoice's ${invoiced}`, `amount ${input.amount}`]);
    }
    if (input.amount !== undefined) {
        if (input.amountOn === undefined) {
            // Caller input, not a swap-boundary refusal: the taxonomy's members
            // are conditions of the swap, and this is a field left out.
            throw new Error("amount needs amountOn ('give' or 'take') to say which leg it pins");
        }
        if (input.amount <= 0n) {
            throw new Error(`amount must be positive, got ${input.amount}`);
        }
        return { value: input.amount, on: input.amountOn, source: "caller" };
    }
    if (invoiced !== undefined) return { value: invoiced, on: "take", source: "invoice" };
    return undefined;
};
