/**
 * The corridors this package persists, one handler each.
 *
 * Adding a corridor is a handler here plus a `register()` call at the bottom; nothing else names a
 * corridor. See `rfqCorridor.ts` for the shape.
 */
import { hex } from "@scure/base";
import { rfqCorridorHandlers, type RfqCorridorHandler } from "./rfqCorridor";
import {
    hydrateHashlock,
    type RfqHashlockProjection,
    type RfqSignerProjection,
} from "./rfqProfileParts";
import {
    onchainHtlcScript,
    type OnchainHtlc,
    type OnchainHtlcParams,
    type OnchainNetwork,
} from "./onchainHtlc";
import type { LightningReceiveSwap, OnchainSendSwap, RfqSwap } from "./swapManager";

/**
 * `arkade:BTC->lightning:BTC`. The solver claims the lockup; the trader's only move is the refund.
 *
 * P belongs to the payee, so `hashlock` is `{ paymentHash }` alone and `signer` holds a REFUND key.
 */
export interface LightningSendProfile extends Record<string, unknown> {
    signer: RfqSignerProjection;
    hashlock: RfqHashlockProjection;
}

export const LightningSendCorridor: RfqCorridorHandler<LightningSendProfile> = {
    kind: "lightning_send",
    project: () => ({}),
    hydrate: (profile) => hydrateHashlock(profile),
    // No `claimSecret`: no preimage was minted, and one derived off the refund descriptor would
    // fail the payment hash check on a swap that was never broken.
};

/** `lightning:BTC->arkade:BTC`. */
export interface LightningReceiveProfile extends Record<string, unknown> {
    signer: RfqSignerProjection;
    hashlock: RfqHashlockProjection;
    /** The quote's `to_amount`, captured at REQUEST time. */
    expectedAmount: number;
    /** Where the claim pays. */
    payoutAddress: string;
    /**
     * Our Arkade claim's txid, once submitted.
     *
     * `claimIfFunded` derives `partiallyClaimed` from this. Restoring without it re-arms the value
     * gate against a partly claimed lockup, refusing the remainder over an already-public preimage.
     */
    claimTxid?: string;
}

const LightningReceiveCorridor: RfqCorridorHandler<LightningReceiveProfile> = {
    kind: "lightning_receive",

    // `payoutAddress` is written once by the caller from the request result; left alone here.
    project: (swap: RfqSwap) => {
        const receive = swap as LightningReceiveSwap;
        return {
            expectedAmount: receive.expectedAmount,
            ...(receive.claimTxid ? { claimTxid: receive.claimTxid } : {}),
        };
    },

    hydrate(profile) {
        // Required, never defaulted: `undefined` would delete the value gate rather than fail it,
        // and reading it at claim time would accept whatever the solver funded (dust attack).
        if (
            typeof profile.expectedAmount !== "number" ||
            !Number.isFinite(profile.expectedAmount)
        ) {
            throw new Error("lightning_receive record carries no expectedAmount; it cannot claim");
        }
        return {
            ...hydrateHashlock(profile),
            expectedAmount: profile.expectedAmount,
            ...(profile.claimTxid ? { claimTxid: profile.claimTxid } : {}),
        };
    },

    // We are the claimant here, so the preimage material on the hashlock is
    // ours to use.
    claimSecret: (profile) => ({ ...profile.signer, ...profile.hashlock }),

    claimDestination: (profile) => profile.payoutAddress,

    activityTxids: (profile) => (profile.claimTxid ? [profile.claimTxid] : []),
};

/** `arkade:BTC->onchain:BTC`. */
export interface OnchainSendProfile extends Record<string, unknown> {
    signer: RfqSignerProjection;
    hashlock: RfqHashlockProjection;
    /** The trader's L1 claim key. */
    claimKey: string;
    /** The solver's L1 key, from `profile.htlc_pubkey`. */
    refundKey: string;
    /** `profile.htlc_locktime` — the trader's L1 recourse deadline, distinct
     * from the arkade lockup's `refundLocktime`. */
    htlcLocktime: number;
    network: OnchainNetwork;
    /**
     * The L1 address the fill was expected at (`htlc.address`, already checked against the quote's
     * `profile.htlc_address`).
     *
     * Stored independently of the keys so the rebuild must reproduce it: a swapped or corrupted
     * key derives another valid HTLC at an address nobody funded, and this leg has no contract row
     * to catch that.
     */
    htlcAddress: string;
    /** `profile.min_confirmations`; gates when the fill is claimable. */
    minConfirmations: number;
    expectedAmount: number;
    /** Where the claim PAYS, hex. The spender's own choice, so nothing else
     * gives it back — and `buildHtlcClaim` needs it. */
    payoutPkScript: string;
    /** The fill's outpoint, learned on first sighting. Without it a SPENT htlc
     * reads as never funded — see `classifyOnchainHtlc`. */
    funding?: { txid: string; vout: number };
    /** Our own L1 claim, so a restart does not re-broadcast it. */
    claimTxid?: string;
}

