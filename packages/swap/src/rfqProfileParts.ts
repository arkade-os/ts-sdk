/**
 * The two profile keys a corridor writes about its own leg's keys, and the
 * readers that hand them back.
 *
 * None of this is on {@link RfqSwapRecord} itself, deliberately. A hashlock is a
 * property of a CORRIDOR, not of RFQ: today's three legs all lock to a preimage,
 * but a banco-style corridor settles with none, and a record shape that required
 * `paymentHash` would force it to store a fake — a value nothing can check.
 *
 * Three concerns, two stored keys:
 *
 * - `profile.signer` — which wallet key signs this leg. Survives the hashlock
 *   entirely: it feeds `senderIdentityForSwapRecord` on the refund side, and a
 *   corridor with no preimage anywhere still has a leg to sign.
 * - `profile.hashlock` — the lock's identity, plus the preimage material only on
 *   legs WE claim. `lightning_send` carries a payment hash and can never open
 *   it: P belongs to the payee.
 *
 * A corridor writes both with {@link rfqSecretsProfile} and never by hand — the
 * salt is what hand-mapping drops, and a static wallet's swap is unclaimable
 * without it.
 *
 * One reader here is about no key at all — {@link rfqClaimDestinationOf}, where a
 * leg's claim pays. It sits beside {@link rfqClaimSecretOf} because the claim
 * path reads the two in one breath, and because both are answered the same way:
 * by the corridor's own handler, never by a cast or a `kind` switch at the call
 * site.
 */
import { rfqCorridorHandlers } from "./rfqCorridor";
import {
    PreimageNotRecoverableError,
    swapSecretsToRecord,
    type SwapSecretsProjection,
} from "./store";
import type { RfqSwapRecord } from "./rfqRecord";
import type { ProvisionedClaimSecret, ProvisionedKey } from "@arkade-os/sdk";

/**
 * Which wallet key signs this leg. Stored at `profile.signer`.
 *
 * Independent of any hashlock: it feeds `senderIdentityForSwapRecord` on the
 * refund side, and a corridor that settles with no preimage at all still needs
 * it. A corridor whose leg this wallet never signs omits the key entirely — as
 * with everything else here, absent rather than blank.
 */
export interface RfqSignerProjection {
    /** Public. The wallet re-derives the signer from it; no key material is at
     * rest. */
    signingDescriptor: string;
}

/**
 * What a leg locked to a preimage records about the LOCK. Stored at
 * `profile.hashlock`, and absent entirely from a corridor that has none.
 *
 * `paymentHash` is identity, not capability — `lightning_send` carries one and
 * can never open it. The preimage fields are the capability, and only a corridor
 * where WE claim ever writes them: `provisionClaimSecret` produces that arm,
 * `provisionRefundKey` does not.
 */
export type RfqHashlockProjection = Omit<SwapSecretsProjection, "signingDescriptor"> & {
    /** `sha256(P)`, hex. Not recoverable from the covenant, which binds
     * `hash160(P)`. */
    paymentHash: string;
};

/**
 * The composed view `preimageForSwapRecord` reads — the signer's descriptor plus
 * the hashlock's. **Never a stored shape**: nothing writes this object,
 * {@link rfqClaimSecretOf} assembles it from the two keys above, which is what
 * keeps the descriptor stored once.
 *
 * Structurally `SwapSecretsProjection & { paymentHash }`, which is exactly that
 * helper's parameter.
 */
export type RfqClaimSecretProjection = RfqSignerProjection & RfqHashlockProjection;

/**
 * The corridor-owned counterpart of `onchainSendProfile`: the one supported way
 * to turn a provisioned secret into stored profile keys.
 *
 * Writes what the provisioning result actually has. Omit `paymentHash` and you
 * get `signer` alone — which is what a non-hashlock corridor calls, and why it
 * never has to reach for `hashlock`.
 */
export const rfqSecretsProfile = (
    secrets: ProvisionedKey | ProvisionedClaimSecret,
    paymentHash?: string,
): { signer: RfqSignerProjection; hashlock?: RfqHashlockProjection } => {
    // Split whole, never field-picked: `signingDescriptor` is named because it
    // is the one field that is NOT preimage material, and everything else
    // `swapSecretsToRecord` emits rides into `hashlock` on the rest. That is
    // what carries `preimageSaltHex`, and hand-listing is how it was lost.
    // The rule to keep: a field added to `SwapSecretsProjection` that is not
    // preimage material must be named here too, or it lands in the wrong key.
    const { signingDescriptor, ...preimage } = swapSecretsToRecord(secrets);
    return {
        signer: { signingDescriptor },
        ...(paymentHash ? { hashlock: { paymentHash, ...preimage } } : {}),
    };
};

