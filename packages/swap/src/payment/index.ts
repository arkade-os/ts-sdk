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
