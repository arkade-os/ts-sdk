/**
 * Route resolution: the single place `to` is parsed, the corridor pair decided, the
 * amount pinned and the market chosen — everything before a solver is told anything.
 *
 * The order (§3.1) is load-bearing: `to` first (needs no market data); the pair selects
 * the `Route` variant, refusing unsupported pairs before any round trip or record; only
 * then the market index, since tickers resolve against the cards themselves. Exactly one
 * amount may be pinned; two is `AmountMismatch`, thrown here so nothing is disclosed.
 */
import type { NetworkName } from "@arkade-os/sdk";
import {
    canonicalAssetId,
    toDiscoveryLeg,
    type AssetAliasTable,
    type DiscoveryLeg,
} from "./aliases";
import { btcOn, type AssetId } from "./assetId";
import { CORRIDORS, railOfCorridor, type Corridor } from "./corridor";
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
     * `resolve()` reads what is in hand; `quote()` may fetch. A flag, not two functions,
     * so the resolution a caller vetoed is exactly the one they quote.
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
 * The quote path's one cast: the type checker cannot correlate `corridor` and `asset`,
 * so the runtime re-check turns a broken invariant into a throw rather than a covenant
 * built against the wrong rail.
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
 * The corridor an id implies, refusing an id no corridor carries. Where the destination
 * or `via` also named one they must agree: an id on another rail is a different route,
 * not a correction.
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
    // 1. The destination, parsed once.
    const claimed = input.to === undefined ? undefined : deps.corridors.claim(input.to);
    if (input.to !== undefined && claimed === undefined) {
        // e.g. an LNURL: core classified it but no corridor serves it.
        throw new UnsupportedRoute(`no corridor serves ${JSON.stringify(input.to)}`);
    }
    if (claimed?.corridor === "arkade") {
        // A plain Arkade payment belongs to core's `ark` rail, not a covenant (spec §5).
        throw new UnsupportedRoute(
            "an Arkade address is a plain Arkade payment, not a swap — send it with the wallet",
            { take: "arkade" },
        );
    }

    // 2. The market index.
    const snapshot =
        deps.mode === "quote" ? await deps.discovery.load() : await deps.discovery.peek();
    const aliases = aliasTableFrom(snapshot.markets, deps.network);

    // 3. The two assets. A destination or `via` names the corridor for a leg whose asset
    //    was left out; otherwise it comes off the id.
    if (input.via !== undefined && (input.via === "arkade" || !isCorridor(input.via))) {
        // `via` is the give leg of a receive; arkade there would mean the wallet itself.
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
        // What an `exchange` with no `take` resolves to. Refused here, not left to surface
        // as an empty market set that would blame the registry.
        throw new UnsupportedRoute(
            `both legs are ${giveAsset} on ${giveLeg.corridor} — name the other side with take, ` +
                "a destination, or via",
            { give: giveLeg.corridor, take: takeLeg.corridor },
        );
    }

    // 4. The corridor pair selects the route variant; refused before any disclosure.
    const pair = `${giveLeg.corridor}->${takeLeg.corridor}`;
    if (!isSupportedPair(pair)) {
        throw new UnsupportedRoute(
            pair === "onchain->arkade"
                ? "onchain -> arkade is not served until the client owns the trader's L1 refund path end to end"
                : `${pair} is not an implemented route`,
            { give: giveLeg.corridor, take: takeLeg.corridor },
        );
    }

    // 5. Instruments: the caller supplies non-wallet TAKE ones (`to`), the quote supplies
    //    non-wallet GIVE ones (the artifact), and every remaining slot is the wallet.
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

    // 6. Exactly one amount is pinned, before any round trip.
    const amount = pinAmount(input, take.instrument);

    // 7. The market. A take-side pin also bounds-checks cards, so an unserved size is
    //    `eligible: 0` here rather than an RFQ that discloses the amount to be refused.
    const candidates = eligibleMarkets(
        snapshot,
        { give: giveLeg, take: takeLeg },
        deps.policy,
        amount?.on === "take" ? amount.value : undefined,
    );
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
    (CORRIDORS as readonly string[]).includes(value);

/**
 * A caller's asset spelling, or the corridor's own BTC when they left it out (lightning
 * and L1 carry only BTC), so `pay(bolt11)` and `receive({via})` need no asset.
 */
const assetFor = (
    ref: string | undefined,
    corridor: Corridor,
    network: NetworkName,
    aliases: AssetAliasTable,
): AssetId =>
    ref === undefined
        ? btcOn(railOfCorridor(corridor), network)
        : // Rail-scoped: BTC has one id per rail, so a whole-table `"BTC"` is ambiguous.
          canonicalAssetId(ref, scopedToRail(aliases, railOfCorridor(corridor)));

/**
 * The one pinned amount. An amount-bearing invoice or BIP21 `amount=` pins the take leg,
 * so a caller amount beside it is refused even when the two agree: the destination is
 * what both sides settle against.
 */
const pinAmount = (
    input: QuoteInput,
    takeInstrument: Instrument | undefined,
): PinnedAmount | undefined => {
    const pinned =
        takeInstrument?.kind === "invoice" && takeInstrument.amount !== undefined
            ? { value: takeInstrument.amount, named: "the invoice's" }
            : takeInstrument?.kind === "address" && takeInstrument.amount !== undefined
              ? { value: takeInstrument.amount, named: "the destination's" }
              : undefined;
    if (input.amount !== undefined && pinned !== undefined) {
        throw new AmountMismatch([`${pinned.named} ${pinned.value}`, `amount ${input.amount}`]);
    }
    if (input.amount !== undefined) {
        if (input.amountOn === undefined) {
            // A plain Error: a missing field, not a swap condition in the taxonomy.
            throw new Error("amount needs amountOn ('give' or 'take') to say which leg it pins");
        }
        if (input.amount <= 0n) {
            throw new Error(`amount must be positive, got ${input.amount}`);
        }
        return { value: input.amount, on: input.amountOn, source: "caller" };
    }
    if (pinned !== undefined) return { value: pinned.value, on: "take", source: "destination" };
    return undefined;
};
