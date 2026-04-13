import * as bip68 from "bip68";
import type { RelativeTimelock } from "../script/tapscript";

/**
 * Convert RelativeTimelock to BIP68 sequence number.
 */
export function timelockToSequence(timelock: RelativeTimelock): number {
    return bip68.encode(
        timelock.type === "blocks"
            ? { blocks: Number(timelock.value) }
            : { seconds: Number(timelock.value) }
    );
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
