/**
 * `@arkade-os/swap` — the v2 swap client.
 *
 * The caller states a route: what to give, what to take, and where the value
 * ends up. Everything that used to be a caller obligation happens behind
 * `quote()` and `accept()` — the destination parse, the corridor pair, the
 * market lookup, the rendezvous, the amount encoding, the covenant derivation,
 * the funding packet, the persist-before-watch ordering, the claim and the
 * refund. `README.md` is one chain per route and nothing else.
 *
 * Three layers reach that surface, in the order a consumer meets them:
 *
 * 1. **The verbs.** `pay`, `receive` and `exchange` are `quote` -> fee ceiling
 *    -> `accept`, and add no capability the client did not already have.
 * 2. **The client.** `createSwapClient` returns the same object the verbs use;
 *    reach for it when you want the terms before committing to them, the
 *    history, a cancel, or the update stream.
 * 3. **The protocol floor.** Everything below the client from the v1 line —
 *    requests, covenants, records, the RFQ transports — lives at
 *    `@arkade-os/swap/protocol`, under `@deprecated` pointers naming what
 *    replaced it, and nowhere else. It is a floor for solvers and
 *    terms-showing apps, not a staging area: nothing is scheduled to disappear
 *    from it.
 *
 * ## What this root is, and what it is not
 *
 * The root is a CURATED surface: the client factory, the three verbs, the
 * route/amount/asset vocabulary, the sixteen-member error taxonomy, the
 * durable record `accept()` writes, the storage backends, and the payment
 * rails. Everything else the client's modules define — the drive, the corridor
 * modules, the RFQ wire builders, quote preparation and verification, the
 * record navigation and outcome derivations — is orchestration below the
 * verbs, and it lives at `@arkade-os/swap/advanced`, NOT here.
 *
 * That split is a deliberate break within `0.1.0`, on top of the break against
 * `0.1.0-rc.1` this release already is. An earlier revision of this root was
 * `export * from "./client"`, which put ~160 names here — `acceptQuote`,
 * `createSwapDrive`, `corridorSet`, `quoteViaRfq`, `walletLockupIndexer` and
 * every helper beside them — and committed the package to supporting internals
 * the verbs exist to absorb. A name on the root is a support promise, so the
 * boundary is now the point: what is here is the v2 surface; what is advanced
 * is one specifier edit away; nothing moved to `/protocol`, which is still
 * exclusively the v1 floor. `V2_API.md` is the UX note, `README.md` compiles
 * against exactly this root, and `test/exports.test.ts` asserts the boundary
 * in both directions.
 *
 * The v1 names are NOT re-exported here, and that is deliberate. `0.1.0` breaks
 * against `0.1.0-rc.1` regardless — the client took the `createSwapClient` name
 * and the `./client` subpath is gone — so a window would not spare anyone a
 * migration, only split it into two, while leaving 200 v1 names on a root whose
 * whole claim is to be the v2 surface. One break, one migration, one specifier
 * edit for anything that reaches below the client. `MIGRATION.md` maps it.
 *
 * Two subpaths are neither deprecations nor going anywhere: `./nostr` is the
 * hand-built transport floor, and `./node` plus `./repositories/*` are the
 * storage backends. `./client` is gone — the client is this root.
 */

// ── The client ──────────────────────────────────────────────────────────────
// The factory, the object it returns, and the config it takes. `Config`'s
// field types that a caller names when writing one — discovery, corridor
// overrides, policy, the transport factory — are exported with it.
export {
    createSwapClient,
    type SwapClient,
    type SwapClientConfig,
    type SwapFilter,
} from "./client/client";
export type { DiscoveryConfig, DiscoverySnapshot } from "./client/discovery";
export { REGISTRY_URL } from "./client/discovery";
export type { CorridorOverrides } from "./client/corridors/deps";
export type { DriveMode, RfqAuctionPolicy, SwapPolicy } from "./client/policy";
export type { RfqTransportFactory } from "./client/transport";

// ── The verbs ───────────────────────────────────────────────────────────────
// `pay`, `receive` and `exchange`, and the option/return vocabulary a caller
// types against them. `enforceFeeCeiling` is the verbs' own plumbing and stays
// on `./advanced`.
export {
    exchange,
    pay,
    receive,
    type ExchangeOptions,
    type FeeCeiling,
    type PayOptions,
    type PayResult,
    type ReceiveArtifact,
    type ReceiveOptions,
    type ReceiveRequest,
    type VerbDeps,
} from "./client/verbs";

// ── The route vocabulary ────────────────────────────────────────────────────
// The closed `Route` union and the terms `quote()` answers in. All types: the
// only way to state a route is a `QuoteInput`, and the only way to hold terms
// is the `Quote` the client returns.
export type {
    Artifact,
    AssetOn,
    DepositArtifact,
    Endpoint,
    Ep,
    Instrument,
    Route,
} from "./client/route";
export type { CorridorId } from "./client/corridor";
export type {
    AssetRef,
    AuctionMarketRef,
    AuctionProvenance,
    CardMarketRef,
    MarketBackend,
    MarketRef,
    PinnedAmount,
    Quote,
    QuoteId,
    QuoteInput,
    QuoteLeg,
    RankedBid,
    ResolvedEndpoint,
    RouteResolution,
    SnapshotRef,
} from "./client/quote";
export type { Market } from "./client/market";

