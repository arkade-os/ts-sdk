/**
 * `@arkade-os/swap` — the v2 swap client.
 *
 * The caller states a route: what to give, what to take, and where the value ends up. The
 * destination parse, corridor pair, market lookup, rendezvous, amount encoding, covenant
 * derivation, funding packet, persist-before-watch ordering, claim and refund all happen behind
 * `quote()` and `accept()`. `README.md` is one chain per route.
 *
 * Three layers, in the order a consumer meets them:
 *
 * 1. **The verbs.** `pay`, `receive` and `exchange` are `quote` -> fee ceiling -> `accept`.
 * 2. **The client.** `createSwapClient`, for terms before committing, history, cancel, or the
 *    update stream.
 * 3. **The protocol floor.** The v1 line (requests, covenants, records, RFQ transports) lives at
 *    `@arkade-os/swap/protocol` under `@deprecated` pointers. A floor for solvers and terms-showing
 *    apps; nothing is scheduled to disappear from it.
 *
 * This root is CURATED: a name here is a support promise. Orchestration below the verbs (the drive,
 * corridor modules, RFQ wire builders, quote preparation, record navigation) is on
 * `@arkade-os/swap/advanced`; v1 names are not re-exported (`MIGRATION.md` maps them).
 * `test/exports.test.ts` asserts the boundary in both directions. `./nostr` (transport floor),
 * `./node` and `./repositories/*` (storage backends) are stable subpaths.
 */

// ── The client ──────────────────────────────────────────────────────────────
// The factory, its object and config, plus the field types a caller names when writing a config.
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
// `enforceFeeCeiling` is the verbs' own plumbing and stays on `./advanced`.
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
// Types only: a route is stated as a `QuoteInput`, and terms are held as the returned `Quote`.
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
    RestoredMarketRef,
    RankedBid,
    ResolvedEndpoint,
    RouteResolution,
    SnapshotRef,
} from "./client/quote";
export type { Market } from "./client/market";

// ── Asset ids and amounts ───────────────────────────────────────────────────
// CAIP-19 with the rail as the CAIP-2 namespace; `bigint` atomic units inside, `Amount` at the UI
// boundary, `canonicalAssetId` for human input.
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
// `SwapRefusal` (the solver declining — a decision, not a fault) is the one member the protocol
// layer owns; the others name what the client refused.
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
export {
    RFQ_REFUSAL_ERROR_CODES,
    isRfqRefusalErrorCode,
    type RfqRefusalDetail,
    type RfqRefusalErrorCode,
    type RfqRefusalUnit,
} from "./rfq";

// ── The durable record ──────────────────────────────────────────────────────
// The builders and projections below this (`recordLeg`, `splitRecords`, ...) are on `./advanced`.
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

// Storage. SQLite and Realm are off `./node` and `./repositories/*`. No implicit default: accepting
// a swap with nowhere to write it is the silent loss the rule forbids.
export {
    type AssetSwapRepository,
    type MarketsCacheEntry,
    InMemoryAssetSwapRepository,
} from "./repository";
export { IndexedDbAssetSwapRepository } from "./indexedDbRepository";
export {
    appendArkadeScript,
    CLAIM_PACKET_TYPE,
    claimPacketShape,
    type ClaimPacketShape,
    SEALED_CIPHERTEXT_LENGTH,
} from "./claimPacket";
export {
    restoreAssetSwapRepository,
    type AssetSwapRestoreChange,
    type RestoreAssetSwapRepositoryOptions,
    type RestoreAssetSwapRepositoryResult,
} from "./restoreRepository";
export {
    registerAssetSwapRestore,
    type RegisterAssetSwapRestoreOptions,
} from "./registerRestore";

// `SwapClientConfig.operator`, for a second operator or a test.
export { type SwapOperator } from "./refund";

// v1-declared names the v2 surface REFERENCES — something a caller authors, implements, reads or
// catches — so a consumer can name them without reaching into deprecated `/protocol`. Hence no
// `@deprecated` tag on them.
export { type AssetSwap } from "./store";
export { type InvoiceFacts } from "./rfq";
export { type ChainSource } from "./onchainHtlc";
export { LockupRegistrationFailed } from "./lockupContract";
export { type LockupSpendIndexer } from "./refund";
export { type SwapContractRegistry } from "./swapManager";
export { isRfqSwapTerminal, type RfqSwapState } from "./rfqSwapState";

// The v2 payment rails, for apps routing through core's payment router instead of the verbs. The
// `solver-*` rails they replaced are on the protocol floor.
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