/**
 * Build the profile's L1 half from what `requestOnchainSend` returned.
 *
 * Exists because the mapping is easy to get wrong by hand: `htlcParams.refundLocktime` becomes
 * `htlcLocktime` (the record's `refundLocktime` is the arkade lockup's), keys go bytes to hex, and
 * `htlcAddress` is a derived check value that is easy to skip and impossible to reconstruct.
 * `signer` and `hashlock` still come from `rfqSecretsProfile`, as for every corridor.
 */
export function onchainSendProfile(result: {
    htlc: Pick<OnchainHtlc, "address">;
    htlcParams: OnchainHtlcParams;
    l1Network: OnchainNetwork;
    minConfirmations: number;
    expectedAmount: number;
    payoutPkScript: Uint8Array;
}): Omit<OnchainSendProfile, "signer" | "hashlock"> {
    return {
        claimKey: hex.encode(result.htlcParams.claimKey),
        refundKey: hex.encode(result.htlcParams.refundKey),
        htlcLocktime: result.htlcParams.refundLocktime,
        network: result.l1Network,
        htlcAddress: result.htlc.address,
        minConfirmations: result.minConfirmations,
        expectedAmount: result.expectedAmount,
        payoutPkScript: hex.encode(result.payoutPkScript),
    };
}

/**
 * The one corridor that stores script parameters: the L1 HTLC is not an arkade contract, and
 * `OnchainHtlc` exposes only derived values, never its keys.
 */
const OnchainSendCorridor: RfqCorridorHandler<OnchainSendProfile> = {
    kind: "onchain_send",

    // The L1 keys and network are written once by the caller; the manager learns fill and claim.
    project: (swap: RfqSwap) => {
        const send = swap as OnchainSendSwap;
        return {
            expectedAmount: send.expectedAmount,
            ...(send.funding ? { funding: send.funding } : {}),
            ...(send.claimTxid ? { claimTxid: send.claimTxid } : {}),
        };
    },

    hydrate(profile) {
        const { paymentHash } = hydrateHashlock(profile);
        if (!profile.claimKey || !profile.refundKey) {
            throw new Error(
                "onchain_send record carries no L1 keys; its HTLC cannot be rebuilt and its " +
                    "refund window would pass unwatched",
            );
        }
        // Required, never defaulted: `confirmations < undefined` is false, so a missing value
        // deletes the confirmation gate and the swap claims an unconfirmed fill with the preimage.
        // Locktime, keys and network are checked by `onchainHtlcScript`.
        if (!Number.isInteger(profile.minConfirmations) || profile.minConfirmations < 1) {
            throw new Error(
                `onchain_send record carries no usable minConfirmations ` +
                    `(${String(profile.minConfirmations)}); the confirmation gate cannot be ` +
                    `checked — refusing to restore a swap that would claim an unconfirmed fill`,
            );
        }
        if (!Number.isSafeInteger(profile.expectedAmount) || profile.expectedAmount <= 0) {
            throw new Error(
                `onchain_send record carries no usable expectedAmount ` +
                    `(${String(profile.expectedAmount)}); the funded value cannot be checked — ` +
                    `refusing to restore a swap that would claim an underfunded fill`,
            );
        }
        const htlc = onchainHtlcScript(
            {
                // From the profile, not the covenant: the lockup commits to `hash160(P)`, the
                // HTLC needs `sha256(P)`.
                paymentHash,
                claimKey: hex.decode(profile.claimKey),
                refundKey: hex.decode(profile.refundKey),
                refundLocktime: profile.htlcLocktime,
            },
            profile.network,
        );
        // `rebuildRfqSwap`'s check for the arkade lockup, done here for L1: catch wrong
        // parameters at restore, not by watching an unfunded address until the refund window shuts.
        if (htlc.address !== profile.htlcAddress) {
            throw new Error(
                `onchain_send record's L1 inputs derive ${htlc.address}, but the fill was ` +
                    `expected at ${String(profile.htlcAddress)} — these are not this swap's`,
            );
        }
        return {
            paymentHash,
            htlc,
            minConfirmations: profile.minConfirmations,
            expectedAmount: profile.expectedAmount,
            // Optional here, required at the write: throwing on an older
            // record would strand the refund it is still owed.
            ...(profile.payoutPkScript
                ? { payoutPkScript: hex.decode(profile.payoutPkScript) }
                : {}),
            ...(profile.funding ? { funding: profile.funding } : {}),
            ...(profile.claimTxid ? { claimTxid: profile.claimTxid } : {}),
        };
    },

    // The trader claims the L1 HTLC with P, so this leg's preimage material is
    // ours.
    claimSecret: (profile) => ({ ...profile.signer, ...profile.hashlock }),

    // Our own L1 claim only: `funding` is the solver's tx, not a row this wallet made.
    activityTxids: (profile) => (profile.claimTxid ? [profile.claimTxid] : []),
};

rfqCorridorHandlers.register(LightningSendCorridor as RfqCorridorHandler);
rfqCorridorHandlers.register(LightningReceiveCorridor as RfqCorridorHandler);
rfqCorridorHandlers.register(OnchainSendCorridor as RfqCorridorHandler);
