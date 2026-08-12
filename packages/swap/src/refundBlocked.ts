/**
 * Why a wallet cannot produce a swap's spending key.
 *
 * A swap-lifecycle concern, not a key-provisioning one — which is why it
 * lives here and not in the SDK: `RfqSwapManager` reads it to decide a refund
 * is impossible rather than merely failing, and stops grinding against a push
 * that can never work for the whole refund window.
 */
import { contractSigner, type Identity, type IWallet } from "@arkade-os/sdk";

export type RefundBlockedReason =
    /** The record carries no `signingDescriptor`. */
    | "no-secrets"
    /** The descriptor belongs to another wallet's key. */
    | "foreign-descriptor";

/**
 * The wallet cannot produce this swap's spending key, so no local refund is
 * possible: not a failure to retry, a capability this wallet does not have.
 */
export class RefundNotLocallyPossibleError extends Error {
    override readonly name = "RefundNotLocallyPossibleError";
    constructor(
        readonly reason: RefundBlockedReason,
        message: string,
        options?: { cause?: unknown },
    ) {
        super(message, options);
    }
}

/**
 * The signer for a swap record's `signingDescriptor`, or a typed refusal.
 *
 * **Wire `refundArkade` here, not to `contractSigner` directly.** The SDK
 * answers about a descriptor; only this knows that a record without one is a
 * permanent refusal rather than a `TypeError` at the push site — which the
 * manager would treat as retryable.
 */
export async function senderIdentityForSwapRecord(
    wallet: IWallet,
    record: { signingDescriptor?: string },
): Promise<Identity> {
    if (!record.signingDescriptor) {
        throw new RefundNotLocallyPossibleError(
            "no-secrets",
            "this swap record carries no signing descriptor",
        );
    }
    try {
        return await contractSigner(wallet, record.signingDescriptor);
    } catch (cause) {
        throw new RefundNotLocallyPossibleError(
            "foreign-descriptor",
            `this wallet cannot derive ${record.signingDescriptor}; the swap was created on another wallet`,
            { cause },
        );
    }
}
