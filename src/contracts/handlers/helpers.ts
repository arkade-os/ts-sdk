import { RelativeTimelock } from "../../script/tapscript";
import * as bip68 from "bip68";
import { Contract, PathContext } from "../types";
import { isDescriptor, extractPubKey } from "../../identity/descriptor";

/**
 * Extract raw hex pubkey from a value that may be a descriptor or raw hex.
 */
function extractRawPubKey(value: string): string {
    if (isDescriptor(value)) {
        return extractPubKey(value);
    }
    return value;
}

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

/**
 * Resolve wallet's role from explicit role or by matching pubkey.
 */
export function resolveRole(
    contract: Contract,
    context: PathContext
): "sender" | "receiver" | undefined {
    // Explicit role takes precedence
    if (context.role === "sender" || context.role === "receiver") {
        return context.role;
    }

    // Try to match wallet descriptor/pubkey against contract params
    const walletKey = context.walletDescriptor ?? context.walletPubKey;
    if (walletKey) {
        const rawWalletKey = extractRawPubKey(walletKey);
        const senderKey = contract.params.sender
            ? extractRawPubKey(contract.params.sender)
            : undefined;
        const receiverKey = contract.params.receiver
            ? extractRawPubKey(contract.params.receiver)
            : undefined;

        if (senderKey && rawWalletKey === senderKey) {
            return "sender";
        }
        if (receiverKey && rawWalletKey === receiverKey) {
            return "receiver";
        }
    }

    return undefined;
}

/**
 * BIP65 threshold: locktime values below this are interpreted as block heights,
 * values at or above are interpreted as Unix timestamps (seconds).
 */
const CLTV_HEIGHT_THRESHOLD = 500_000_000n;

/**
 * Check if an absolute (CLTV) locktime is currently satisfied.
 *
 * Following the BIP65 convention:
 * - locktime < 500_000_000  → interpreted as a block height; compared against `context.blockHeight`
 * - locktime >= 500_000_000 → interpreted as a Unix timestamp (seconds); compared against `context.currentTime`
 *
 * Returns false if the relevant context field is missing.
 */
export function isCltvSatisfied(
    context: PathContext,
    locktime: bigint
): boolean {
    if (locktime < CLTV_HEIGHT_THRESHOLD) {
        if (context.blockHeight === undefined) return false;
        return BigInt(context.blockHeight) >= locktime;
    }
    const currentTimeSec = BigInt(Math.floor(context.currentTime / 1000));
    return currentTimeSec >= locktime;
}

/**
 * Check if a CSV timelock is currently satisfied for the given context/VTXO.
 */
export function isCsvSpendable(
    context: PathContext,
    sequence?: number
): boolean {
    if (sequence === undefined) return true;
    if (!context.vtxo) return false;
    const timelock = sequenceToTimelock(sequence);

    if (timelock.type === "blocks") {
        if (
            context.blockHeight === undefined ||
            context.vtxo.status.block_height === undefined
        ) {
            return false;
        }
        return (
            context.blockHeight - context.vtxo.status.block_height >=
            Number(timelock.value)
        );
    }

    if (timelock.type === "seconds") {
        const blockTime = context.vtxo.status.block_time;
        if (blockTime === undefined) return false;
        return context.currentTime / 1000 - blockTime >= Number(timelock.value);
    }

    return false;
}
