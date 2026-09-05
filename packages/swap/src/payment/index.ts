/** Payment rails backed by an Arkade Intents solver. They live here because
 *  the SDK does not depend on this package; `PaymentRail` is structural, so
 *  the app registers them with `use()`. */
export { solverRendezvous, type SolverRendezvous } from "./rendezvous";
export {
    SOLVER_ONCHAIN_RAIL,
    solverOnchainRail,
    solverOnchainRendezvous,
    type SolverOnchainRailDeps,
    type SolverOnchainSend,
} from "./solverOnchain";
export {
    SOLVER_LIGHTNING_RAIL,
    solverLightningRail,
    solverLightningRendezvous,
    type SolverLightningRailDeps,
    type SolverLightningSend,
} from "./solverLightning";

/** The v2 swap rails: `SwapClient`-backed, one dep each, and the router that
 *  registers them beside core's own. The `solver-*` rails above are the v1 RFQ
 *  path and predate them. */
export {
    LIGHTNING_RAIL,
    lightningRail,
} from "./lightning";
export {
    ONCHAIN_SWAP_RAIL,
    claimFeeSats,
    onchainSwapRail,
    type OnchainSwapRailDeps,
} from "./onchainSwap";
export {
    SWAP_ROUTER_PRIORITY,
    createSwapPaymentRouter,
    type SwapPaymentRouterConfig,
} from "./router";
export {
    PAYMENT_STATUS,
    isTerminalStatus,
    paymentStatusOf,
} from "./status";
export {
    SwapPaymentFailedError,
    railAvailable,
    receiverExact,
    swapHandle,
    type SwapRailClient,
} from "./swapRail";
