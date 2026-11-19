/**
 * Why a wallet cannot produce a swap's spending key. `RfqSwapManager` reads this to treat a
 * refund as impossible rather than retryable, and stops pushing for the rest of the window.
 */
import {
    ForeignDescriptorError,
    WalletCannotSignError,
    contractSigner,
    type Identity,
    type IWallet,
} from "@arkade-os/sdk";

/** @deprecated Recovery is internal to the drive; use `client.recover()`. Moved off the package root to `@arkade-os/swap/protocol`. */
export type RefundBlockedReason =
    /** The record carries no `signingDescriptor`. */
    | "no-secrets"
    /** The descriptor belongs to another wallet's key. */
    | "foreign-descriptor"
    /**
     * This wallet holds the key but cannot sign with it (watch-only, or remote signer not
     * attached). Unlike the others it can clear without changing wallets: "attach your signer".
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
 * **Wire `refundArkade` here, not to `contractSigner` directly**: a record without a descriptor
 * must be a permanent refusal, not a `TypeError` the manager would retry.
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
        // Operational failures stay retryable: labelling an outage terminal would abandon a
        // refundable swap for the rest of its window.
        throw cause;
    }
}
