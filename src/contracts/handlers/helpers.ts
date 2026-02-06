import { RelativeTimelock } from "../../script/tapscript";
import * as bip68 from "bip68";
import { Contract, PathContext } from "../types";
import {
    isDescriptor,
    extractPubKey,
    normalizeToDescriptor,
} from "../../identity/descriptor";

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
 * Extract the raw pubkey from a value (descriptor or hex).
 * Used for role matching.
 */
function extractRawPubKey(value: string): string {
    if (isDescriptor(value)) {
        return extractPubKey(value);
    }
    return value;
}

/**
 * Resolve wallet's role from explicit role or by matching pubkey/descriptor.
 *
 * Checks both walletDescriptor (preferred) and walletPubKey (deprecated fallback)
 * against contract params. Contract params may be stored as either descriptors
 * or raw hex pubkeys, so we normalize both for comparison.
 */
export function resolveRole(
    contract: Contract,
    context: PathContext
): "sender" | "receiver" | undefined {
    // Explicit role takes precedence
    if (context.role === "sender" || context.role === "receiver") {
        return context.role;
    }

    // Get wallet's pubkey from descriptor or legacy field
    let walletPubKey: string | undefined;
    if (context.walletDescriptor) {
        walletPubKey = extractRawPubKey(context.walletDescriptor);
    } else if (context.walletPubKey) {
        // Deprecated fallback
        walletPubKey = context.walletPubKey;
    }

    if (!walletPubKey) {
        return undefined;
    }

    // Extract pubkeys from contract params (may be descriptors or raw hex)
    const senderPubKey = contract.params.sender
        ? extractRawPubKey(contract.params.sender)
        : undefined;
    const receiverPubKey = contract.params.receiver
        ? extractRawPubKey(contract.params.receiver)
        : undefined;

    if (senderPubKey && walletPubKey === senderPubKey) {
        return "sender";
    }
    if (receiverPubKey && walletPubKey === receiverPubKey) {
        return "receiver";
    }

    return undefined;
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
