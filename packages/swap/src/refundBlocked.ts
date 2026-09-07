/**
 * Why a wallet cannot produce a swap's spending key.
 *
 * A swap-lifecycle concern, not a key-provisioning one — which is why it
 * lives here and not in the SDK: `RfqSwapManager` reads it to decide a refund
 * is impossible rather than merely failing, and stops grinding against a push
 * that can never work for the whole refund window.
 */
import {
    ForeignDescriptorError,
    WalletCannotSignError,
    contractSigner,
    type Identity,
    type IWallet,
} from "@arkade-os/sdk";

export type RefundBlockedReason =
    /** The record carries no `signingDescriptor`. */
    | "no-secrets"
    /** The descriptor belongs to another wallet's key. */
    | "foreign-descriptor"
    /**
     * This wallet holds the key but cannot sign with it — a watch-only
     * identity, or a remote signer that is not attached. Unlike the other two
     * this can stop being true without changing wallets, so it is worth
     * telling apart: "attach your signer", not "restore the other wallet".
     */
    | "unsignable-wallet";

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
        if (cause instanceof WalletCannotSignError) {
            throw new RefundNotLocallyPossibleError(
                "unsignable-wallet",
                `this wallet holds ${record.signingDescriptor} but cannot sign with it; attach its signer`,
                { cause },
            );
        }
        if (cause instanceof ForeignDescriptorError) {
            throw new RefundNotLocallyPossibleError(
                "foreign-descriptor",
                `this wallet cannot derive ${record.signingDescriptor}; the swap was created on another wallet`,
                { cause },
            );
        }
        // Anything else is operational — a signer that did not answer, a
        // transport that dropped. Rethrowing keeps it retryable: every
        // `RefundNotLocallyPossibleError` is terminal to `RfqSwapManager`, so
        // labelling an outage as one would abandon a refundable swap for the
        // rest of its window.
        throw cause;
    }
}
