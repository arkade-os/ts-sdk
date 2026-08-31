import type { Outpoint } from ".";
import type { IContractManager } from "../contracts/contractManager";

/**
 * Called when a VTXO's exit becomes observable onchain.
 *
 * The seam exists because nothing else can learn the fact: delta sync filters on *creation* time
 * (`GetVtxosOptions.after` / `before`), so a status change on an older VTXO is invisible to it, and
 * neither exit path can reach a contract manager on its own — `Unroll.Session` takes no contract
 * layer by design, and the `UnilateralExit` executor is deliberately keyless and provider-only.
 *
 * A plain function type, with no runtime import anywhere in this module, is what lets both keep
 * that independence: an exit path calls the hook, it does not import the contract layer.
 *
 * **Best-effort by contract.** An exit is a disaster-recovery path and must never fail because a
 * cache write did, so every call site goes through {@link notifyExitObserved}.
 */
export type OnExitObserved = (outpoint: Outpoint) => void | Promise<void>;

/**
 * Adapt a contract manager into an {@link OnExitObserved}: the wallet-side half of the seam, kept
 * out of `exit/` so the dependency direction stays outward.
 */
export function exitObserverFor(
    manager: Pick<IContractManager, "refreshOutpoints">,
): OnExitObserved {
    return (outpoint) => manager.refreshOutpoints([outpoint]);
}

/** Fire an observation without letting it into the exit's failure path. */
export async function notifyExitObserved(
    onExitObserved: OnExitObserved | undefined,
    outpoint: Outpoint,
): Promise<void> {
    if (!onExitObserved) return;
    try {
        await onExitObserved(outpoint);
    } catch (e) {
        console.error(
            `exit observer failed for ${outpoint.txid}:${outpoint.vout} — the exit is unaffected`,
            e,
        );
    }
}
