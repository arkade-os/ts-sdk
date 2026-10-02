/**
 * The v2 client. `resolve()` and `quote()` touch nothing durable (no watcher, drive, record or
 * funding); `accept()` persists and registers with the drive ({@link createSwapDrive}).
 *
 * Construction is synchronous and INERT — no network, wallet or repository — so a client can be
 * built in a component body, and a missing dep for an unused corridor is not a construction error.
 */
import { hex } from "@scure/base";
import type { IWallet } from "@arkade-os/sdk";
import { collectSwapRecords, type AssetSwapRepository } from "../repository";
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
import { ClientDisposed, MissingCorridorDep, NotCancellable, UnsupportedRoute } from "./errors";
import { acceptQuote, type QuotePreparation } from "./accept";
import { cancelSwap, type CancelOutcome } from "./cancel";
import { createSwapDrive, readableRecord, type RecoveryResult, type SwapDrive } from "./drive";
import { walletLockupIndexer } from "./driveRecords";
import type { Outcome, SwapUpdate, Unsubscribe } from "./outcome";
import {
    familyOfSwapId,
    quoteIdOfSwapId,
    swapOf,
    type AssetSwapId,
    type Swap,
    type SwapFamily,
} from "./record";
import type { CorridorId } from "./corridor";
import type { SwapPolicy } from "./policy";
import { feedFetch, quoteFromFeed, type FeedFetch } from "./quoteOffer";
import { quoteViaRfq } from "./quoteRfq";
import type { Quote, QuoteId, QuoteInput, RouteResolution } from "./quote";
import { resolveRoute, type ResolvedRoute } from "./resolve";
import {
    exchange,
    pay,
    receive,
    type ExchangeOptions,
    type PayOptions,
    type PayResult,
    type ReceiveOptions,
    type ReceiveRequest,
    type VerbDeps,
} from "./verbs";
import { cardMarketOf, marketBackendOf, marketKeyOf, usableMarkets, type Market } from "./market";
import { nostrTransportFactory, type RfqTransportFactory } from "./transport";

export interface SwapClientConfig {
    /** The wallet, and through it the operator: server info, chain reads and broadcast all come from
     * it; no server URL is accepted anywhere. */
    readonly wallet: IWallet;
    /**
     * Storage for accept records, the markets cache and the restore-scan cursor. No implicit default
     * and never an in-memory fallback: silently losing active swaps is what it must prevent.
     * Browser: `IndexedDbAssetSwapRepository`; Node: `@arkade-os/swap/node`; tests:
     * `InMemoryAssetSwapRepository`. Without one, `accept()` throws `MissingCorridorDep`.
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
    /** How a card's rendezvous is opened. Defaults to the card's Nostr transport, the only shipped
     * one that attests who answered; a transport that attests nobody fails the responder check. */
    readonly transportFor?: RfqTransportFactory;
}

export interface SwapClient {
    /**
     * The restore-read, and — when it armed — the first pass after it. Under `drive: "auto"` the
     * read arms the loop on live work; arming runs a pass immediately since a resumed swap may be
     * past a deadline. **Rejects only when the repository is unreadable**; per-record problems
     * surface through {@link onUpdate}.
     */
    readonly ready: Promise<void>;

    /**
     * Arm the drive. Idempotent (React double-mount safe); required only by `drive: "manual"`.
     *
     * @throws {SwapDriveRefusedError} under `drive: "readonly"`, which actuates
     *   nothing — silence would leave two contradictory instructions standing.
     */
    start(): Promise<void>;

    /**
     * Release live resources and stay reusable: a pause, not a cancellation. In-flight actions run to
     * completion; records and the wallet's contract registrations stay, because dropping one
     * unwatches a funded lockup.
     */
    stop(): Promise<void>;

    /**
     * Terminal cleanup: {@link stop}, drain in-flight work (nothing takes an `AbortSignal`), drop
     * every listener. Durable state survives; an injected repository is never closed. Afterwards
     * members refuse with {@link ClientDisposed}, except teardown: a second dispose and an issued
     * {@link Unsubscribe} are no-ops, so React-effect teardown never throws.
     */
    [Symbol.asyncDispose](): Promise<void>;

