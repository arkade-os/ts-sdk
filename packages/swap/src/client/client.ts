/**
 * The v2 client. `resolve()` and `quote()` create no swap record, watcher, drive or funding;
 * optional quote-reliability storage may update. `accept()` persists and registers with the drive.
 *
 * Construction is synchronous and INERT — no network, wallet or repository — so a client can be
 * built in a component body, and a missing dep for an unused corridor is not a construction error.
 */
import { hex } from "@scure/base";
import { captureSendDeadline, toXOnly, type IWallet } from "@arkade-os/sdk";
import { collectSwapRecords, type AssetSwapRepository } from "../repository";
import { resolveReceivePkScript } from "../offer";
import type { SwapOperator } from "../refund";
import { walletOperator } from "../refund";
import { corridorSet, type CorridorSet } from "./corridors/registry";
import {
    liveOperatorInfo,
    resolveCorridorBase,
    type CorridorBase,
    type CorridorOverrides,
} from "./corridors/deps";
import {
    discoveryIndex,
    type DiscoveryConfig,
    type DiscoveryIndex,
    type DiscoverySnapshot,
} from "./discovery";
import {
    ClientDisposed,
    DiscoverySnapshotUnavailable,
    MissingCorridorDep,
    NotCancellable,
    QuoteVerificationFailed,
    UnsupportedRoute,
} from "./errors";
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
import { captureAssetPayment } from "./assetPayment";
import { quoteViaRfq, solverFacingAmount } from "./quoteRfq";
import { verifyQuoteTtl } from "./verify";
import type { AuctionProvenance, Quote, QuoteId, QuoteInput, RouteResolution } from "./quote";
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
import {
    chooseMarket,
    marketOf,
    marketRefOf,
    usableMarkets,
    type MarketCandidate,
    type Market,
} from "./market";
import { nostrTransportFactory, type RfqTransportFactory } from "./transport";
import { createSolverHealth } from "./solverHealth";
import {
    canFailoverQuote,
    orderedSolverCandidates,
    isSolverReliabilityFailure,
    SolverRoutesUnavailable,
    type SolverCandidate,
} from "./solverRouting";

import {
    DEFAULT_OPEN_RFQ_RELAYS,
    freezeOpenRfqValue,
    hasPausedKnownBidder,
    openBidCandidates,
    type OpenRfqAuction,
    type OpenRfqOffer,
    type OpenRfqOptions,
} from "./openRfq";
import type { OpenRfqBid } from "../openRfq";
import { isBtcAsset } from "./assetId";

export interface SwapClientConfig {
    /** The wallet, and through it the operator: operator info, chain reads and broadcast all come from
     * it; no operator URL is accepted anywhere. */
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
    /** Override for the key of the operator's cosigner that emulates Arkade Script, 33-byte
     * compressed hex. */
    readonly emulatorPubkey?: string;
    /** Overrides the wallet's own connection; for tests and a second operator. */
    readonly operator?: SwapOperator;
    readonly fetchImpl?: typeof fetch;
    /** How a card's rendezvous is opened. Defaults to the card's Nostr transport, the only shipped
     * one that attests who answered; a transport that attests nobody fails the responder check. */
    readonly transportFor?: RfqTransportFactory;
}

export interface AcceptOptions {
    /** Final funding submission deadline, Unix seconds, capped by the quote expiry. */
    readonly validUntil?: number;
    /** `false` funds an offer with no packet. Default on: a seed-only restore finds an unfilled
     * deposit by it. Kept on the record, so a resumed funding chooses the same. */
    readonly attachOfferPacket?: boolean;
}

export interface SwapClient {
    /** Public pair/size discovery; no destination, invoice or wallet identity is broadcast. */
    openRfq(input: QuoteInput, options: OpenRfqOptions): Promise<OpenRfqAuction>;
    /** Verify binding terms with the explicitly chosen bidder; never routes to another solver. */
    quoteBid(auction: OpenRfqAuction, bid: OpenRfqOffer): Promise<Quote>;

