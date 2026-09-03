/**
 * The v2 client, as far as M3 takes it: `resolve()` and `quote()`.
 *
 * Everything a caller used to assemble by hand happens behind these two calls —
 * the destination parse, the corridor pair, the market lookup, the transport to
 * the card's rendezvous, the amount encoding, the covenant derivation and the
 * four-and-one checks over the reply. What does NOT happen is anything durable
 * or irreversible: `quote()` opens no watcher, arms no drive, writes no record
 * and funds nothing. It returns terms and stops.
 *
 * Construction stays synchronous and touches nothing. The operator read, the
 * corridor deps and the market index are all resolved on first use, which is
 * what lets a client be built in a component body and only cost something when
 * somebody asks it a question — and what keeps a missing dep for a corridor
 * nobody uses from being a construction failure.
 */
import { hex } from "@scure/base";
import type { IWallet } from "@arkade-os/sdk";
import type { AssetSwapRepository } from "../repository";
import type { SwapOperator } from "../refund";
import { walletOperator } from "../refund";
import { corridorSet, type CorridorSet } from "./corridors/registry";
import {
    liveArkadeInfo,
    resolveCorridorBase,
    type CorridorBase,
    type CorridorOverrides,
} from "./corridors/deps";
import { discoveryIndex, type DiscoveryConfig, type DiscoveryIndex } from "./discovery";
import { UnsupportedRoute } from "./errors";
import type { SwapPolicy } from "./policy";
import { feedFetch, quoteFromFeed, type FeedFetch, type OfferPreparation } from "./quoteOffer";
import { quoteViaRfq, type RfqPreparation } from "./quoteRfq";
import type { Quote, QuoteId, QuoteInput, RouteResolution } from "./quote";
import { resolveRoute, type ResolvedRoute } from "./resolve";
import { nostrTransportFactory, type RfqTransportFactory } from "./transport";

/** What a quote derived, kept in memory for the accept that may follow. */
export type QuotePreparation = RfqPreparation | OfferPreparation;

export interface SwapClientConfig {
    /**
     * The wallet, and through it the operator: server info, chain reads and
     * broadcast all come from it, and no server URL is accepted anywhere.
     */
    readonly wallet: IWallet;
    /**
     * Storage. At this milestone it backs the markets cache and nothing else —
     * the persist-first record is M4's, and so is the platform default.
     */
    readonly repository?: AssetSwapRepository;
    readonly discovery?: DiscoveryConfig;
    /** Dependency overrides only: they never enable a route or pick a solver. */
    readonly corridors?: CorridorOverrides;
    readonly policy?: SwapPolicy;
    /** Covenant co-signer override, 33-byte compressed hex. */
    readonly emulatorPubkey?: string;
    /** Overrides the wallet's own connection; for tests and a second operator. */
    readonly operator?: SwapOperator;
    readonly fetchImpl?: typeof fetch;
    /**
     * How a card's rendezvous is opened. Defaults to the card's Nostr transport,
     * which is the only shipped one that can attest who answered — an injected
     * transport that attests nobody fails the responder check rather than
     * quietly quoting against an unauthenticated wire.
     */
    readonly transportFor?: RfqTransportFactory;
}

export interface SwapClient {
    /**
     * The route, the market that would price it, and what the active snapshot
     * serves — without disclosing anything to anybody.
     *
     * Network-free against injected or cached discovery data, which is the point
     * of having it: application policy gets to veto before an RFQ round trip
     * discloses an invoice or an amount.
     */
    resolve(input: QuoteInput): Promise<RouteResolution>;
    /** Verified, binding terms. Nothing is persisted, funded or watched. */
    quote(input: QuoteInput): Promise<Quote>;
    /**
     * What the quote with this id derived — the covenant, the keys, the wire
     * reply.
     *
     * Process-local and deliberately not durable: M3 persists nothing, and M4's
     * `accept()` is what turns this into a record. It exists so the covenant a
     * quote was verified against is the one that gets funded, rather than a
     * second derivation of the same tree.
     */
    preparationOf(id: QuoteId): QuotePreparation | undefined;
}

/**
 * How many quotes' derivations are kept.
 *
 * Bounded because a quote UI re-quotes on every keystroke and each one carries a
 * covenant; the oldest are dropped, and dropping one costs a re-quote rather
 * than anything durable — there is nothing durable here to lose.
 */
const PREPARATIONS_HELD = 64;

const mintQuoteId = (): QuoteId => hex.encode(crypto.getRandomValues(new Uint8Array(16)));

