import * as bip68 from "bip68";
import type { RelativeTimelock } from "../script/tapscript";

/**
 * Convert RelativeTimelock to BIP68 sequence number.
 */
export function timelockToSequence(timelock: RelativeTimelock): number {
    const value = Number(timelock.value);
    // bip68 checks only the maximum; a negative value compiles to another CSV or a failing one.
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`invalid ${timelock.type} timelock ${timelock.value}`);
    }
    return bip68.encode(timelock.type === "blocks" ? { blocks: value } : { seconds: value });
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
