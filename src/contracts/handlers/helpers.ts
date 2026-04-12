import { RelativeTimelock } from "../../script/tapscript";
import {
    timelockToSequence as timelockToSequenceImpl,
    sequenceToTimelock as sequenceToTimelockImpl,
} from "../../utils/timelock";
import { Contract, PathContext } from "../types";
import { isDescriptor, extractPubKey } from "../../identity/descriptor";

/**
 * Extract raw hex pubkey from a value that may be a descriptor or raw hex.
 * Returns undefined for HD descriptors or unparseable values so role
 * resolution stays best-effort and never throws.
 */
function extractRawPubKey(value: string): string | undefined {
    if (!isDescriptor(value)) {
        return value.toLowerCase();
    }
    try {
        return extractPubKey(value).toLowerCase();
    } catch {
        return undefined;
    }
}

/**
 * Convert RelativeTimelock to BIP68 sequence number.
 */
export function timelockToSequence(timelock: RelativeTimelock): number {
    return timelockToSequenceImpl(timelock);
}

/**
 * Convert BIP68 sequence number back to RelativeTimelock.
 */
export function sequenceToTimelock(sequence: number): RelativeTimelock {
    return sequenceToTimelockImpl(sequence);
}

/**
 * Resolve wallet's role from explicit role or by matching descriptor/pubkey.
 */
export function resolveRole(
    contract: Contract,
    context: PathContext
): "sender" | "receiver" | undefined {
    // Explicit role takes precedence
    if (context.role === "sender" || context.role === "receiver") {
        return context.role;
    }

    const senderKey = contract.params.sender
        ? extractRawPubKey(contract.params.sender)
        : undefined;
    const receiverKey = contract.params.receiver
        ? extractRawPubKey(contract.params.receiver)
        : undefined;

    const matchRole = (
        rawWalletKey: string | undefined
    ): "sender" | "receiver" | undefined => {
        if (!rawWalletKey) return undefined;
        if (senderKey && rawWalletKey === senderKey) {
            return "sender";
        }
        if (receiverKey && rawWalletKey === receiverKey) {
            return "receiver";
        }
        return undefined;
    };

    // Try the preferred descriptor first. If it cannot be resolved
    // (for example an HD descriptor without derivation support), fall back
    // to walletPubKey for backward compatibility.
    if (context.walletDescriptor) {
        const walletDescriptorKey = extractRawPubKey(context.walletDescriptor);
        const matchedRole = matchRole(walletDescriptorKey);
        if (matchedRole) {
            return matchedRole;
        }

        if (!walletDescriptorKey && context.walletPubKey) {
            return matchRole(extractRawPubKey(context.walletPubKey));
        }
        return undefined;
    }

    if (context.walletPubKey) {
        return matchRole(extractRawPubKey(context.walletPubKey));
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
 * Check if a CSV timelock is currently satisfied for the given context/virtual output.
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
