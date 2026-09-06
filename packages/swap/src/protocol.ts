/**
 * The v1 protocol building blocks, off the root and under this name.
 *
 * Everything here was the integration surface before the v2 client, and every
 * name carries an `@deprecated` pointer on its declaration naming what replaces
 * it — editors reach the tag through this re-export, which is why nothing moved
 * files to get here. The barrel exists so that "deprecated" does not mean
 * "deleted": a solver, a terms-showing app or anything reaching below the
 * client keeps a floor, while the root stops advertising it.
 *
 * None of these is on the package root any more, and there is no window in which
 * they were both places. `0.1.0` breaks against `0.1.0-rc.1` whatever this
 * barrel does — the v2 client took the `createSwapClient` name — so a period of
 * root re-exports would have split one migration into two while leaving 200 v1
 * names on a root whose whole claim is to be the v2 surface. The migration is
 * one specifier edit instead, taken once, and not a rewrite.
 *
 * Nor is this a staging area. Nothing here is scheduled to disappear; the
 * `@deprecated` tag means "the client does this for you now", not "this is
 * going away next release".
 *
 * What is NOT here is what the client absorbed outright — request and pair
 * building, the covenant timing constants, the terminal-state sets, coverage
 * retirement, the drive's own transition builder — and the #793 facade the v2
 * client replaced by name. Those have no floor by design: re-exporting a
 * vocabulary the closed `Route` union exists to end would keep the misroute
 * class typed and reachable. `MIGRATION.md` maps every one of them.
 *
 * Generated shape, hand-owned content: `pnpm --filter @arkade-os/swap test`
 * diffs this barrel against `scripts/dispositions.json` and fails on a name in
 * one and not the other.
 */