    /**
     * Every outcome transition, both families. Replays every known swap's current outcome, then
     * streams. Idempotent per derived `(swapId, outcome)`, so the legal `claimed -> claimable`
     * backslide (`funded` twice) is delivered once.
     */
    onUpdate(fn: (update: SwapUpdate) => void): Unsubscribe;

    /**
     * Recover a swap whose value was swept, then run one pass. The wallet's recovery round takes no
     * outpoints and may defer outputs, so this re-reads the lockup to answer for THIS swap.
     *
     * @throws {SwapDriveRefusedError} under `drive: "readonly"`; for a lockup
     *   still inside its refund window, where a round including it can fail the
     *   whole batch; and for a swap with nothing swept — which is what a
     *   `needs_recovery` that came from `needs_counterparty` is.
     */
    recover(swapId: AssetSwapId): Promise<RecoveryResult>;

    /**
     * Cancel an asset swap: take back an unfilled offer's deposit (HTLC corridor swaps exit by claim
     * or refund). Cancel races a fill: an already-spent deposit answers `filled` rather than
     * throwing; a spend the rebuild cannot classify is `needs_recovery`.
     *
     * @throws {NotCancellable} for a corridor-tagged id, or an id no record backs.
     * @throws {MissingCorridorDep} when the client was given no repository.
     * @throws {ClientDisposed} after disposal.
     */
    cancel(swapId: AssetSwapId): Promise<{ outcome: CancelOutcome }>;

    /**
     * Every swap this client wrote — both families, live and ended — projected through the drive's
     * derivation, so membership is independent of `start()` and drive mode. Undecodable records are
     * skipped. **The v2 keyspace is never pruned.** v1-era rows (`swaps`, `rfqSwaps`) are excluded;
     * they belong to `/protocol`'s readers.
     */
    swaps(filter?: SwapFilter): Promise<Swap[]>;

    /**
     * The markets a `quote()` could be priced against, in the `Quote.market` shape and under the same
     * filters, so it cannot offer one `quote()` would refuse. Fetches when no snapshot is in hand, as
     * `quote()` does, since callers reach for it BEFORE quoting.
     *
     * @throws {DiscoverySnapshotUnavailable} when the fetch leaves it with
     *   nothing either.
     */
    markets(): Promise<Market[]>;

    /**
     * The route, the market that would price it, and what the active snapshot serves — disclosing
     * nothing. Network-free against injected or cached discovery data, so application policy can
     * veto before an RFQ round trip discloses an invoice or amount.
     */
    resolve(input: QuoteInput): Promise<RouteResolution>;
    /** Verified, binding terms. Nothing is persisted, funded or watched. */
    quote(input: QuoteInput): Promise<Quote>;
    /**
     * Make the quote durable, then move the value: record and secrets are at rest before anything
     * irreversible. Idempotent by quote id — never a second invoice or a second funding. Returns
     * once durable: an invoice shown while its claim secret is only in memory buys an unclaimable
     * lockup.
     *
     * @throws {QuoteExpired} past `quote.expiresAt`; the client never re-quotes.
     * @throws {InsufficientFunds} before the persist, on funding routes only.
     * @throws {AcceptConflict} when a record for this quote id contradicts it.
     * @throws {MissingCorridorDep} when the client was given no repository.
     */
    accept(quote: Quote): Promise<Swap>;
    /**
     * Pay a bolt11, a `bc1…`, or a plain Arkade address: `quote` → fee ceiling → `accept`, the amount
     * being what the recipient gets. A plain Arkade address is **not** a swap: it settles through
     * `wallet.send` and answers `{ kind: "payment", txid }`, hence the union.
     *
     * @throws {MaxFeeExceeded} when the quoted fee is over `maxFee` or
     *   `policy.maxFee`, whichever is tighter — before anything is funded.
     */
    pay(destination: string, options?: PayOptions): Promise<PayResult>;

    /**
     * Ask for an incoming payment and get back the artifact to show its payer. Returns only after
     * `accept()` persisted (see {@link accept}). Generic over `via` so the artifact's shape follows
     * the corridor named; see {@link ReceiveArtifact}.
     *
     * @throws {MaxFeeExceeded} as {@link pay} does.
     */
    receive<C extends CorridorId = CorridorId>(
        options: ReceiveOptions & { readonly via: C },
    ): Promise<ReceiveRequest<C>>;