/** 64 characters of hex, case-folded to what `hex.encode` emits — a backend that
 * normalises hex to upper case round-trips a correct value, and rejecting it
 * here would fail the record for the backend's habit. */
const parseHex32 = (value: unknown, field: string): string => {
    if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error(`${field} must be 32 bytes of hex, got ${JSON.stringify(value)}`);
    }
    return value.toLowerCase();
};

/**
 * Validate a stored `profile.signer`.
 *
 * THROWS on a present-but-unusable object; never normalises one away. See
 * {@link rfqSignerOf} for why the difference matters.
 */
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

/**
 * Validate a stored claim destination.
 *
 * THROWS on a present-but-unusable value, the rule every parser here follows.
 * The alternative is what this replaced: a cast to `{ payoutAddress?: string }`
 * over a `Record<string, unknown>`, which typechecks against a shape nothing
 * verified and lets a row carrying a number reach `ArkAddress.decode` as one —
 * failing with the decoder's error, naming neither the record nor the field.
 */
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
 * Validate a stored `profile.hashlock`. The single source for that check —
 * {@link hydrateHashlock} calls it at restore, {@link rfqClaimSecretOf} at read,
 * so the two cannot drift into disagreeing about what a usable hashlock is.
 *
 * THROWS on a present-but-unusable object; never normalises one away. The
 * asymmetry that makes `paymentHash` the field to guard: the preimage fields are
 * validated downstream by `preimageForSwapRecord`, while `paymentHash` has no
 * check anywhere — and `preimageForSwapRecord` verifies only `if
 * (record.paymentHash …)`, so a projection missing it claims with an unverified
 * preimage instead of failing.
 */
export const parseHashlock = (value: unknown): RfqHashlockProjection => {
    const raw = (value ?? {}) as {
        paymentHash?: unknown;
        preimageHex?: unknown;
        preimageSaltHex?: unknown;
    };
    const hashlock: RfqHashlockProjection = {
        paymentHash: parseHex32(raw.paymentHash, "rfq profile.hashlock.paymentHash"),
    };
    // Checked here as well as downstream so a restore and a claim-secret read
    // agree: `preimageForSwapRecord` would reject these too, but only once the
    // claim is being attempted.
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

/**
 * The hashlock a corridor's `hydrate` merges onto the live swap, or a refusal to
 * restore.
 *
 * Every hashlock handler calls this first. Same rule as the receive leg's
 * `expectedAmount` and the onchain leg's L1 keys: refuse to restore rather than
 * restore half-armed. A swap rebuilt without its payment hash cannot verify a
 * derived preimage, and on the onchain leg cannot rebuild the L1 HTLC at all.
 *
 * A plain `Error`, matching the corridor's other refusals — same validator as
 * the claim-path reader, different wrapper, because a restore failure is read by
 * the manager and a claim-read failure by the claim path.
 */
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
 * `undefined` ONLY when the profile carries no `signer` key — a corridor whose
 * leg this wallet does not sign. A `signer` that is present and unusable throws:
 * "this corridor has no local signer" and "this record came back corrupt" are
 * different answers, and `senderIdentityForSwapRecord` turns the first into a
 * permanent `RefundNotLocallyPossibleError("no-secrets")` the manager acts on.
 * Handing it a silently-emptied projection would report "no local refund is
 * possible" for a storage bug.
 */
export const rfqSignerOf = (record: RfqSwapRecord): RfqSignerProjection | undefined => {
    const signer = record.profile.signer;
    if (signer === undefined) return undefined;
    return parseSigner(signer);
};

/**
 * The claim inputs, or `undefined` when this record's corridor cannot produce P
 * — no hashlock, or a leg we refund rather than claim.
 *
 * Answered by the corridor's handler (`claimSecret`), not by a kind list here:
 * whether a leg claims is the corridor's fact.
 *
 * When the handler DOES claim, this validates and throws
 * `PreimageNotRecoverableError("malformed-record")` rather than returning a
 * partial projection — which `preimageForSwapRecord` would claim with, its hash
 * check being conditional on the very field that went missing.
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

/**
 * Where this record's claim pays, or `undefined` when its corridor claims
 * nothing — the same two answers, for the same reason, as {@link rfqClaimSecretOf},
 * and a present-but-unusable value throws rather than reading as absent.
 *
 * Asked of the corridor's handler, not of a `kind` narrowing here: whether a leg
 * claims is the corridor's fact, and so is the key it wrote the destination
 * under. A corridor added later contributes both without touching this file.
 */
export const rfqClaimDestinationOf = (record: RfqSwapRecord): string | undefined => {
    const handler = rfqCorridorHandlers.getOrThrow(record.kind);
    if (!handler.claimDestination) return undefined;
    return parsePayoutAddress(handler.claimDestination(record.profile), record.kind);
};
