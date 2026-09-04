/**
 * The corridors this package persists, one handler each.
 *
 * Adding a corridor is a handler here plus a `register()` call at the bottom —
 * no edit to `RfqSwapRecord`, the repository, or the IndexedDB store, none of
 * which name a corridor. See `rfqCorridor.ts` for why it is shaped this way.
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
 * `arkade:BTC->lightning:BTC`. Nothing beyond its keys and the covenant: the
 * solver claims the lockup, the trader's only move is the refund, and the rest
 * of the leg is fully described by the contract row.
 *
 * The one leg with a hashlock it can never open — P belongs to the payee — so
 * `hashlock` here is `{ paymentHash }` alone and `signer` holds a REFUND key.
 */
export interface LightningSendProfile extends Record<string, unknown> {
    signer: RfqSignerProjection;
    hashlock: RfqHashlockProjection;
}

export const LightningSendCorridor: RfqCorridorHandler<LightningSendProfile> = {
    kind: "lightning_send",
    project: () => ({}),
    hydrate: (profile) => hydrateHashlock(profile),
    // No `claimSecret`, deliberately: `provisionRefundKey` mints no preimage at
    // all, and deriving one off the refund descriptor would fail the payment
    // hash check — a `hash-mismatch` on a swap that was never broken.
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
     * Here rather than on the record's common half, which is for fields all
     * three legs carry: this one is the receive leg's alone, the counterpart of
     * the onchain leg's `claimTxid`. Restoring without it re-arms the value gate
     * against a lockup we have already partly claimed — `claimIfFunded` reads
     * `partiallyClaimed` off exactly this — so the remainder is refused over a
     * preimage that is already public, and a swap that did claim is relabelled
     * `needs_counterparty` once its window shuts.
     */
    claimTxid?: string;
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
            ...(receive.claimTxid ? { claimTxid: receive.claimTxid } : {}),
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
            ...hydrateHashlock(profile),
            expectedAmount: profile.expectedAmount,
            ...(profile.claimTxid ? { claimTxid: profile.claimTxid } : {}),
        };
    },

    // We are the claimant here, so the preimage material on the hashlock is
    // ours to use.
    claimSecret: (profile) => ({ ...profile.signer, ...profile.hashlock }),

    // The other half of claiming: where it pays. Written once at request time
    // and left alone by `project` above, so this hands back what was stored.
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
     * The L1 address the fill was expected at — `htlc.address` from
     * `requestOnchainSend`, which `deriveOnchainSend` has already checked
     * against the quote's own `profile.htlc_address`.
     *
     * The counterpart of the record's `lockupAddress`, and here for the same
     * reason: the inputs above and this address reach the record by independent
     * routes, so requiring the rebuild to reproduce it is what catches a
     * parameter that came back wrong. The arkade lockup gets that check from
     * `rebuildRfqSwap`; this leg, the one whose parameters have no second source
     * anywhere, would otherwise get none — and a swapped or corrupted key
     * derives another perfectly valid HTLC, at an address nobody funded.
     */
    htlcAddress: string;
    /** `profile.min_confirmations`; gates when the fill is claimable. */
    minConfirmations: number;
    /** The fill's outpoint, learned on first sighting. Without it a SPENT htlc
     * reads as never funded — see `classifyOnchainHtlc`. */
    funding?: { txid: string; vout: number };
    /** Our own L1 claim, so a restart does not re-broadcast it. */
    claimTxid?: string;
}

/**
 * Build the profile from what `requestOnchainSend` returned.
 *
 * Pass the whole result: every field this needs is on it, so the mapping is
 * done here, once, instead of at each call site.
 *
 * That mapping is the reason this exists. `htlcParams.refundLocktime` becomes
 * `htlcLocktime` — the same value under a different name, because the record
 * already has a `refundLocktime` and it is the arkade lockup's, a different
 * deadline entirely. The keys go from bytes to hex. `htlcAddress` is not an
 * input to anything, it is the derived value the rebuild checks the inputs
 * against, so writing it is easy to skip and impossible to reconstruct later.
 * A caller copying fields across by hand gets all three right or restores a
 * swap that watches nothing.
 *
 * The other two corridors have no such builder, deliberately: their profiles
 * are the request result's own fields under their own names, with nothing
 * derived and nothing renamed.
 *
 * The L1 half ONLY. `signer` and `hashlock` come from `rfqSecretsProfile`, which
 * every corridor calls — folding them in here would give this leg a one-call
 * mapper the other two cannot have, and the uniform rule ("`rfqSecretsProfile`
 * first, then whatever the corridor adds") is what keeps the per-corridor
 * instructions short enough to follow.
 */
export function onchainSendProfile(result: {
    htlc: Pick<OnchainHtlc, "address">;
    htlcParams: OnchainHtlcParams;
    l1Network: OnchainNetwork;
    minConfirmations: number;
}): Omit<OnchainSendProfile, "signer" | "hashlock"> {
    return {
        claimKey: hex.encode(result.htlcParams.claimKey),
        refundKey: hex.encode(result.htlcParams.refundKey),
        htlcLocktime: result.htlcParams.refundLocktime,
        network: result.l1Network,
        htlcAddress: result.htlc.address,
        minConfirmations: result.minConfirmations,
    };
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

    hydrate(profile) {
        // Its own hashlock, not the context's: one owner for the value, and a
        // corridor with none is never handed a fake.
        const { paymentHash } = hydrateHashlock(profile);
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
        const htlc = onchainHtlcScript(
            {
                // From the profile, not the covenant: the lockup commits to
                // `hash160(P)`, and the HTLC needs `sha256(P)`. One P
                // unlocks both legs, but only one of the two hashes of it
                // is recoverable here.
                paymentHash,
                claimKey: hex.decode(profile.claimKey),
                refundKey: hex.decode(profile.refundKey),
                refundLocktime: profile.htlcLocktime,
            },
            profile.network,
        );
        // What `rebuildRfqSwap` does for the arkade lockup, on the leg that
        // cannot borrow a contract row to do it: parameters that derive some
        // other HTLC are caught here, at restore, rather than by a claim that
        // watches an address nobody funded until the refund window shuts.
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
            ...(profile.funding ? { funding: profile.funding } : {}),
            ...(profile.claimTxid ? { claimTxid: profile.claimTxid } : {}),
        };
    },

    // The trader claims the L1 HTLC with P, so this leg's preimage material is
    // ours.
    claimSecret: (profile) => ({ ...profile.signer, ...profile.hashlock }),

    // Our own L1 claim only. `funding` is the SOLVER's fill into the HTLC —
    // not a transaction of ours, so grouping it would claim a row this wallet
    // never made.
    activityTxids: (profile) => (profile.claimTxid ? [profile.claimTxid] : []),
};

rfqCorridorHandlers.register(LightningSendCorridor as RfqCorridorHandler);
rfqCorridorHandlers.register(LightningReceiveCorridor as RfqCorridorHandler);
rfqCorridorHandlers.register(OnchainSendCorridor as RfqCorridorHandler);