// ── Asset ids and amounts ───────────────────────────────────────────────────
// CAIP-19 with the rail as the CAIP-2 namespace; `bigint` atomic units inside,
// `Amount` at the UI boundary. The alias layer (`canonicalAssetId`) is human
// input's way in; the constants and parse/format helpers are the vocabulary.
export {
    ARKADE_ASSET_NAMESPACE,
    arkadeAsset,
    AssetIdError,
    assetPartOf,
    BITCOIN_RAILS,
    bitcoinNetworkOf,
    BTC_ASSET_PART,
    btcOn,
    formatAssetId,
    isAssetId,
    isNetworkRef,
    issuanceOf,
    parseAssetId,
    railOf,
    RAILS,
    sameAsset,
    type AssetId,
    type AssetIdRefusal,
    type AssetNamespace,
    type AssetPart,
    type BitcoinRail,
    type NetworkRef,
    type ParsedAssetId,
    type Rail,
} from "./client/assetId";
export {
    canonicalAssetId,
    type AssetAliasTable,
    type RegisteredAsset,
} from "./client/aliases";
export {
    Amount,
    AmountFormatError,
    fromAtomicDecimal,
    isAtomicDecimal,
    toAtomicDecimal,
    type AmountRefusal,
    type AssetScale,
    type AtomicDecimal,
    type DisplayDecimal,
} from "./client/amount";

// ── The error taxonomy ──────────────────────────────────────────────────────
// Sixteen classes, each a condition noun, plus the base type, the name union,
// the complete list and the guard. `SwapRefusal` — the solver declining, a
// decision rather than a fault — is the one member the protocol layer owns;
// the other fifteen name what the client refused and why.
export {
    AcceptConflict,
    AmbiguousDestination,
    AmountEncodingUnsupported,
    AmountMismatch,
    ClientDisposed,
    DiscoverySnapshotUnavailable,
    InconsistentRoute,
    InsufficientFunds,
    isSwapError,
    MaxFeeExceeded,
    MissingCorridorDep,
    NotCancellable,
    OperatorUnreachable,
    QuoteExpired,
    QuoteVerificationFailed,
    SWAP_ERROR_NAMES,
    SwapRefusal,
    UnsupportedRoute,
    type QuoteCheck,
    type SwapError,
    type SwapErrorName,
} from "./client/errors";
// Thrown by the PUBLIC client off the taxonomy — `start()` and `recover()`
// under `drive: "readonly"` — so it is catchable from the root too.
export { SwapDriveRefusedError } from "./client/drive";

// ── The durable record ──────────────────────────────────────────────────────
// What `accept()` writes, the ids that address it, the outcome vocabulary
// `onUpdate` streams, and the results `cancel()`/`recover()` answer. The
// builders and projections below this — `recordLeg`, `corridorOutcome`,
// `splitRecords` and friends — are the drive's, on `./advanced`.
export {
    assetSwapIdOf,
    familyOfSwapId,
    quoteIdOfSwapId,
    type AssetSwapId,
    type CorridorSwapRecord,
    type OfferSwapRecord,
    type RecordedArtifact,
    type RecordedEndpoint,
    type RecordedInstrument,
    type RecordedLeg,
    type Swap,
    type SwapFamily,
    type SwapRecord,
    type SwapRecordCommon,
} from "./client/record";
export type {
    CorridorKind,
    Outcome,
    RawState,
    SwapUpdate,
    Unsubscribe,
} from "./client/outcome";
export type { CancelOutcome } from "./client/cancel";
export type { RecoveryResult } from "./client/drive";

// Storage. `SwapClientConfig.repository` takes the interface; the backends are
// the browser default, the explicit ephemeral one, and — off `./node` and
// `./repositories/*` — SQLite and Realm. There is no implicit default: a client
// that accepts a swap with nowhere to write it is the silent loss the rule
// exists to forbid.
export {
    type AssetSwapRepository,
    type MarketsCacheEntry,
    InMemoryAssetSwapRepository,
} from "./repository";
export { IndexedDbAssetSwapRepository } from "./indexedDbRepository";

// `SwapClientConfig.operator`: the structural slice of the operator connection,
// for a second operator or a test. The wallet supplies it otherwise, and no
// server URL is accepted anywhere.
export { type SwapOperator } from "./refund";

// The payment rails, for an app that routes through core's payment router
// rather than calling the verbs itself. These are the v2 rails — the `solver-*`
// ones they replaced are on the protocol floor below.
export { LIGHTNING_RAIL, lightningRail } from "./payment/lightning";
export {
    ONCHAIN_SWAP_RAIL,
    claimFeeSats,
    onchainSwapRail,
    type OnchainSwapRailDeps,
} from "./payment/onchainSwap";
export {
    SWAP_ROUTER_PRIORITY,
    createSwapPaymentRouter,
    type SwapPaymentRouterConfig,
} from "./payment/router";
export { PAYMENT_STATUS, isTerminalStatus, paymentStatusOf } from "./payment/status";
export {
    SwapPaymentFailedError,
    railAvailable,
    receiverExact,
    swapHandle,
    type SwapRailClient,
} from "./payment/swapRail";