export {
    type RfqSwapActivityDeps,
    rfqSwapActivityInputs,
    type SwapActivityInput,
    swapActivityResolver,
} from "./activity";
export {
    arkadeRefunder,
    type ArkadeRefunderDeps,
} from "./arkadeRefunder";
export { chainSourceFrom } from "./chainSource";
export {
    awaitLockupFunding,
    claimReceiveLockup,
    LockupAmountMismatchError,
    pushClaim,
} from "./claim";
export {
    type ClaimPacketInput,
    sealClaimPacket,
    type SealedClaimPacket,
} from "./claimPacket";
export {
    LockupContractMissing,
    lockupContractParams,
    type LockupContractReader,
    type LockupContractWriter,
    LockupRegistrationFailed,
    registerLockupContract,
    SWAP_LOCKUP_CONTRACT_KIND,
    SWAP_LOCKUP_CONTRACT_LABEL,
    SWAP_LOCKUP_CONTRACT_TYPE,
} from "./lockupContract";
export {
    discoverMarkets,
    type DiscoverMarketsOptions,
    findMarket,
    makeCachedFeedFetch,
    type PlanError,
    QUOTE_OPTIONS,
    validatePlan,
} from "./markets";
export {
    cancelOffer,
    createOffer,
    decodeOffer,
    encodeOffer,
    NoSpendableDepositError,
    type Offer,
    OFFER_PACKET_TYPE,
    offerContract,
    OfferCovenantMismatchError,
    swapPrograms,
} from "./offer";
export {
    awaitOnchainFill,
    buildHtlcClaim,
    buildHtlcRefund,
    type ChainSource,
    type ChainUtxo,
    claimOnchainFill,
    classifyOnchainHtlc,
    extractPreimage,
    type HtlcUtxo,
    l1ScriptForAddress,
    LOCKTIME_THRESHOLD,
    MAX_MIN_CONFIRMATIONS,
    newPreimage,
    ONCHAIN_CLAIM_MARGIN_SECONDS,
    ONCHAIN_DUST_SATS,
    ONCHAIN_ORDER_MARGIN_SECONDS,
    ONCHAIN_SECONDS_PER_BLOCK,
    type OnchainHtlc,
    type OnchainHtlcParams,
    type OnchainHtlcPhase,
    onchainHtlcScript,
    type OnchainNetwork,
    paymentHashOf,
} from "./onchainHtlc";
export {
    CROSS_ASSET_RAIL,
    type CrossAssetPhase,
    crossAssetRail,
    type CrossAssetRailDeps,
    type CrossAssetSwap,
} from "./payment/crossAsset";
export {
    solverRendezvous,
    type SolverRendezvous,
} from "./payment/rendezvous";
export {
    SOLVER_LIGHTNING_RAIL,
    solverLightningRail,
    type SolverLightningRailDeps,
    solverLightningRendezvous,
    type SolverLightningSend,
} from "./payment/solverLightning";
export {
    SOLVER_ONCHAIN_RAIL,
    solverOnchainRail,
    type SolverOnchainRailDeps,
    solverOnchainRendezvous,
    type SolverOnchainSend,
} from "./payment/solverOnchain";
export {
    awaitRfqResolution,
    findLockupVtxos,
    isRfqTerminal,
    type LockupFate,
    LockupNeedsRecoveryError,
    type LockupSpend,
    type LockupSpendIndexer,
    type LockupVtxo,
    pushRefundWithoutReceiver,
    readLockupFate,
    refundIfUnresolved,
    type RefundIndexer,
    type RefundOutcome,
} from "./refund";
export {
    type RefundBlockedReason,
    RefundNotLocallyPossibleError,
    senderIdentityForSwapRecord,
} from "./refundBlocked";
export {
    classifyDepositSpend,
    classifySpend,
    restoreAssetSwaps,
    type RestoreIndexer,
    type SpendKind,
    spendTxidsOf,
    type Tx,
} from "./restore";
export {
    AddressMismatch,
    ARKADE_BTC,
    arkadeAssetLeg,
    arkadeSwapRequest,
    deriveLightningReceive,
    deriveOnchainReceive,
    deriveOnchainSend,
    httpTransport,
    type InvoiceFacts,
    LIGHTNING_BTC,
    LIGHTNING_RECEIVE_PAIR,
    LIGHTNING_SEND_PAIR,
    lightningReceiveContract,
    type LightningReceiveContractParams,
    lightningReceiveRequest,
    lightningSendContract,
    type LightningSendContractParams,
    lightningSendRequest,
    ONCHAIN_BTC,
    ONCHAIN_RECEIVE_PAIR,
    ONCHAIN_SEND_PAIR,
    onchainReceiveRequest,
    onchainSendRequest,
    type RelaySocket,
    relayTransport,
    requestLightningReceive,
    requestLightningSend,
    requestOnchainReceive,
    requestOnchainSend,
    type RfqQuote,
    type RfqRefusalReason,
    type RfqStatus,
    type RfqTransport,
    unilateralClaimDelay,
    unilateralRefundDelay,
    unilateralRefundWithoutReceiverDelay,
    verifyLockupAddress,
    verifyReceiveInvoice,
} from "./rfq";
export {
    type LightningReceiveProfile,
    type LightningSendProfile,
    onchainSendProfile,
    type OnchainSendProfile,
} from "./rfqCorridors";
export {
    rfqClaimSecretOf,
    type RfqClaimSecretProjection,
    type RfqHashlockProjection,
    rfqSecretsProfile,
    rfqSignerOf,
    type RfqSignerProjection,
} from "./rfqProfileParts";
export {
    createRfqSwapRecord,
    type LockupParams,
    normalizeRfqSwapRecord,
    type PersistableRfqSwap,
    rebuildRfqSwap,
    RFQ_SWAP_RETENTION_SECONDS,
    type RfqSwapOrigin,
    rfqSwapOriginOf,
    type RfqSwapRecord,
    shouldRetainRfqSwap,
    updateRfqSwapRecord,
} from "./rfqRecord";
export {
    isRfqSwapTerminal,
    type RfqSwapState,
} from "./rfqSwapState";
export {
    addAssetSwap,
    type AssetSwap,
    type AssetSwapStatus,
    BTC_ASSET_ID,
    getAssetSwaps,
    type PreimageBlockedReason,
    preimageForSwapRecord,
    PreimageNotRecoverableError,
    type SwapSecretsProjection,
    swapSecretsToRecord,
    updateAssetSwap,
} from "./store";
export {
    type ArkadeRefundResult,
    type AvailableRfqSwapManagerCallbacks,
    type LightningReceiveSwap,
    type LightningSendSwap,
    nextOnchainAction,
    type OnchainSendAction,
    type OnchainSendSwap,
    type RfqRestoreFailure,
    type RfqRestoreOptions,
    type RfqRestoreResult,
    type RfqSwap,
    type RfqSwapActionName,
    type RfqSwapLockup,
    RfqSwapManager,
    type RfqSwapManagerCallbacks,
    type RfqSwapManagerConfig,
    type RfqSwapManagerDeps,
    type RfqSwapManagerEvents,
    RfqSwapOriginRequired,
    type RfqSwapOutcome,
    type RfqSwapRecordStore,
    type SwapContractRegistry,
} from "./swapManager";
export {
    type OfferSwapWatcher,
    watchOfferSwaps,
    type WatchOfferSwapsParams,
} from "./watch";