export const createSwapClient = (config: SwapClientConfig): SwapClient => {
    const { wallet } = config;
    const operator = config.operator ?? walletOperator(wallet);
    const feed: FeedFetch = feedFetch(config.fetchImpl ?? fetch);
    const preparations = new Map<QuoteId, QuotePreparation>();

    let context:
        | Promise<{ base: CorridorBase; corridors: CorridorSet; discovery: DiscoveryIndex }>
        | undefined;
    const resolved = () =>
        (context ??= (async () => {
            // Not `requireLive`: a parse derives no covenant, and `resolve()`
            // answers offline. Every covenant derivation makes its own live read
            // before it binds anything — see `quote()` below.
            const base = await resolveCorridorBase({
                wallet,
                operator,
                ...(config.emulatorPubkey === undefined
                    ? {}
                    : { emulatorPubkey: config.emulatorPubkey }),
                ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
                requireLive: false,
            });
            return {
                base,
                corridors: corridorSet(base, config.corridors),
                discovery: discoveryIndex({
                    network: base.networkName,
                    ...(config.discovery === undefined ? {} : { config: config.discovery }),
                    ...(config.repository === undefined ? {} : { repository: config.repository }),
                }),
            };
        })());

    const route = async (input: QuoteInput, mode: "resolve" | "quote"): Promise<ResolvedRoute> => {
        const { base, corridors, discovery } = await resolved();
        return resolveRoute(input, {
            corridors,
            network: base.networkName,
            discovery,
            ...(config.policy === undefined ? {} : { policy: config.policy }),
            mode,
        });
    };

    const remember = (id: QuoteId, preparation: QuotePreparation): void => {
        preparations.set(id, preparation);
        while (preparations.size > PREPARATIONS_HELD) {
            const oldest = preparations.keys().next();
            if (oldest.done) break;
            preparations.delete(oldest.value);
        }
    };

    return {
        resolve: async (input) => (await route(input, "resolve")).resolution,

        quote: async (input) => {
            const { corridors, discovery } = await resolved();
            let resolvedRoute = await route(input, "quote");

            // The responder check pins against the card's `discovery_pubkey`,
            // and a card read back out of the cache carries that field
            // unvalidated. So an addressed quote re-pins the card from the
            // registry first. If the registry cannot be reached the stale
            // snapshot still comes back and the check refuses it — which is the
            // fail-closed half of the same rule, not a second one.
            if (resolvedRoute.market?.backend === "rfq" && !resolvedRoute.snapshot.ref.live) {
                await discovery.load({ refresh: true });
                resolvedRoute = await route(input, "quote");
            }

            const { market } = resolvedRoute;
            if (market === undefined) {
                throw new UnsupportedRoute(
                    `no market serves ${resolvedRoute.legs.give.corridor}:` +
                        `${resolvedRoute.legs.give.assetId} -> ` +
                        `${resolvedRoute.legs.take.corridor}:${resolvedRoute.legs.take.assetId} ` +
                        "on the active discovery snapshot",
                    {
                        give: resolvedRoute.legs.give.corridor,
                        take: resolvedRoute.legs.take.corridor,
                    },
                );
            }
            const marketRef = resolvedRoute.resolution.market;
            if (marketRef === undefined || marketRef.kind !== "card") {
                throw new Error("a resolved market must carry its card's provenance");
            }

            // Dep resolution happens when a route first touches a corridor, and
            // this is that moment: a dep overridden to nothing is
            // `MissingCorridorDep` here, before anything is disclosed or funded,
            // and a corridor this route does not touch is never resolved at all.
            // Both legs, because the arkade one is a leg of every route.
            corridors.get(resolvedRoute.legs.give.corridor);
            corridors.get(resolvedRoute.legs.take.corridor);

            const quoteId = mintQuoteId();
            const now = Math.floor(Date.now() / 1000);

            if (resolvedRoute.pair === "arkade->arkade") {
                const { quote, preparation } = await quoteFromFeed({
                    quoteId,
                    candidate: market,
                    market: marketRef,
                    legs: resolvedRoute.legs,
                    endpoints: { give: resolvedRoute.give, take: resolvedRoute.take },
                    ...(resolvedRoute.amount === undefined ? {} : { amount: resolvedRoute.amount }),
                    feed,
                    ...(config.policy === undefined ? {} : { policy: config.policy }),
                    now,
                });
                remember(quoteId, preparation);
                return quote;
            }

            // Every covenant derivation reads live: a snapshot binds the tree to
            // a signer key the operator may no longer co-sign for, and an
            // unreachable operator is `OperatorUnreachable` here, before funding.
            const info = await liveArkadeInfo(wallet, { requireLive: true });
            const rendezvous = market.card.discovery_pubkey;
            if (rendezvous === undefined) {
                // Unreachable: `eligibleMarkets` drops a corridor card with no
                // rendezvous, precisely so this is never a transport built
                // against an empty key.
                throw new Error(`card ${market.card.solver} names no discovery key to address`);
            }
            const transport = await (config.transportFor ?? nostrTransportFactory)({
                card: market.card,
                solverPubkey: rendezvous,
                relays: market.card.transports?.nostr?.relays ?? [],
            });
            try {
                const { quote, preparation } = await quoteViaRfq({
                    quoteId,
                    route: resolvedRoute.pair,
                    candidate: market,
                    market: marketRef,
                    legs: resolvedRoute.legs,
                    endpoints: { give: resolvedRoute.give, take: resolvedRoute.take },
                    ...(resolvedRoute.amount === undefined ? {} : { amount: resolvedRoute.amount }),
                    wallet,
                    info,
                    corridors,
                    transport,
                    ...(config.policy === undefined ? {} : { policy: config.policy }),
                    now,
                });
                remember(quoteId, preparation);
                return quote;
            } finally {
                // One negotiation, one transport: the reply has landed or it has
                // not, and holding a relay subscription open past that is a
                // resource this call owns and nothing else will close.
                await transport.close().catch(() => {});
            }
        },

        preparationOf: (id) => preparations.get(id),
    };
};
