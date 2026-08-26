/**
 * The `refundArkade` callback, assembled.
 *
 * The wiring this replaces was prose in two places — `swapManager.ts`'s
 * callback doc and the README — because it is the one callback whose obvious
 * implementation is wrong: `refundIfUnresolved` is the single-swap version of
 * `RfqSwapManager` itself and brings its own status polling and MTP retry loop,
 * which would nest inside the manager's. Composing the atomic push here makes
 * that mistake something a consumer has to go out of their way to make.
 *
 * The three semantic rules the manager relies on are structural rather than
 * documented: an empty lockup returns `null`, and both
 * {@link RefundNotLocallyPossibleError} and {@link LockupNeedsRecoveryError}
 * propagate untouched — the manager reads the first as permanent and surfaces
 * the second as `needs_recovery`, and catching either here would turn a state
 * the trader must act on into a retry that grinds the window away.
 */
import type { IWallet } from "@arkade-os/sdk";
import {
    findLockupVtxos,
    pushRefundWithoutReceiver,
    type RefundOperatorProvider,
    type RefundIndexer,
} from "./refund";
import { RefundNotLocallyPossibleError, senderIdentityForSwapRecord } from "./refundBlocked";
import { rfqSignerOf } from "./rfqProfileParts";
import type { AssetSwapRepository } from "./repository";
import type { ArkadeRefundResult, RfqSwap } from "./swapManager";

export interface ArkadeRefunderDeps {
    operator: RefundOperatorProvider;
    indexer: RefundIndexer;
    /** Asked for the descriptor's signer; never asked to mint a key. */
    wallet: IWallet;
    /**
     * The record store. The live `RfqSwap` the manager passes carries no
     * `signingDescriptor` — that lives in the record's `profile.signer` — so
     * the refund key is resolved by key, which is what `getRfqSwap` is for.
     */
    repository: Pick<AssetSwapRepository, "getRfqSwap">;
}

/**
 * Build the `refundArkade` callback for `RfqSwapManager.setCallbacks`.
 *
 * @example
 * manager.setCallbacks({
 *     refundArkade: arkadeRefunder({ operator, indexer, wallet, repository }),
 *     saveSwap,
 * });
 */
export function arkadeRefunder(
    deps: ArkadeRefunderDeps,
): (swap: RfqSwap) => Promise<ArkadeRefundResult> {
    return async (swap) => {
        const script = swap.lockup?.script;
        if (!script) {
            // A wiring mistake, not a swap outcome: `lockup` is optional only
            // because the manager can still watch without it, and no refund can
            // be built from the pkScript alone. Keep `request*`'s `script` on
            // the swap. Untyped on purpose: the manager retries this once a
            // poll and ends the swap `failed` at the deadline (see
            // `RfqSwapManagerCallbacks.refundArkade`), which is the loud
            // outcome a wiring mistake deserves — not the quiet permanent
            // refusal a typed error would produce.
            throw new Error(
                `swap ${swap.rfqId} carries no lockup covenant, so its refund cannot be built`,
            );
        }

        // Before the store read: a lockup holding nothing needs no signer, and
        // `null` is the manager's "nothing to do" rather than a failure.
        const vtxos = await findLockupVtxos(deps.indexer, swap.lockupPkScript);
        if (vtxos.length === 0) return null;

        const record = await deps.repository.getRfqSwap(swap.rfqId);
        if (!record) {
            // Permanent, and typed as such: the record is written at request
            // time, so one the store has never seen is not one that will
            // appear. Retrying would grind until the window shut.
            throw new RefundNotLocallyPossibleError(
                "no-secrets",
                `no stored record for ${swap.rfqId}; the descriptor that signs its refund lives there`,
            );
        }

        // The `?? {}` is a refusal, not a default: a record with no
        // `profile.signer` reaches `senderIdentityForSwapRecord` without a
        // `signingDescriptor`, which is what turns it into the same typed
        // `RefundNotLocallyPossibleError("no-secrets")` thrown above. Written
        // this way rather than as a second explicit throw so that the one place
        // deciding what "this wallet cannot sign this swap" means stays
        // `senderIdentityForSwapRecord`.
        const sender = await senderIdentityForSwapRecord(deps.wallet, rfqSignerOf(record) ?? {});
        return pushRefundWithoutReceiver(deps.operator, { script, sender, vtxos });
    };
}
