import { version } from "../package.json";

/**
 * This SDK plugin's own version string, sourced from package.json, and scoped
 * by plugin name.
 */
export const sdkVersion = `boltz-swap/${version}`;

export { ArkadeSwaps } from "./arkade-swaps";
export type { QuoteSwapOptions } from "./arkade-swaps";
export type { BoltzSwapStatus, SubmarineProgressionStatus } from "./boltz-swap-provider";
export {
    BoltzSwapProvider,
    isChainClaimableStatus,
    isChainFailedStatus,
    isChainFinalStatus,
    isChainPendingStatus,
    isChainRefundableStatus,
    isChainSignableStatus,
    isChainSuccessStatus,
    isChainSwapClaimable,
    isChainSwapRefundable,
    isPendingChainSwap,
    isPendingReverseSwap,
    isPendingSubmarineSwap,
    isReverseClaimableStatus,
    isReverseFailedStatus,
    isReverseFinalStatus,
    isReversePendingStatus,
    isReverseSuccessStatus,
    isReverseSwapClaimable,
    isSubmarineFailedStatus,
    isSubmarineFinalStatus,
    isSubmarinePendingStatus,
    isSubmarineSuccessStatus,
    isSubmarineRefundableStatus,
    isSubmarineSwapRefundable,
    hasSubmarineStatusReached,
} from "./boltz-swap-provider";
export {
    SwapError,
    SchemaError,
    SwapExpiredError,
    InvoiceExpiredError,
    InvoiceFailedToPayError,
    InsufficientFundsError,
    NetworkError,
    PreimageFetchError,
    SwapNotFoundError,
    TransactionFailedError,
    BoltzRefundError,
    QuoteRejectedError,
} from "./errors";
export type { QuoteRejectionReason } from "./errors";
export {
    decodeInvoice,
    getInvoicePaymentHash,
    getInvoiceSatoshis,
    isValidArkAddress,
} from "./utils/decoding";
export { verifySignatures } from "./utils/signatures";
export {
    saveSwap,
    updateReverseSwapStatus,
    updateSubmarineSwapStatus,
    updateChainSwapStatus,
    enrichReverseSwapPreimage,
    enrichSubmarineSwapInvoice,
} from "./utils/swap-helpers";
export type { SwapSaver } from "./utils/swap-helpers";
export { SwapManager } from "./swap-manager";
export { ArkadeSwapsMessageHandler } from "./serviceWorker/arkade-swaps-message-handler";
export { ServiceWorkerArkadeSwaps } from "./serviceWorker/arkade-swaps-runtime";
/** `@deprecated` Use ArkadeSwapsMessageHandler */
export { ArkadeSwapsMessageHandler as ArkadeLightningMessageHandler } from "./serviceWorker/arkade-swaps-message-handler";
/** `@deprecated` Use ServiceWorkerArkadeSwaps */
export { ServiceWorkerArkadeSwaps as ServiceWorkerArkadeLightning } from "./serviceWorker/arkade-swaps-runtime";
export { migrateToSwapRepository } from "./repositories/migrationFromContracts";
export type {
    CreateLightningInvoiceResponse,
    CreateLightningInvoiceRequest,
    SendLightningPaymentResponse,
    SendLightningPaymentRequest,
    OptimisticSendLightningPaymentResponse,
    IncomingPaymentSubscription,
    ArkadeSwapsConfig,
    ArkadeSwapsCreateConfig,
    BoltzSubmarineSwap,
    PendingSubmarineSwap, // deprecated
    BoltzReverseSwap,
    PendingReverseSwap, // deprecated
    ChainFeesResponse,
    BoltzChainSwap,
    PendingChainSwap, // deprecated
    ArkToBtcResponse,
    BtcToArkResponse,
    DecodedInvoice,
    LimitsResponse,
    FeesResponse,
    BoltzSwap,
    PendingSwap, // deprecated
    Network,
    Chain,
    Vtxo,
    SubmarineRecoveryStatus,
    SubmarineRecoveryInfo,
    SubmarineRecoveryResult,
    SubmarineRefundOutcome,
} from "./types";
export type {
    SwapManagerConfig,
    SwapManagerEvents,
    SwapManagerClient,
    SwapManagerCallbacks,
} from "./swap-manager";
export { logger, setLogger } from "./logger";
export type { Logger } from "./logger";
export { IndexedDbSwapRepository } from "./repositories/IndexedDb/swap-repository";
export { InMemorySwapRepository } from "./repositories/inMemory/swap-repository";
export type { SwapRepository } from "./repositories/swap-repository";