    /**
     * Swap one Arkade asset for another.
     *
     * @throws {MaxFeeExceeded} as {@link pay} does.
     */
    exchange(options: ExchangeOptions): Promise<Swap>;

    /**
     * What the quote with this id derived — covenant, keys, wire reply. Process-local, not durable;
     * it exists so the covenant a quote was verified against is the one funded, not a re-derivation.
     */
    preparationOf(id: QuoteId): QuotePreparation | undefined;
}

/** The in-memory filter {@link SwapClient.swaps} applies. */
export interface SwapFilter {
    readonly family?: SwapFamily;
    readonly outcome?: Outcome;
}

/** Bounded because a quote UI re-quotes per keystroke; dropping one costs only a re-quote. */
const PREPARATIONS_HELD = 64;

const mintQuoteId = (): QuoteId => hex.encode(crypto.getRandomValues(new Uint8Array(16)));

export const createSwapClient = (config: SwapClientConfig): SwapClient => {
    const { wallet } = config;
    const operator = config.operator ?? walletOperator(wallet);
    const feed: FeedFetch = feedFetch(config.fetchImpl ?? fetch);
    const preparations = new Map<QuoteId, QuotePreparation>();
    // shared by the drive and cancel's fill-race read, so both see the same chain
    const indexer = walletLockupIndexer(wallet);

    /** The terminal gate for members the drive does not gate itself. `ready` throws rather than
     * returning a rejected promise nobody awaited (an unhandled rejection). */
    let disposed = false;
    const ensureLive = (method: string): void => {
        if (disposed) throw new ClientDisposed(method);
    };

    // lazy and inert: the corridor set is a thunk so constructing the drive costs no operator read
    let drive: SwapDrive | undefined;
    const driving = (): SwapDrive =>
        (drive ??= createSwapDrive({
            wallet,
            operator,
            ...(config.repository === undefined ? {} : { repository: config.repository }),
            corridors: async () => (await resolved()).corridors,
            network: async () => (await resolved()).base.networkName,
            ...(config.policy?.drive === undefined ? {} : { mode: config.policy.drive }),
            indexer,
        }));

    let context:
        | Promise<{ base: CorridorBase; corridors: CorridorSet; discovery: DiscoveryIndex }>
        | undefined;
    /** A rejected init is not cached: it means an unreachable operator with no persisted snapshot,
     * and caching it would strand the client over one unreachable moment. */
    const resolved = () =>
        (context ??= (async () => {
            // not `requireLive`: a parse derives no covenant; every covenant derivation makes its
            // own live read (see `quote()`)
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
        })().catch((error) => {
            context = undefined;
            throw error;
        }));

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
        if (preparations.size > PREPARATIONS_HELD) {
            preparations.delete(preparations.keys().next().value!);
        }
    };

    const client: SwapClient = {
        resolve: async (input) => {
            ensureLive("resolve");
            return (await route(input, "resolve")).resolution;
        },

        quote: async (input) => {
            ensureLive("quote");
            const { corridors, discovery } = await resolved();
            let resolvedRoute = await route(input, "quote");

            // The responder check pins against the card's `discovery_pubkey`, which a cached card
            // carries unvalidated, so re-pin from the registry. If unreachable, the stale snapshot
            // comes back and the check refuses it (fail closed).
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

            // Deps resolve when a route first touches a corridor: a dep overridden to nothing is
            // `MissingCorridorDep` here, before anything is disclosed or funded.
            corridors.get(resolvedRoute.legs.give.corridor);
            corridors.get(resolvedRoute.legs.take.corridor);

            const quoteId = mintQuoteId();
            const now = Math.floor(Date.now() / 1000);

            // The card decides, and `marketBackendOf` is where it decided: an
            // asset card naming a rendezvous is negotiated like every other
            // route, and one advertising a feed and no rendezvous is priced from
            // the formula it advertises. Never a client switch — see
            // `marketBackendOf`.
            if (market.backend === "feed") {
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

            // live: a snapshot could bind the tree to a signer key the operator no longer co-signs
            // for; an unreachable operator is `OperatorUnreachable` here, before funding
            const info = await liveArkadeInfo(wallet, { requireLive: true });
            const rendezvous = market.card.discovery_pubkey;
            if (rendezvous === undefined) {
                // unreachable: `eligibleMarkets` drops a corridor card with no rendezvous, and an asset card without one prices from its feed
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
                    feed,
                    ...(config.policy === undefined ? {} : { policy: config.policy }),
                    now,
                });
                remember(quoteId, preparation);
                return quote;
            } finally {
                // one negotiation, one transport; nothing else would close the relay subscription
                await transport.close().catch(() => {});
            }
        },

        accept: async (quote) => {
            ensureLive("accept");
            const { corridors } = await resolved();
            const drive = driving();
            // before the persist: the restore indexes stored records, and resuming one the drive
            // had not read would register a second live swap for the same lockup
            await drive.ready;
            const preparation = preparations.get(quote.id);
            return acceptQuote({
                quote,
                ...(preparation === undefined ? {} : { preparation }),
                wallet,
                repository: config.repository,
                corridors,
                drive,
                now: Math.floor(Date.now() / 1000),
            });
        },

        cancel: async (swapId) => {
            ensureLive("cancel");
            // the tag parse is the refusal: a corridor id needs no repository read
            if (familyOfSwapId(swapId) === "rfq") throw new NotCancellable(swapId);
            const repository = config.repository;
            if (repository === undefined) {
                throw new MissingCorridorDep("arkade", "repository");
            }
            const drive = driving();
            // before the read, for `accept()`'s reason: a gate written onto a record the drive never
            // read would emit into an empty registry
            await drive.ready;
            const record = await repository.getSwapRecord(quoteIdOfSwapId(swapId));
            if (record === undefined || record.family !== "offer") {
                throw new NotCancellable(swapId);
            }
            return cancelSwap({ wallet, repository, record, drive, indexer });
        },

        swaps: async (filter) => {
            ensureLive("swaps");
            const repository = config.repository;
            if (repository === undefined) return [];
            const drive = driving();
            await drive.ready;
            const records = await collectSwapRecords(repository);
            const swaps: Swap[] = [];
            for (const record of records) {
                if (!readableRecord(record)) continue;
                const live = drive.swap(record.id);
                swaps.push(live ?? swapOf(record, drive.outcomeOf(record)));
            }
            if (filter === undefined) return swaps;
            return swaps.filter(
                (swap) =>
                    (filter.family === undefined || swap.family === filter.family) &&
                    (filter.outcome === undefined || swap.outcome === filter.outcome),
            );
        },

        markets: async () => {
            ensureLive("markets");
            const { discovery } = await resolved();
            // `load`, as `quote()` reads it: a never-routed client must not refuse where the quote
            // would not
            const snapshot = await discovery.load();
            // the routing read's own filter, so this cannot offer a card `quote()` would refuse
            return usableMarkets(snapshot, config.policy).map((card) =>
                cardMarketOf(card, snapshot.ref, marketKeyOf(card), marketBackendOf(card)),
            );
        },

        pay: async (destination, options) => {
            ensureLive("pay");
            return pay(verbs, destination, options);
        },

        receive: async (options) => {
            ensureLive("receive");
            return receive(verbs, options);
        },

        exchange: async (options) => {
            ensureLive("exchange");
            return exchange(verbs, options);
        },

        preparationOf: (id) => {
            ensureLive("preparationOf");
            return preparations.get(id);
        },

        get ready() {
            ensureLive("ready");
            return driving().ready;
        },
        // `async` so the refusal is a rejection, as the `Promise<void>` signature promises
        start: async () => {
            ensureLive("start");
            return driving().start();
        },
        stop: async () => {
            ensureLive("stop");
            return driving().stop();
        },
        [Symbol.asyncDispose]: async () => {
            if (disposed) return;
            disposed = true;
            // only a drive that exists: never build one just to dispose it
            await drive?.dispose();
        },
        onUpdate: (fn) => {
            ensureLive("onUpdate");
            return driving().onUpdate(fn);
        },
        recover: async (id) => {
            ensureLive("recover");
            return driving().recover(quoteIdOfSwapId(id));
        },
    };

    /** The client's own gated members, so a verb inherits `quote`'s re-pin and `accept`'s
     * restore-before-persist. */
    const verbs: VerbDeps = {
        wallet,
        quote: (input) => client.quote(input),
        accept: (quote) => client.accept(quote),
        ...(config.policy?.maxFee === undefined ? {} : { policyMaxFee: config.policy.maxFee }),
    };

    return client;
};
