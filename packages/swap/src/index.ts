export {
    createOffer,
    cancelOffer,
    encodeOffer,
    decodeOffer,
    offerVtxoScript,
    swapPrograms,
    OFFER_PACKET_TYPE,
    type Offer,
} from "./offer";
export {
    discoverMarkets,
    findMarket,
    validatePlan,
    makeCachedFeedFetch,
    QUOTE_OPTIONS,
    type DiscoverMarketsOptions,
    type PlanError,
} from "./markets";
export {
    BTC_ASSET_ID,
    getAssetSwaps,
    getAssetSwapsOrThrow,
    addAssetSwap,
    updateAssetSwap,
    updateAssetSwapBestEffort,
    swapSecretsToRecord,
    preimageForSwapRecord,
    PreimageNotRecoverableError,
    type AssetSwap,
    type AssetSwapStatus,
    type PreimageBlockedReason,
    type SwapSecretsProjection,
} from "./store";
export {
    type AssetSwapRepository,
    type MarketsCacheEntry,
    InMemoryAssetSwapRepository,
} from "./repository";
export { IndexedDbAssetSwapRepository } from "./indexedDbRepository";
// The corridor handlers and their registry are internal — see `rfqCorridor.ts`
// for why. What a consumer writes into `RfqSwapOrigin.profile` is these: every
// corridor's keys through `rfqSecretsProfile`, then whatever its own leg adds.
// The two readers are how they come back — `rfqSignerOf` for the refund signer
// on any leg, `rfqClaimSecretOf` for the preimage on a leg we claim.
export {
    onchainSendProfile,
    type LightningReceiveProfile,
    type LightningSendProfile,
    type OnchainSendProfile,
} from "./rfqCorridors";
export {
    rfqSecretsProfile,
    rfqClaimSecretOf,
    rfqSignerOf,
    type RfqClaimSecretProjection,
    type RfqHashlockProjection,
    type RfqSignerProjection,
} from "./rfqProfileParts";
export {
    RFQ_SWAP_RETENTION_SECONDS,
    createRfqSwapRecord,
    rebuildRfqSwap,
    shouldRetainRfqSwap,
    updateRfqSwapRecord,
    type LockupParams,
    type PersistableRfqSwap,
    type RfqSwapOrigin,
    type RfqSwapRecord,
} from "./rfqRecord";
export {
    restoreAssetSwaps,
    classifySpend,
    classifyDepositSpend,
    spendTxidsOf,
    type RestoreIndexer,
    type SpendKind,
    type Tx,
} from "./restore";
export {
    watchOfferSwaps,
    spendUpdate,
    type OfferSwapWatcher,
    type WatchOfferSwapsParams,
} from "./watch";
export { retireSettledOfferContracts, type OfferContractRetirer } from "./coverage";
export {
    // deprecated — use arkadeAssetLeg; the @deprecated that editors read is on
    // the declaration in rfq.ts, reached through this alias
    ARKADE_ASSET,
    ARKADE_BTC,
    LIGHTNING_BTC,
    LIGHTNING_RECEIVE_PAIR,
    LIGHTNING_SEND_PAIR,
    MIN_CLAIM_WINDOW_SECONDS,
    MIN_HEADROOM_SECONDS,
    RFQ_TERMINAL_STATES,
    SOLO_REFUND_HEADROOM_SECONDS,
    AddressMismatch,
    SwapRefusal,
    arkadeAssetLeg,
    arkadeSwapRequest,
    assertFundable,
    assertReceivable,
    deriveLightningReceive,
    deriveOnchainReceive,
    httpTransport,
    lightningReceiveRequest,
    lightningSendRequest,
    lightningSendVtxoScript,
    newRfqId,
    offerTermsFromQuote,
    receiveVtxoScript,
    relayTransport,
    requestLightningReceive,
    requestLightningSend,
    rfqPair,
    unilateralClaimDelay,
    unilateralRefundDelay,
    unilateralRefundWithoutReceiverDelay,
    verifyLockupAddress,
    verifyReceiveInvoice,
    type InvoiceFacts,
    type LightningReceiveTreeParams,
    type LightningSendTreeParams,
    type RelaySocket,
    type RfqQuote,
    type RfqRefusalReason,
    type RfqStatus,
    type RfqTransport,
} from "./rfq";
export {
    ONCHAIN_DUST_SATS,
    ONCHAIN_SECONDS_PER_BLOCK,
    awaitOnchainFill,
    buildHtlcClaim,
    buildHtlcRefund,
    claimOnchainFill,
    classifyOnchainHtlc,
    extractPreimage,
    newPreimage,
    onchainHtlcScript,
    paymentHashOf,
    type ChainSource,
    type ChainUtxo,
    type HtlcUtxo,
    type OnchainHtlc,
    type OnchainHtlcParams,
    type OnchainHtlcPhase,
    type OnchainNetwork,
} from "./onchainHtlc";
export {
    ONCHAIN_BTC,
    ONCHAIN_RECEIVE_PAIR,
    ONCHAIN_SEND_PAIR,
    MAX_MIN_CONFIRMATIONS,
    ONCHAIN_CLAIM_MARGIN_SECONDS,
    ONCHAIN_ORDER_MARGIN_SECONDS,
    deriveOnchainSend,
    onchainReceiveRequest,
    onchainSendRequest,
    requestOnchainReceive,
    requestOnchainSend,
} from "./rfq";
export { sealClaimPacket, type ClaimPacketInput, type SealedClaimPacket } from "./claimPacket";
export {
    LockupAmountMismatchError,
    awaitLockupFunding,
    claimReceiveLockup,
    pushClaim,
    type ClaimArkProvider,
} from "./claim";
export {
    RefundNotLocallyPossibleError,
    senderIdentityForSwapRecord,
    type RefundBlockedReason,
} from "./refundBlocked";
export {
    LockupNeedsRecoveryError,
    REFUND_MTP_LAG_SECONDS,
    RFQ_RESOLVED_STATES,
    awaitRfqResolution,
    findLockupVtxos,
    isRfqTerminal,
    pushRefundWithoutReceiver,
    readLockupFate,
    refundIfUnresolved,
    type LockupFate,
    type LockupSpend,
    type LockupSpendIndexer,
    type LockupVtxo,
    type RefundArkProvider,
    type RefundIndexer,
    type RefundOutcome,
} from "./refund";
export {
    LockupContractMissing,
    LockupRegistrationFailed,
    SWAP_LOCKUP_CONTRACT_KIND,
    SWAP_LOCKUP_CONTRACT_LABEL,
    SWAP_LOCKUP_CONTRACT_TYPE,
    lockupContractParams,
    registerLockupContract,
    type LockupContractReader,
    type LockupContractWriter,
} from "./lockupContract";
export {
    RFQ_SWAP_TERMINAL_STATES,
    RfqSwapManager,
    isRfqSwapTerminal,
    nextOnchainAction,
    type ArkadeRefundResult,
    type LightningReceiveSwap,
    type LightningSendSwap,
    type OnchainSendAction,
    type OnchainSendSwap,
    type RfqSwap,
    type RfqSwapActionName,
    type RfqSwapLockup,
    type RfqSwapManagerCallbacks,
    type RfqSwapManagerConfig,
    type RfqSwapManagerDeps,
    type RfqSwapManagerEvents,
    type RfqSwapOutcome,
    type RfqSwapState,
    type SwapContractRegistry,
} from "./swapManager";
export { swapActivityResolver, type SwapActivityInput } from "./activity";
