/**
 * Payment rails backed by an Arkade Intents solver.
 *
 * These live here rather than in `@arkade-os/sdk/payment/rails` because the
 * dependency runs one way: this package depends on the SDK, never the reverse.
 * `PaymentRail` is a structural interface, so a rail defined here is a rail —
 * the app registers it on the router with `use()`.
 */
export { solverRendezvous, type SolverRendezvous } from "./rendezvous";
export {
    SOLVER_ONCHAIN_RAIL,
    solverOnchainRail,
    solverOnchainRendezvous,
    type SolverOnchainRailDeps,
    type SolverOnchainRendezvous,
    type SolverOnchainSend,
} from "./solverOnchain";
export {
    SOLVER_LIGHTNING_RAIL,
    solverLightningRail,
    solverLightningRendezvous,
    type SolverLightningRailDeps,
    type SolverLightningSend,
} from "./solverLightning";
