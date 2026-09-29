/**
 * The `refundArkade` callback, assembled. Its obvious implementation, `refundIfUnresolved`, is
 * wrong here: it brings its own status polling and MTP retry loop, which would nest inside the
 * manager's.
 *
 * An empty lockup returns `null`; {@link RefundNotLocallyPossibleError} and
 * {@link LockupNeedsRecoveryError} propagate untouched, since catching either would turn a state
 * the trader must act on into a retry that grinds the window away.
 */
import type { IWallet } from "@arkade-os/sdk";
import {
    type LockupContractSource,
    findLockupVtxos,
    pushRefundWithoutReceiver,
    type SwapOperator,
} from "./refund";
import { RefundNotLocallyPossibleError, senderIdentityForSwapRecord } from "./refundBlocked";
import { rfqSignerOf } from "./rfqProfileParts";
import type { AssetSwapRepository } from "./repository";
import type { ArkadeRefundResult, RfqSwap } from "./swapManager";

export interface ArkadeRefunderDeps {
    operator: SwapOperator;
    /**
     * The wallet's contract manager (prefer `await wallet.getContractManager()`). The lockup must
     * be registered in it before the funding is visible.
     */
    contracts: LockupContractSource;
    /** Asked for the descriptor's signer; never asked to mint a key. */
    wallet: IWallet;
    /**
     * The record store: the live `RfqSwap` carries no `signingDescriptor` (it lives in the
     * record's `profile.signer`), so the refund key is resolved through `getRfqSwap`.
     */
    repository: Pick<AssetSwapRepository, "getRfqSwap">;
}

/**
 * Build the `refundArkade` callback for `RfqSwapManager.setCallbacks`.
 *
 * @example
 * manager.setCallbacks({
 *     refundArkade: arkadeRefunder({ operator, contracts, wallet, repository }),
 *     saveSwap,
 * });
 */
export function arkadeRefunder(
    deps: ArkadeRefunderDeps,
): (swap: RfqSwap) => Promise<ArkadeRefundResult> {
    return async (swap) => {
        const contract = swap.lockup?.script;
        if (!contract) {
            // A wiring mistake, deliberately untyped: the manager retries it and ends the swap
            // `failed` at the deadline — loud — rather than the quiet permanent refusal a typed
            // error would produce.
            throw new Error(
                `swap ${swap.rfqId} carries no lockup covenant, so its refund cannot be built`,
            );
        }

        // Before the store read: an empty lockup needs no signer, and `null` is "nothing to do".
        const vtxos = await findLockupVtxos(deps.contracts, swap.lockupPkScript);
        if (vtxos.length === 0) return null;

        const record = await deps.repository.getRfqSwap(swap.rfqId);
        if (!record) {
            // Permanent: the record is written at request time, so a missing one will not appear.
            throw new RefundNotLocallyPossibleError(
                "no-secrets",
                `no stored record for ${swap.rfqId}; the descriptor that signs its refund lives there`,
            );
        }

        // `?? {}` is a refusal, not a default: no descriptor becomes the same typed "no-secrets",
        // keeping `senderIdentityForSwapRecord` the one place that decides it.
        const sender = await senderIdentityForSwapRecord(deps.wallet, rfqSignerOf(record) ?? {});
        return pushRefundWithoutReceiver(deps.operator, { contract, sender, vtxos });
    };
}
