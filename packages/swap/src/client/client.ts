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
 * Construction stays synchronous and INERT. It touches no network, no wallet
 * and no repository: the operator read, the corridor deps, the market index and
 * — from M5 — the restore-read are all driven by the first call that needs
 * them, which for the drive is the first `await client.ready`. That is what
 * lets a client be built in a component body and only cost something when
 * somebody asks it a question, and what keeps a missing dep for a corridor
 * nobody uses from being a construction failure.
 *
 * The drive is composed onto that, not folded into it. `resolve()` and
 * `quote()` are unchanged and still touch nothing durable; `accept()` gained one
 * thing — it registers the swap it just persisted — and everything else the
 * lifecycle needs lives behind {@link createSwapDrive}.
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
import { acceptQuote, type QuotePreparation } from "./accept";
import { createSwapDrive, type RecoveryResult, type SwapDrive } from "./drive";
import { walletLockupIndexer } from "./driveRecords";
import type { SwapUpdate, Unsubscribe } from "./outcome";
import type { Swap } from "./record";
import type { SwapPolicy } from "./policy";
import { feedFetch, quoteFromFeed, type FeedFetch } from "./quoteOffer";
import { quoteViaRfq } from "./quoteRfq";
import type { Quote, QuoteId, QuoteInput, RouteResolution } from "./quote";
import { resolveRoute, type ResolvedRoute } from "./resolve";
import { nostrTransportFactory, type RfqTransportFactory } from "./transport";

export interface SwapClientConfig {
    /**
     * The wallet, and through it the operator: server info, chain reads and
     * broadcast all come from it, and no server URL is accepted anywhere.
     */
    readonly wallet: IWallet;
    /**
     * Storage: the accept records, the markets cache, the restore-scan cursor.
     *
     * One seam for all three — the arkade corridor's `repository` override
     * defaults to this object, so a client cannot write records to one store
     * and read its cache from another.
     *
     * No implicit default, and never an in-memory fallback: silently losing
     * active swaps is the thing a storage default exists to prevent. A browser
     * consumer passes `IndexedDbAssetSwapRepository`, a Node consumer imports
     * `@arkade-os/swap/node` for the file-backed SQLite default, and a test
     * passes `InMemoryAssetSwapRepository` — explicitly, which is the only way
     * ephemeral storage is available. `accept()` without one is
     * `MissingCorridorDep("arkade", "repository")`; `quote()` and `resolve()`
     * work without one, since neither persists anything.
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
     * The restore-read, and — when it armed — the first pass after it.
     *
     * There is no required `start()`. Construction stays inert and this is what
     * drives the one read of the repository; under `drive: "auto"` the read arms
     * the loop when it finds live work, and the first `accept()` arms it when it
     * does not. A resumed swap may already be past a deadline, which is why
     * arming runs one pass immediately rather than waiting out an interval.
     *
     * **Rejects only when the repository itself is unreadable.** A client that
     * cannot read its own records cannot drive them safely. Everything
     * per-record resolves this and surfaces through the normal channels instead:
     * a corrupt record is filtered, a swap that will not rebuild reports off its
     * record, and a first pass that finds a swept lockup reports
     * `needs_recovery` through {@link onUpdate}.
     */
    readonly ready: Promise<void>;

    /**
     * Arm the drive. Idempotent, and required only by `drive: "manual"`.
     *
     * Double arming is a no-op, so a React double-mount and two concurrent
     * callers are both safe.
     *
     * @throws {SwapDriveRefusedError} under `drive: "readonly"`, which actuates
     *   nothing — silence would leave two contradictory instructions standing.
     */
    start(): Promise<void>;

    /**
     * Release the live resources this instance owns, and stay reusable.
     *
     * Timers cleared, the contract subscription dropped, in-flight actions left
     * to run to completion, and outstanding work left where it is: stop/start is
     * a pause, not a cancellation. What is NOT undone is durable — the records
     * stay, and so do the wallet's contract registrations, because dropping one
     * unwatches a funded lockup.
     */
    stop(): Promise<void>;

