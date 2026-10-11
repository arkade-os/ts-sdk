/**
 * The profile keys a corridor writes about its leg's keys — `profile.signer` and `profile.hashlock`
 * — and their readers. Not on {@link RfqSwapRecord} itself: a hashlock is a CORRIDOR property, and a
 * preimage-less corridor would otherwise store a fake `paymentHash`.
 *
 * Write both with {@link rfqSecretsProfile}, never by hand: hand-mapping drops the salt, and a
 * static wallet's swap is unclaimable without it. Readers ask the corridor's handler, never a cast.
 */
import { rfqCorridorHandlers } from "./rfqCorridor";
import {
    PreimageNotRecoverableError,
    swapSecretsToRecord,
    type SwapSecretsProjection,
} from "./store";
import type { RfqSwapRecord } from "./rfqRecord";
import type { ProvisionedClaimSecret, ProvisionedKey } from "@arkade-os/sdk";

/** Which wallet key signs this leg, at `profile.signer`. Omitted entirely (not blank) by a corridor
 * whose leg this wallet never signs. */
export interface RfqSignerProjection {
    /** Public. The wallet re-derives the signer from it; no key material is at
     * rest. */
    signingDescriptor: string;
}

/**
 * What a preimage-locked leg records about the LOCK, at `profile.hashlock`. `paymentHash` is
 * identity, not capability; the preimage fields are the capability, written only where WE claim
 * (`provisionClaimSecret` produces that arm, `provisionRefundKey` does not).
 */
export type RfqHashlockProjection = Omit<SwapSecretsProjection, "signingDescriptor"> & {
    /** `sha256(P)`, hex. Not recoverable from the covenant, which binds
     * `hash160(P)`. */
    paymentHash: string;
};

/** The composed view `preimageForSwapRecord` reads. **Never a stored shape**: assembled by
 * {@link rfqClaimSecretOf} from the two keys, so the descriptor is stored once. */
export type RfqClaimSecretProjection = RfqSignerProjection & RfqHashlockProjection;

/**
 * The one supported way to turn a provisioned secret into stored profile keys (the corridor-owned
 * counterpart of `onchainSendProfile`). Without `paymentHash` it writes `signer` alone.
 */
export const rfqSecretsProfile = (
    secrets: ProvisionedKey | ProvisionedClaimSecret,
    paymentHash?: string,
): { signer: RfqSignerProjection; hashlock?: RfqHashlockProjection } => {
    // Split whole, never field-picked: hand-listing is how `preimageSaltHex` was lost. A field added
    // to `SwapSecretsProjection` that is not preimage material must be named here too.
    const { signingDescriptor, ...preimage } = swapSecretsToRecord(secrets);
    return {
        signer: { signingDescriptor },
        ...(paymentHash ? { hashlock: { paymentHash, ...preimage } } : {}),
    };
};

/** 64 hex chars, case-folded: a backend that uppercases hex round-trips a correct value, and
 * rejecting it would fail the record for the backend's habit. */
const parseHex32 = (value: unknown, field: string): string => {
    if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error(`${field} must be 32 bytes of hex, got ${JSON.stringify(value)}`);
    }
    return value.toLowerCase();
};

/** Validate a stored `profile.signer`. THROWS on a present-but-unusable object (see
 * {@link rfqSignerOf} for why). */
const parseSigner = (value: unknown): RfqSignerProjection => {
    const signingDescriptor = (value as { signingDescriptor?: unknown } | undefined)
        ?.signingDescriptor;
    if (typeof signingDescriptor !== "string" || signingDescriptor.length === 0) {
        throw new Error(
            `rfq profile.signer carries no signingDescriptor (got ${JSON.stringify(signingDescriptor)})`,
        );
    }
    return { signingDescriptor };
};

/** Validate a stored claim destination. THROWS on a present-but-unusable value, so a row carrying a
 * non-string never reaches `ArkAddress.decode` and fails naming neither record nor field. */
