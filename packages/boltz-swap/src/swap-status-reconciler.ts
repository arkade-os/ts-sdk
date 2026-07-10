/**
 * Pure swap-status reconciliation: derives a domain `SwapState` from Boltz's
 * reported status, an on-chain VTXO signal (from `ContractManager` watching
 * the swap's registered `vhtlc` contract — see `swap-contract.ts`), and a
 * local action-log of claims/refunds WE completed (see
 * `SwapManager.getActionLog`).
 *
 * Disambiguation is ACTION-LOG-PRIMARY: Boltz's own status feed is trusted
 * directly only for the small set of genuinely terminal statuses (a
 * failsafe). Everything else — including a VTXO we've observed spent while
 * Boltz hasn't (yet) reported a terminal status — is derived from (a) our
 * own action log ("did WE complete the claim/refund?") and, failing that,
 * (b) the VHTLC role structure of the swap type: only two parties can ever
 * spend a VHTLC — its receiver (claim path, needs the preimage) or its
 * sender (refund path, after timeout) — so if it wasn't us, it must have
 * been the other one.
 */
import {
    isChainFinalStatus,
    isReverseFinalStatus,
    isSubmarineFailedStatus,
    isSubmarineFinalStatus,
} from "./boltz-swap-provider";
import { BoltzSwap } from "./types";

/** Domain swap lifecycle state, derived from Boltz status + VTXO signal + action log. */
export type SwapState = "Pending" | "Settled" | "Refunded" | "Failed" | "Unknown";

/**
 * Local record of swap IDs whose claim/refund WE (this wallet) completed.
 * Populated by {@link SwapManager.getActionLog} — see swap-manager.ts.
 */
export interface SwapActionLog {
    /** Swap IDs we successfully claimed. */
    claimed: ReadonlySet<string>;
    /** Swap IDs we successfully refunded. */
    refunded: ReadonlySet<string>;
}

/**
 * On-chain state of the swap's tracked VHTLC, from ContractManager/VTXO
 * events:
 * - `"none"` — never observed funded.
 * - `"funded"` — lockup VTXO present and unspent.
 * - `"spent"` — the lockup VTXO has been spent, by either party.
 */
export type VtxoSignal = "none" | "funded" | "spent";

/**
 * Derives a swap's domain lifecycle state from its Boltz status, the current
 * VTXO signal for its tracked VHTLC, and the local action log.
 *
 * Precedence:
 * 1. A genuinely terminal Boltz status is a failsafe truth, returned
 *    regardless of signal or action log (reuses the `is*FinalStatus`
 *    predicates from `boltz-swap-provider.ts`).
 * 2. Otherwise, if the VHTLC is `"spent"`: the action log first (did we
 *    complete the claim/refund?), then the VHTLC role for this swap
 *    type/direction (see {@link deriveSpentByOthersState}).
 * 3. Otherwise (`"funded"` or `"none"`, no terminal status yet): `"Pending"`.
 *
 * Pure function — no I/O, no mutation.
 */
export function deriveSwapState(
    swap: BoltzSwap,
    signal: VtxoSignal,
    log: SwapActionLog,
): SwapState {
    const terminal = deriveTerminalState(swap);
    if (terminal) return terminal;

    if (signal === "spent") {
        if (log.claimed.has(swap.id)) return "Settled";
        if (log.refunded.has(swap.id)) return "Refunded";
        return deriveSpentByOthersState(swap);
    }

    // "funded" or "none", with no Boltz-terminal status yet: still in flight.
    return "Pending";
}

/**
 * Boltz-terminal arm: trusted directly regardless of VTXO signal (failsafe).
 * Returns `undefined` when the swap's current status is not (yet) terminal.
 *
 * Note: `isReverseFailedStatus` is intentionally NOT used here — unlike
 * `isSubmarineFailedStatus`/`isChainFailedStatus`, it classifies
 * `"transaction.refunded"` as a failure, which would collide with the
 * separate `"Refunded"` state below. Reverse's terminal 3-way split is
 * therefore spelled out explicitly instead.
 */
function deriveTerminalState(swap: BoltzSwap): SwapState | undefined {
    switch (swap.type) {
        case "reverse":
            if (!isReverseFinalStatus(swap.status)) return undefined;
            if (swap.status === "invoice.settled") return "Settled";
            if (swap.status === "transaction.refunded") return "Refunded";
            return "Failed"; // invoice.expired | transaction.failed | swap.expired

        case "submarine":
            if (!isSubmarineFinalStatus(swap.status)) return undefined;
            // Safe to use directly here: isSubmarineFinalStatus already
            // excludes "transaction.lockupFailed" (negotiable, not
            // terminal), so within the final set isSubmarineFailedStatus
            // correctly separates invoice.failedToPay/swap.expired (Failed)
            // from transaction.claimed (Settled).
            return isSubmarineFailedStatus(swap.status) ? "Failed" : "Settled";

        case "chain":
            if (!isChainFinalStatus(swap.status)) return undefined;
            if (swap.status === "transaction.claimed") return "Settled";
            if (swap.status === "transaction.refunded") return "Refunded";
            return "Failed"; // transaction.failed | swap.expired
    }
}

/**
 * Operational arm: the VHTLC was observed spent, but not via an action we
 * recorded ourselves. Only two parties can ever spend a VHTLC — its receiver
 * (claim path) or its sender (refund path) — so the outcome follows from
 * which role WE hold for this swap type/direction (role table mirrored from
 * `extractSwapVhtlcInputs` in `swap-contract.ts`):
 *
 * - reverse: wallet is the VHTLC receiver (only the wallet can claim).
 *   Spent-without-us means Boltz (sender) refunded its own lockup — we never
 *   got paid — `"Failed"`.
 * - submarine: wallet is the VHTLC sender (only the wallet can refund).
 *   Spent-without-us means Boltz (receiver) claimed our lockup after paying
 *   the invoice — `"Settled"`.
 * - chain ARK→BTC (`request.from === "ARK"`): same role shape as submarine
 *   (wallet is sender, Boltz is receiver on the ARK-side lockup) —
 *   `"Settled"`.
 * - chain BTC→ARK (`request.to === "ARK"`): same role shape as reverse
 *   (wallet is receiver, Boltz is sender on the ARK-side lockup) —
 *   `"Failed"`.
 */
function deriveSpentByOthersState(swap: BoltzSwap): SwapState {
    switch (swap.type) {
        case "reverse":
            return "Failed";
        case "submarine":
            return "Settled";
        case "chain":
            if (swap.request.from === "ARK") return "Settled";
            if (swap.request.to === "ARK") return "Failed";
            return "Pending"; // genuinely ambiguous / malformed direction
    }
}