    /**
     * Terminal cleanup: {@link stop} plus draining what is in flight, dropping
     * every listener, and making the instance terminal.
     *
     * It drains rather than returning while a refund push is mid-flight —
     * nothing in this package takes an `AbortSignal`, so the alternative is
     * calling an instance terminal while it is still moving money. Durable swap
     * records, contract registrations and recovery metadata all survive it: a
     * new client restores and resumes from them.
     */
    [Symbol.asyncDispose](): Promise<void>;

    /**
     * Every outcome transition, in one vocabulary for both families.
     *
     * Subscribing replays the current outcome of every swap this client knows,
     * then streams transitions. Delivery is idempotent per `(swapId, outcome)`,
     * and because the outcome is DERIVED rather than stored the key is the
     * derived one — so the legal `claimed -> claimable` backslide, which
     * produces `funded` twice, is delivered once.
     */
    onUpdate(fn: (update: SwapUpdate) => void): Unsubscribe;

    /**
     * Recover a swap whose value was swept, then run one immediate pass.
     *
     * The recovery round itself is the wallet's — this package deliberately
     * builds none — and it takes no outpoints: it reads the whole wallet, drops
     * what it cannot settle, and caps the batch, deferring the overflow. So a
     * settlement txid is not success, and this re-reads the named lockup to
     * answer whether THIS swap's outputs were included.
     *
     * @throws {SwapDriveRefusedError} under `drive: "readonly"`; for a lockup
     *   still inside its refund window, where a round including it can fail the
     *   whole batch; and for a swap with nothing swept — which is what a
     *   `needs_recovery` that came from `needs_counterparty` is.
     */
    recover(swapId: QuoteId): Promise<RecoveryResult>;

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
     * Make the quote durable, then move the value.
     *
     * One ordering, on every route: the record and its secrets are at rest
     * before anything irreversible, and the funding txid is a later best-effort
     * write. Idempotent by quote id and only by quote id — a second call with
     * the same quote returns or resumes the stored swap and never mints a
     * second invoice or funds a second time.
     *
     * Does not arm a drive loop or a watcher: this returns once the record is
     * durable. On `lightning -> arkade` that means a durable invoice the payer
     * can be shown — which is the point of the ordering, since showing one
     * whose claim secret is still in memory is what buys a lockup nobody can
     * claim.
     *
     * @throws {QuoteExpired} past `quote.expiresAt`; the client never re-quotes.
     * @throws {InsufficientFunds} before the persist, on funding routes only.
     * @throws {AcceptConflict} when a record for this quote id contradicts it.
     * @throws {MissingCorridorDep} when the client was given no repository.
     */
    accept(quote: Quote): Promise<Swap>;
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

    // Built eagerly and inert: the drive touches nothing until its own `ready`
    // is awaited, and it takes the corridor set as a thunk precisely so
    // constructing it costs no operator read. The indexer is the wallet's own
    // reader — this client accepts no server URL and no provider anywhere.
    let drive: SwapDrive | undefined;
    const driving = (): SwapDrive =>
        (drive ??= createSwapDrive({
            wallet,
            operator,
            ...(config.repository === undefined ? {} : { repository: config.repository }),
            corridors: async () => (await resolved()).corridors,
            ...(config.policy?.drive === undefined ? {} : { mode: config.policy.drive }),
            indexer: walletLockupIndexer(wallet),
        }));

    let context:
        | Promise<{ base: CorridorBase; corridors: CorridorSet; discovery: DiscoveryIndex }>
        | undefined;
    /** A rejected init is not cached. The read behind it is the reachable-or-not
     * kind — an operator that cannot be reached and no persisted snapshot to
     * fall back on — and caching that rejection would strand the client for its
     * whole lifetime over one unreachable moment. Same rule as the sqlite
     * repository's `ensureInit`. */
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

        accept: async (quote) => {
            const { corridors } = await resolved();
            const drive = driving();
            // Before the persist, not after: the restore is what indexes the
            // stored records, and an accept that resumed one the drive had not
            // read would register a second live swap for the same lockup.
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

        preparationOf: (id) => preparations.get(id),

        get ready() {
            return driving().ready;
        },
        start: () => driving().start(),
        stop: () => driving().stop(),
        [Symbol.asyncDispose]: () => driving().dispose(),
        onUpdate: (fn) => driving().onUpdate(fn),
        recover: (id) => driving().recover(id),
    };
};
