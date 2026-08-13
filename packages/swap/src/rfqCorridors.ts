/**
 * The corridors this package persists, one handler each.
 *
 * Adding a corridor is a handler here plus a `register()` call at the bottom —
 * no edit to `RfqSwapRecord`, the repository, or the IndexedDB store, none of
 * which name a corridor. See `rfqCorridor.ts` for why it is shaped this way.
 */
import { hex } from "@scure/base";
import {
    rfqCorridorHandlers,
    type RfqCorridorContext,
    type RfqCorridorHandler,
} from "./rfqCorridor";
import { onchainHtlcScript, type OnchainNetwork } from "./onchainHtlc";
import type { LightningReceiveSwap, OnchainSendSwap, RfqSwap } from "./swapManager";

/** `arkade:BTC->lightning:BTC`. Nothing beyond the covenant and the common
 * fields: the solver claims the lockup, the trader's only move is the refund,
 * and both are fully described by the contract row. */
export const LightningSendCorridor: RfqCorridorHandler<Record<string, never>> = {
    kind: "lightning_send",
    project: () => ({}),
    hydrate: () => ({}),
};

/** `lightning:BTC->arkade:BTC`. */
export interface LightningReceiveProfile extends Record<string, unknown> {
    /** The quote's `to_amount`, captured at REQUEST time. */
    expectedAmount: number;
    /** Where the claim pays. */
    payoutAddress: string;
    /**
     * Our Arkade claim's txid, once submitted.
     *
     * Here rather than on the record's common half, which is for fields all
     * three legs carry: this one is the receive leg's alone, the counterpart of
     * the onchain leg's `claimTxid`. Restoring without it re-arms the value gate
     * against a lockup we have already partly claimed — `claimIfFunded` reads
     * `partiallyClaimed` off exactly this — so the remainder is refused over a
     * preimage that is already public, and a swap that did claim is relabelled
     * `needs_counterparty` once its window shuts.
     */
    claimArkTxid?: string;
}

export const LightningReceiveCorridor: RfqCorridorHandler<LightningReceiveProfile> = {
    kind: "lightning_receive",

    // What the manager holds: the amount gate, and its own claim once it lands.
    // `payoutAddress` comes from the request result and never changes, so the
    // caller writes it once and this leaves it alone.
    project: (swap: RfqSwap) => {
        const receive = swap as LightningReceiveSwap;
        return {
            expectedAmount: receive.expectedAmount,
            ...(receive.claimArkTxid ? { claimArkTxid: receive.claimArkTxid } : {}),
        };
    },

    hydrate(profile) {
        // Required, never defaulted: the manager reports `needs_counterparty`
        // rather than claiming when this is not a finite number, and a
        // comparison against `undefined` would delete the value gate instead of
        // failing it. Read at claim time it would be whatever the solver
        // funded, which is the dust-funding attack rather than a check on it.
        if (
            typeof profile.expectedAmount !== "number" ||
            !Number.isFinite(profile.expectedAmount)
        ) {
            throw new Error("lightning_receive record carries no expectedAmount; it cannot claim");
        }
        return {
            expectedAmount: profile.expectedAmount,
            ...(profile.claimArkTxid ? { claimArkTxid: profile.claimArkTxid } : {}),
        };
    },
};

/** `arkade:BTC->onchain:BTC`. */
export interface OnchainSendProfile extends Record<string, unknown> {
    /** The trader's L1 claim key. */
    claimKey: string;
    /** The solver's L1 key, from `profile.htlc_pubkey`. */
    refundKey: string;
    /** `profile.htlc_locktime` — the trader's L1 recourse deadline, distinct
     * from the arkade lockup's `refundLocktime`. */
    htlcLocktime: number;
    network: OnchainNetwork;
    /** `profile.min_confirmations`; gates when the fill is claimable. */
    minConfirmations: number;
    /** The fill's outpoint, learned on first sighting. Without it a SPENT htlc
     * reads as never funded — see `classifyOnchainHtlc`. */
    funding?: { txid: string; vout: number };
    /** Our own L1 claim, so a restart does not re-broadcast it. */
    claimTxid?: string;
}

/**
 * The one corridor that stores script parameters, because nothing else holds
 * them: its arkade lockup has a contract row, but the HTLC is Bitcoin L1 — not
 * an arkade contract — and `OnchainHtlc` exposes only derived values, never the
 * keys it was built from.
 */
export const OnchainSendCorridor: RfqCorridorHandler<OnchainSendProfile> = {
    kind: "onchain_send",

    // The L1 keys and the network are only in the request result — nothing on
    // `OnchainSendSwap` carries them — so the caller writes them once. What the
    // manager learns as it drives the swap is the fill and our own claim.
    project: (swap: RfqSwap) => {
        const send = swap as OnchainSendSwap;
        return {
            ...(send.funding ? { funding: send.funding } : {}),
            ...(send.claimTxid ? { claimTxid: send.claimTxid } : {}),
        };
    },

    hydrate(profile, { paymentHash }: RfqCorridorContext) {
        if (!profile.claimKey || !profile.refundKey) {
            throw new Error(
                "onchain_send record carries no L1 keys; its HTLC cannot be rebuilt and its " +
                    "refund window would pass unwatched",
            );
        }
        // Required, never defaulted, for the same reason the receive leg's
        // `expectedAmount` is: `classifyOnchainHtlc` gates on
        // `confirmations < minConfirmations`, and that comparison against
        // `undefined` is false — so a missing value does not fail the
        // confirmation gate, it DELETES it, and the swap claims an unconfirmed
        // fill with the preimage. The other L1 inputs are checked by
        // `onchainHtlcScript`, which refuses a bad locktime, key or network.
        if (!Number.isInteger(profile.minConfirmations) || profile.minConfirmations < 1) {
            throw new Error(
                `onchain_send record carries no usable minConfirmations ` +
                    `(${String(profile.minConfirmations)}); the confirmation gate cannot be ` +
                    `checked — refusing to restore a swap that would claim an unconfirmed fill`,
            );
        }
        return {
            htlc: onchainHtlcScript(
                {
                    // From the record, not the covenant: the lockup commits to
                    // `hash160(P)`, and the HTLC needs `sha256(P)`. One P
                    // unlocks both legs, but only one of the two hashes of it
                    // is recoverable here.
                    paymentHash,
                    claimKey: hex.decode(profile.claimKey),
                    refundKey: hex.decode(profile.refundKey),
                    refundLocktime: profile.htlcLocktime,
                },
                profile.network,
            ),
            minConfirmations: profile.minConfirmations,
            ...(profile.funding ? { funding: profile.funding } : {}),
            ...(profile.claimTxid ? { claimTxid: profile.claimTxid } : {}),
        };
    },
};

rfqCorridorHandlers.register(LightningSendCorridor as RfqCorridorHandler);
rfqCorridorHandlers.register(LightningReceiveCorridor as RfqCorridorHandler);
rfqCorridorHandlers.register(OnchainSendCorridor as RfqCorridorHandler);