const parsePayoutAddress = (value: unknown, kind: string): string => {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(
            `this ${kind} record's claim destination is unusable: expected an Arkade ` +
                `address, got ${JSON.stringify(value)}`,
        );
    }
    return value;
};

/**
 * Validate a stored `profile.hashlock` — the one check restore and read share. `paymentHash` is the
 * field to guard: `preimageForSwapRecord` verifies only when it is present, so a projection missing
 * it would claim with an unverified preimage.
 */
const parseHashlock = (value: unknown): RfqHashlockProjection => {
    const raw = (value ?? {}) as {
        paymentHash?: unknown;
        preimageHex?: unknown;
        preimageSaltHex?: unknown;
    };
    const hashlock: RfqHashlockProjection = {
        paymentHash: parseHex32(raw.paymentHash, "rfq profile.hashlock.paymentHash"),
    };
    // also checked here so restore and claim-secret read agree, not only at claim time
    if (raw.preimageHex !== undefined) {
        hashlock.preimageHex = parseHex32(raw.preimageHex, "rfq profile.hashlock.preimageHex");
    }
    if (raw.preimageSaltHex !== undefined) {
        hashlock.preimageSaltHex = parseHex32(
            raw.preimageSaltHex,
            "rfq profile.hashlock.preimageSaltHex",
        );
    }
    return hashlock;
};

/** The hashlock a corridor's `hydrate` merges onto the live swap, or a refusal to restore rather
 * than restore half-armed (no preimage check, and no L1 HTLC rebuild on the onchain leg). */
export const hydrateHashlock = (profile: {
    hashlock?: RfqHashlockProjection;
}): { paymentHash: string } => {
    try {
        return { paymentHash: parseHashlock(profile.hashlock).paymentHash };
    } catch (cause) {
        throw new Error(
            `rfq record carries no usable hashlock; it cannot verify a preimage: ${String(cause)}`,
            { cause },
        );
    }
};

/**
 * The stored signer projection, for `senderIdentityForSwapRecord`.
 *
 * `undefined` ONLY when no `signer` key exists (a leg this wallet does not sign). A present but
 * unusable one throws: the caller turns "no local signer" into a permanent
 * `RefundNotLocallyPossibleError("no-secrets")`, which must not be reported for a storage bug.
 */
export const rfqSignerOf = (record: RfqSwapRecord): RfqSignerProjection | undefined => {
    const signer = record.profile.signer;
    if (signer === undefined) return undefined;
    return parseSigner(signer);
};

/**
 * The claim inputs, or `undefined` when the corridor's handler has no `claimSecret` (no hashlock, or
 * a leg we refund). When it does claim, a malformed projection throws
 * `PreimageNotRecoverableError("malformed-record")` rather than returning a partial one that
 * `preimageForSwapRecord` would claim with unverified.
 */
export const rfqClaimSecretOf = (record: RfqSwapRecord): RfqClaimSecretProjection | undefined => {
    const handler = rfqCorridorHandlers.getOrThrow(record.kind);
    if (!handler.claimSecret) return undefined;
    try {
        const claim = handler.claimSecret(record.profile);
        return { ...parseSigner(claim), ...parseHashlock(claim) };
    } catch (cause) {
        throw new PreimageNotRecoverableError(
            "malformed-record",
            `this ${record.kind} record's claim secret is unreadable: ${String(cause)}`,
            { cause },
        );
    }
};

/** Where this record's claim pays, or `undefined` when its corridor claims nothing — same rules as
 * {@link rfqClaimSecretOf}; the handler owns both the fact and the profile key. */
export const rfqClaimDestinationOf = (record: RfqSwapRecord): string | undefined => {
    const handler = rfqCorridorHandlers.getOrThrow(record.kind);
    if (!handler.claimDestination) return undefined;
    return parsePayoutAddress(handler.claimDestination(record.profile), record.kind);
};