    /** Eligible solvers in routing order, without negotiating or accepting a swap.
     * Cost estimates may fetch advertised feeds; debounce frequent UI calls. */
    candidates(input: QuoteInput): Promise<readonly SolverCandidate[]>;

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
     * Terminal cleanup: {@link stop}, abort open auctions, drain in-flight work, drop
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
     * The markets on the active snapshot, in the `Quote.market` shape plus each leg's announced
     * limits, with no RFQ and no disclosure. Shares `quote()`'s registry allowlist and addressability
     * filter but not its eligibility, so it can list a card `quote()` refuses. Fetches when no
     * snapshot is in hand, as `quote()` does, since callers reach for it BEFORE quoting.
     *
     * `key` is not unique: correlate with `resolve().market` on `key` + `source` + `discoveryPubkey`,
     * or `solver` on spot cards, which have no `discoveryPubkey`. These fields identify a solver's
     * market, not one card. A solver may publish several with different limits: `pair` separates a
     * flipped card, but nothing public separates fee tiers.
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
    /** Verified, binding terms; no swap is persisted, funded or watched. Advisory health may update.
     * Routing errors include SolverUnavailable, SolverResponseInvalid and SolverRoutesUnavailable;
     * narrow them with instanceof, separately from the closed SwapError taxonomy.
     * An explicit `solverId` from `candidates()` must still be eligible and never fails over. */
    quote(input: QuoteInput, options?: { readonly solverId?: string }): Promise<Quote>;
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
    accept(quote: Quote, options?: AcceptOptions): Promise<Swap>;
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
     * @throws {MaxFeeExceeded} as {@link pay} does; `Error` for any ceiling on a cross-asset swap.
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
    const activeQuotes = new Set<() => Promise<void>>();
    const activeAuctions = new Set<AbortController>();
    const auctionQuotes = new Map<QuoteId, Quote>();
    const auctions = new Map<
        OpenRfqAuction,
        {
            input: QuoteInput;
            route: ResolvedRoute;
            offers: Map<OpenRfqOffer, MarketCandidate>;
            receiveAddress?: string;
        }
    >();
    const health =
        config.policy?.solverRouting === undefined
            ? undefined
            : (config.policy.solverRouting.health ?? createSolverHealth());
    const recordHealth = (
        candidate: SolverCandidate,
        outcome: "success" | "failure",
        network: string,
    ) => {
        try {
            void health
                ?.record({ network, direction: candidate.direction }, candidate.solverId, outcome)
                .catch(() => {});
        } catch {}
    };
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
            const oldest = preparations.keys().next().value!;
            preparations.delete(oldest);
            auctionQuotes.delete(oldest);
        }
    };

    const prepare = async (
        resolvedRoute: ResolvedRoute,
        market: MarketCandidate,
        assetPayment?: ReturnType<typeof captureAssetPayment>,
        auction?: AuctionProvenance,
    ): Promise<Quote> => {
        const { base, corridors } = await resolved();
        corridors.get(resolvedRoute.legs.give.corridor);
        corridors.get(resolvedRoute.legs.take.corridor);
        ensureLive("quote");
        const quoteId = mintQuoteId();
        const now = Math.floor(Date.now() / 1000);
        const marketRef = marketRefOf(market, resolvedRoute.snapshot.ref);
        const checkAuctionTtl = () => {
            if (auction !== undefined)
                verifyQuoteTtl({
                    quoteId,
                    expiresAt: auction.winner.expiresAt,
                    now: Math.floor(Date.now() / 1000),
                    floorSeconds: config.policy?.quoteTtlFloorSeconds,
                });
        };

        // The card decides, and `marketBackendOf` is where it decided: an
        // asset card naming a rendezvous is negotiated like every other
        // route, and one advertising a feed and no rendezvous is priced from
        // the formula it advertises. Never a client switch — see
        // `marketBackendOf`.
        if (market.backend === "feed") {
            if (assetPayment !== undefined)
                throw new Error("assetPayment needs a negotiated BTC-to-asset market");
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
            ensureLive("quote");
            const issued = auction === undefined ? quote : { ...quote, auction };
            remember(quoteId, preparation);
            return issued;
        }

        // live: a snapshot could bind the tree to a signer key the operator no longer co-signs
        // for; an unreachable operator is `OperatorUnreachable` here, before funding
        const info = await liveOperatorInfo(wallet, { requireLive: true });
        if (assetPayment !== undefined && info.network !== base.networkName)
            throw new UnsupportedRoute("Arkade network changed during asset payment preparation");
        const rendezvous = market.card.discovery_pubkey;
        if (rendezvous === undefined) {
            // unreachable: `eligibleMarkets` drops a corridor card with no rendezvous, and an asset card without one prices from its feed
            throw new Error(`card ${market.card.solver} names no discovery key to address`);
        }
        checkAuctionTtl();
        const transport = await (config.transportFor ?? nostrTransportFactory)({
            card: market.card,
            solverPubkey: rendezvous,
            relays: market.card.transports?.nostr?.relays ?? [],
        });
        let closing: Promise<void> | undefined;
        const close = (): Promise<void> =>
            (closing ??= (async () => {
                activeQuotes.delete(close);
                await transport.close().catch(() => {});
            })());
        activeQuotes.add(close);
        try {
            ensureLive("quote");
            checkAuctionTtl();
            const { quote, preparation } = await quoteViaRfq({
                quoteId,
                route: resolvedRoute.pair,
                ...(assetPayment === undefined ? {} : { assetPayment }),
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
            ensureLive("quote");
            const issued = auction === undefined ? quote : { ...quote, auction };
            if (
                auction !== undefined &&
                preparation.route === "arkade->arkade" &&
                quote.assetPayment !== undefined &&
                quote.assetPayment.validUntil > auction.winner.expiresAt
            ) {
                const terms = { ...quote.assetPayment, validUntil: auction.winner.expiresAt };
                remember(quoteId, { ...preparation, assetPayment: terms });
                return { ...issued, assetPayment: terms };
            }
            remember(quoteId, preparation);
            return issued;
        } finally {
            // one negotiation, one transport; nothing else would close the relay subscription
            await close();
        }
    };

    const withSnapshot = async (
        input: QuoteInput,
        snapshot: DiscoverySnapshot,
    ): Promise<ResolvedRoute> => {
        const { base, corridors } = await resolved();
        const fixed = { peek: async () => snapshot, load: async () => snapshot };
        return resolveRoute(input, {
            corridors,
            network: base.networkName,
            discovery: fixed,
            ...(config.policy === undefined ? {} : { policy: config.policy }),
            mode: "quote",
        });
    };

    const client: SwapClient = {
        openRfq: async (input, options) => {
            ensureLive("openRfq");
            options.signal?.throwIfAborted();
            const { assetPayment, ...routeInput } = input;
            const receiveAddress = assetPayment?.receiveAddress;
            if (
                assetPayment !== undefined &&
                (typeof receiveAddress !== "string" ||
                    !receiveAddress ||
                    assetPayment.carrier !== undefined ||
                    routeInput.to !== undefined)
            )
                throw new UnsupportedRoute(
                    "open RFQ asset payments require assetPayment.receiveAddress without carrier options",
                );
            const captured = Object.freeze(routeInput);
            const { base, corridors, discovery } = await resolved();
            let snapshot: DiscoverySnapshot;
            try {
                snapshot = await discovery.load();
            } catch (error) {
                if (!(error instanceof DiscoverySnapshotUnavailable)) throw error;
                snapshot = {
                    markets: [],
                    ref: { fetchedAt: Date.now(), live: false, source: "local" },
                };
            }
            const routed = await withSnapshot(captured, snapshot);
            if (
                routed.pair !== "arkade->arkade" &&
                (!isBtcAsset(routed.give.asset) || !isBtcAsset(routed.take.asset))
            )
                throw new UnsupportedRoute("Cross-chain swaps currently support Bitcoin only", {
                    give: routed.legs.give.corridor,
                    take: routed.legs.take.corridor,
                });
            if (receiveAddress !== undefined) {
                if (
                    routed.pair !== "arkade->arkade" ||
                    !isBtcAsset(routed.give.asset) ||
                    isBtcAsset(routed.take.asset) ||
                    routed.amount?.on !== "take"
                )
                    throw new UnsupportedRoute(
                        "open RFQ asset payments require an exact BTC-to-asset route",
                    );
                const info = await liveOperatorInfo(wallet, { requireLive: true });
                if (info.network !== base.networkName)
                    throw new UnsupportedRoute(
                        "Arkade network changed during asset payment discovery",
                    );
                resolveReceivePkScript(
                    receiveAddress,
                    new Uint8Array(),
                    base.network.hrp,
                    toXOnly(hex.decode(info.signerPubkey), "ark signer key"),
                );
            }
            const canonicalInput = Object.freeze({
                ...captured,
                give: routed.give.asset,
                take: routed.take.asset,
            });
            if (routed.amount === undefined) throw new Error("open RFQ needs a positive amount");
            // Bids price what the directed quote will ask; offers report the recipient's net.
            const { quoted, claimFee = 0n } = solverFacingAmount(
                routed.pair,
                routed.amount,
                corridors,
            );
            const windowMs = options.windowMs ?? config.policy?.rfq?.windowMs ?? 3_000;
            if (!Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > 30_000)
                throw new RangeError("open RFQ windowMs must be between 1 and 30000");
            const configuredRelays = options.relays ?? config.policy?.rfq?.relays;
            const discoveredRelays = [
                ...new Set(
                    snapshot.markets.flatMap((market) => market.transports?.nostr?.relays ?? []),
                ),
            ];
            const relays =
                configuredRelays ??
                (discoveredRelays.length === 0
                    ? DEFAULT_OPEN_RFQ_RELAYS
                    : discoveredRelays.slice(0, 16));
            const request = {
                openId: hex.encode(crypto.getRandomValues(new Uint8Array(32))),
                pair: `${routed.give.asset}->${routed.take.asset}`,
                amountSide: routed.amount.on === "give" ? ("from" as const) : ("to" as const),
                amount: quoted.value,
            };
            const controller = new AbortController();
            const abort = () => controller.abort(options.signal?.reason);
            if (options.signal?.aborted) abort();
            else options.signal?.addEventListener("abort", abort, { once: true });
            activeAuctions.add(controller);
            const owned = new Map<string, { offer: OpenRfqOffer; candidate: MarketCandidate }>();
            const filter = async (
                bids: readonly OpenRfqBid[],
            ): Promise<readonly OpenRfqOffer[]> => {
                const offers: OpenRfqOffer[] = [];
                for (const bid of bids) {
                    if (controller.signal.aborted || disposed) return [];
                    const now = Math.floor(Date.now() / 1000);
                    if (
                        bid.openId !== request.openId ||
                        bid.pair !== request.pair ||
                        bid.amountSide !== request.amountSide ||
                        bid.validUntil <= now ||
                        (request.amountSide === "from" ? bid.fromAmount : bid.toAmount) !==
                            request.amount
                    )
                        continue;
                    let checked: ReturnType<typeof openBidCandidates>;
                    try {
                        checked = openBidCandidates(bid, routed, base.networkName, config.policy);
                    } catch {
                        continue;
                    }
                    if (checked === undefined || checked.candidates[0] === undefined) continue;
                    if (
                        await hasPausedKnownBidder(
                            bid.solverPubkey,
                            checked.signedCard.name,
                            routed,
                            base.networkName,
                            config.policy,
                        )
                    )
                        continue;
                    const candidateRoute = {
                        ...routed,
                        candidates: checked.candidates,
                        market: chooseMarket(checked.candidates, config.policy),
                    };
                    const eligible = await orderedSolverCandidates(
                        candidateRoute,
                        base.networkName,
                        config.policy,
                        feed.fetch,
                        false,
                        health,
                    );
                    const candidate = eligible[0];
                    if (candidate === undefined) continue;
                    const cached = owned.get(bid.id);
                    const offer =
                        cached?.offer ??
                        Object.freeze({
                            id: bid.id,
                            solverPubkey: bid.solverPubkey,
                            solverName: checked.signedCard.name,
                            market: candidate.card,
                            signedCard: checked.signedCard,
                            fromAmount: bid.fromAmount,
                            toAmount: bid.toAmount - claimFee,
                            expiresAt: bid.validUntil,
                        });
                    if (cached === undefined) owned.set(bid.id, { offer, candidate });
                    offers.push(offer);
                }
                // Later bids' policy reads can outlast earlier offers.
                const now = Math.floor(Date.now() / 1000);
                return Object.freeze(offers.filter((offer) => offer.expiresAt > now));
            };
            let updates = Promise.resolve();
            let progressRevision = 0;
            try {
                ensureLive("openRfq");
                const { collectOpenRfqBids } = await import("../openRfqTransport");
                ensureLive("openRfq");
                controller.signal.throwIfAborted();
                const bids = await collectOpenRfqBids(
                    { ...request, bidsUntil: Math.ceil((Date.now() + windowMs) / 1000) },
                    {
                        secretKey: options.secretKey,
                        relays: [...relays],
                        windowMs,
                        signal: controller.signal,
                        onBids:
                            options.onBids === undefined
                                ? undefined
                                : (bids) => {
                                      const revision = ++progressRevision;
                                      updates = updates.then(async () => {
                                          if (revision !== progressRevision) return;
                                          const offers = await filter(bids);
                                          if (
                                              revision === progressRevision &&
                                              !controller.signal.aborted &&
                                              !disposed
                                          ) {
                                              try {
                                                  options.onBids?.(offers);
                                              } catch {}
                                          }
                                      });
                                      void updates.catch(() => {});
                                  },
                    },
                );
                await updates;
                ensureLive("openRfq");
                if (controller.signal.aborted) throw controller.signal.reason;
                const offers = await filter(bids);
                ensureLive("openRfq");
                if (controller.signal.aborted) throw controller.signal.reason;
                const auction = Object.freeze({
                    id: request.openId,
                    input: canonicalInput,
                    pair: request.pair,
                    bids: offers,
                    closedAt: Math.floor(Date.now() / 1000),
                });
                for (const session of auctions.keys()) {
                    if (session.bids.every((bid) => bid.expiresAt <= auction.closedAt))
                        auctions.delete(session);
                }
                auctions.set(auction, {
                    input: canonicalInput,
                    route: routed,
                    offers: new Map(offers.map((offer) => [offer, owned.get(offer.id)!.candidate])),
                    ...(receiveAddress === undefined ? {} : { receiveAddress }),
                });
                if (auctions.size > 16) auctions.delete(auctions.keys().next().value!);
                return auction;
            } finally {
                activeAuctions.delete(controller);
                options.signal?.removeEventListener("abort", abort);
            }
        },

        quoteBid: async (auction, bid) => {
            ensureLive("quoteBid");
            const session = auctions.get(auction);
            const selected = session?.offers.get(bid);
            if (session === undefined || selected === undefined)
                throw new Error("bid was not issued by this client's auction");
            const checkExpiry = () => {
                verifyQuoteTtl({
                    quoteId: bid.id,
                    expiresAt: bid.expiresAt,
                    now: Math.floor(Date.now() / 1000),
                    floorSeconds: config.policy?.quoteTtlFloorSeconds,
                });
            };
            checkExpiry();
            const snapshot = {
                markets: [selected.card],
                ref: { fetchedAt: Date.now(), live: true, source: "injected" as const },
            };
            const routed = await withSnapshot(session.input, snapshot);
            const { base } = await resolved();
            if (
                await hasPausedKnownBidder(
                    bid.solverPubkey,
                    bid.solverName,
                    session.route,
                    base.networkName,
                    config.policy,
                )
            )
                throw new UnsupportedRoute("selected bidder is paused");
            const eligible = await orderedSolverCandidates(
                routed,
                base.networkName,
                config.policy,
                feed.fetch,
                false,
                health,
            );
            const candidate = eligible[0];
            if (candidate === undefined || candidate.card.discovery_pubkey !== bid.solverPubkey)
                throw new UnsupportedRoute("selected bidder is no longer enabled");
            const ranked = (offer: OpenRfqOffer) => ({
                bidder: offer.solverPubkey,
                amount: routed.amount?.on === "give" ? offer.toAmount : offer.fromAmount,
                amountOn: routed.amount?.on === "give" ? ("take" as const) : ("give" as const),
                expiresAt: offer.expiresAt,
            });
            checkExpiry();
            let quote: Quote | undefined;
            try {
                quote = await prepare(
                    routed,
                    candidate,
                    session.receiveAddress === undefined
                        ? undefined
                        : { receiveAddress: session.receiveAddress },
                    {
                        marketKey: auction.pair,
                        winner: ranked(bid),
                        losers: auction.bids.filter((other) => other !== bid).map(ranked),
                        closedAt: auction.closedAt,
                    },
                );
                ensureLive("quoteBid");
                checkExpiry();
                if (quote.give.amount > bid.fromAmount || quote.take.amount < bid.toAmount)
                    throw new QuoteVerificationFailed(
                        "amount",
                        `${bid.fromAmount}/${bid.toAmount}`,
                        `${quote.give.amount}/${quote.take.amount}`,
                    );
                const expiresAt = Math.min(quote.expiresAt, bid.expiresAt);
                verifyQuoteTtl({
                    quoteId: quote.id,
                    expiresAt,
                    now: Math.floor(Date.now() / 1000),
                    floorSeconds: config.policy?.quoteTtlFloorSeconds,
                });
                const bound = freezeOpenRfqValue({
                    ...quote,
                    expiresAt,
                });
                auctionQuotes.set(bound.id, bound);
                recordHealth(candidate, "success", base.networkName);
                return bound;
            } catch (error) {
                if (quote !== undefined) preparations.delete(quote.id);
                if (
                    isSolverReliabilityFailure(error) &&
                    bid.expiresAt - Math.floor(Date.now() / 1000) >
                        (config.policy?.quoteTtlFloorSeconds ?? 0)
                )
                    recordHealth(candidate, "failure", base.networkName);
                throw error;
            }
        },
        resolve: async (input) => {
            ensureLive("resolve");
            const routed = await route(input, "resolve");
            if (config.policy?.solverRouting === undefined) return routed.resolution;
            const { base } = await resolved();
            const candidates = await orderedSolverCandidates(
                routed,
                base.networkName,
                config.policy,
                feed.fetch,
                false,
                health,
            );
            const { market: _market, ...resolution } = routed.resolution;
            return {
                ...resolution,
                eligible: candidates.length,
                ...(candidates[0] === undefined
                    ? {}
                    : { market: marketRefOf(candidates[0], routed.snapshot.ref) }),
            };
        },

        candidates: async (input) => {
            ensureLive("candidates");
            const routed = await route(input, "quote");
            const { base } = await resolved();
            return orderedSolverCandidates(
                routed,
                base.networkName,
                config.policy,
                feed.fetch,
                true,
                health,
            );
        },

        quote: async (input, options) => {
            const assetPayment = captureAssetPayment(input.assetPayment);
            const solverId = options?.solverId;
            ensureLive("quote");
            const { base, corridors, discovery } = await resolved();
            let resolvedRoute = await route(input, "quote");

            // The responder check pins against the card's `discovery_pubkey`, which a cached card
            // carries unvalidated, so re-pin from the registry. If unreachable, the stale snapshot
            // comes back and the check refuses it (fail closed).
            if (
                (solverId === undefined && config.policy?.solverRouting === undefined
                    ? resolvedRoute.market?.backend === "rfq"
                    : resolvedRoute.candidates.some((candidate) => candidate.backend === "rfq")) &&
                !resolvedRoute.snapshot.ref.live
            ) {
                await discovery.load({ refresh: true });
                resolvedRoute = await route(input, "quote");
            }

            const ordered = await orderedSolverCandidates(
                resolvedRoute,
                base.networkName,
                config.policy,
                feed.fetch,
                true,
                health,
            );
            const candidates =
                solverId === undefined
                    ? ordered
                    : ordered.filter((candidate) => candidate.solverId === solverId);
            if (candidates.length === 0) {
                throw new UnsupportedRoute(
                    solverId === undefined
                        ? `no market serves ${resolvedRoute.legs.give.corridor}:` +
                              `${resolvedRoute.legs.give.assetId} -> ` +
                              `${resolvedRoute.legs.take.corridor}:${resolvedRoute.legs.take.assetId} ` +
                              "on the active discovery snapshot"
                        : "the selected solver is unavailable for this route",
                    {
                        give: resolvedRoute.legs.give.corridor,
                        take: resolvedRoute.legs.take.corridor,
                    },
                );
            }

            // Deps resolve when a route first touches a corridor: a dep overridden to nothing is
            // `MissingCorridorDep` here, before anything is disclosed or funded.
            corridors.get(resolvedRoute.legs.give.corridor);
            corridors.get(resolvedRoute.legs.take.corridor);

            const failover =
                solverId === undefined &&
                config.policy?.solverRouting !== undefined &&
                config.policy.solverRouting.failover !== false &&
                config.policy.selectMarket === undefined;
            const attempts: { solverId: string; error: unknown }[] = [];
            const attempted = new Set<string>();
            for (const candidate of failover ? candidates : candidates.slice(0, 1)) {
                if (attempted.has(candidate.solverId)) continue;
                attempted.add(candidate.solverId);
                try {
                    const quote = await prepare(resolvedRoute, candidate, assetPayment);
                    recordHealth(candidate, "success", base.networkName);
                    return quote;
                } catch (error) {
                    ensureLive("quote");
                    if (isSolverReliabilityFailure(error))
                        recordHealth(candidate, "failure", base.networkName);
                    if (!failover || !canFailoverQuote(error)) throw error;
                    attempts.push({ solverId: candidate.solverId, error });
                }
            }
            if (attempts.length === 1) throw attempts[0].error;
            throw new SolverRoutesUnavailable(attempts);
        },

        accept: async (quote, options) => {
            const issued = auctionQuotes.get(quote.id);
            if (issued !== undefined && issued !== quote)
                throw new Error("auction quote must be the original issued quote");
            const requestedDeadline = captureSendDeadline(options?.validUntil);
            const validUntil =
                issued === undefined
                    ? requestedDeadline
                    : Math.min(issued.expiresAt, requestedDeadline ?? issued.expiresAt);
            ensureLive("accept");
            const { corridors } = await resolved();
            const drive = driving();
            // before the persist: the restore indexes stored records, and resuming one the drive
            // had not read would register a second live swap for the same lockup
            await drive.ready;
            const preparation = preparations.get(quote.id);
            return acceptQuote({
                quote,
                ...(validUntil === undefined ? {} : { validUntil }),
                ...(options?.attachOfferPacket === false ? { attachOfferPacket: false } : {}),
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
            const { base, discovery } = await resolved();
            // `load`, as `quote()` reads it: a never-routed client must not refuse where the quote
            // would not
            const snapshot = await discovery.load();
            // the allowlist and addressability filter, not eligibility: a card `quote()` refuses
            // can still be listed
            return usableMarkets(snapshot, config.policy).map((card) =>
                marketOf(card, snapshot.ref, base.networkName),
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
            for (const controller of activeAuctions)
                controller.abort(new ClientDisposed("openRfq"));
            auctions.clear();
            auctionQuotes.clear();
            await Promise.allSettled([...activeQuotes].map((close) => close()));
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
