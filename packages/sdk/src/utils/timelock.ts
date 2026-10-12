import * as bip68 from "bip68";
import type { RelativeTimelock } from "../script/tapscript";

/**
 * Convert RelativeTimelock to BIP68 sequence number.
 */
export function timelockToSequence(timelock: RelativeTimelock): number {
    const { type } = timelock;
    // `value` is typed bigint, but JS callers (and older examples) pass numbers.
    const raw: unknown = timelock.value;
    const value = typeof raw === "number" && Number.isSafeInteger(raw) ? BigInt(raw) : raw;
    // bip68 encodes a negative value as -1, an operand that fails CSV at spend time.
    if (typeof value !== "bigint" || value < 0n) {
        throw new Error(
            `Invalid relative timelock value ${String(raw)} — expected a non-negative integer`,
        );
    }
    switch (type) {
        case "blocks":
            return bip68.encode({ blocks: Number(value) });
        case "seconds":
            return bip68.encode({ seconds: Number(value) });
        default: {
            const unknownType: never = type;
            throw new Error(
                `Invalid relative timelock type '${String(unknownType)}' — expected blocks or seconds`,
            );
        }
    }
}

/**
 * Convert BIP68 sequence number back to RelativeTimelock.
 */
export function sequenceToTimelock(sequence: number): RelativeTimelock {
    const decoded = bip68.decode(sequence);
    if ("blocks" in decoded && decoded.blocks !== undefined) {
        return { type: "blocks", value: BigInt(decoded.blocks) };
    }
    if ("seconds" in decoded && decoded.seconds !== undefined) {
        return { type: "seconds", value: BigInt(decoded.seconds) };
    }
    throw new Error(`Invalid BIP68 sequence: ${sequence}`);
}

/**
 * Decode a BIP68 sequence, rejecting one that is not the canonical encoding of
 * the timelock it decodes to: the disable flag, or bits outside the value and
 * type fields, which would re-encode to different script bytes.
 */
export function sequenceToCanonicalTimelock(sequence: bigint): RelativeTimelock | undefined {
    if (sequence < 0n || sequence >= 0x80000000n) return undefined;
    const timelock = sequenceToTimelock(Number(sequence));
    return BigInt(timelockToSequence(timelock)) === sequence ? timelock : undefined;
}
