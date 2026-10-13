/**
 * `@arkade-os/swap/advanced` — the orchestration below the verbs: the manual drive, corridor
 * modules and destination registry, quote preparation and verification, RFQ wire builders,
 * market picks, record projections, and the self-hosted covclaimd claim flow.
 *
 * A superset of the root's vocabulary (same declarations, so one flow needs one import
 * specifier). Unlike the root, these names are not a compatibility promise and may move across
 * minor versions; the stable v1 floor is `@arkade-os/swap/protocol`.
 */
export * from "./client";
// `client.cancel()` wraps this; an app that composed its own drive needs the same act.
export { cancelSwap, type CancelInput, type CancelOutcome } from "./client/cancel";
// Seal to your own covclaimd and register there directly instead of the solver's courier.
export {
    CovclaimdRevealError,
    covclaimdClient,
    revealClaimPacket,
    revealFieldsFromScript,
    type CovclaimdClient,
    type CovclaimdInfo,
    type RevealParams,
} from "./reveal";
// The EVM corridors' RFQ wire: negotiation only, nothing here funds or claims.
export {
    EVM_CHAIN,
    evmAmountFromWire,
    evmAmountToWire,
    evmDirectionOf,
    evmQuoteSats,
    evmQuoteTokenAmount,
    evmReceivePair,
    evmReceiveRequest,
    evmSendPair,
    evmSendRequest,
    evmTokenLeg,
    evmTokenOf,
    readEvmReceiveQuote,
    readEvmSendQuote,
    type EvmReceiveQuote,
    type EvmReceiveQuoteProfile,
    type EvmRfqQuote,
    type EvmSendQuote,
    type EvmSendQuoteProfile,
} from "./evmRfq";
