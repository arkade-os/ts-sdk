import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import {
    isPendingChainSwap,
    isPendingReverseSwap,
    isPendingSubmarineSwap,
} from "../boltz-swap-provider";
import {
    PendingChainSwap,
    PendingReverseSwap,
    PendingSubmarineSwap,
    PendingSwap,
} from "../types";
import { decodeInvoice } from "./decoding";

/**
 * Generic type for swap save functions
 */
export type SwapSaver = {
    saveChainSwap?: (swap: PendingChainSwap) => Promise<void>;
    saveReverseSwap?: (swap: PendingReverseSwap) => Promise<void>;
    saveSubmarineSwap?: (swap: PendingSubmarineSwap) => Promise<void>;
};

/**
 * Save a swap of any type using the appropriate saver function
 * This eliminates the need for type checking in multiple places
 */
export async function saveSwap(
    swap: PendingSwap,
    saver: SwapSaver
): Promise<void> {
    if (isPendingReverseSwap(swap)) {
        if (saver.saveReverseSwap) {
            await saver.saveReverseSwap(swap);
        } else {
            console.warn("No saveReverseSwap handler provided, swap not saved");
        }
    } else if (isPendingSubmarineSwap(swap)) {
        if (saver.saveSubmarineSwap) {
            await saver.saveSubmarineSwap(swap);
        } else {
            console.warn(
                "No saveSubmarineSwap handler provided, swap not saved"
            );
        }
    } else if (isPendingChainSwap(swap)) {
        if (saver.saveChainSwap) {
            await saver.saveChainSwap(swap);
        } else {
            console.warn("No saveChainSwap handler provided, swap not saved");
        }
    }
}

/**
 * Update a reverse swap's status and save it
 */
export async function updateReverseSwapStatus(
    swap: PendingReverseSwap,
    status: PendingReverseSwap["status"],
    saveFunc: (swap: PendingReverseSwap) => Promise<void>,
    additionalFields?: Partial<PendingReverseSwap>
): Promise<void> {
    await saveFunc({
        ...swap,
        status,
        ...additionalFields,
    });
}

/**
 * Update a submarine swap's status and save it
 */
export async function updateSubmarineSwapStatus(
    swap: PendingSubmarineSwap,
    status: PendingSubmarineSwap["status"],
    saveFunc: (swap: PendingSubmarineSwap) => Promise<void>,
    additionalFields?: Partial<PendingSubmarineSwap>
): Promise<void> {
    await saveFunc({
        ...swap,
        status,
        ...additionalFields,
    });
}

/**
 * Update a chain swap's status and save it
 */
export async function updateChainSwapStatus(
    swap: PendingChainSwap,
    status: PendingChainSwap["status"],
    saveFunc: (swap: PendingChainSwap) => Promise<void>,
    additionalFields?: Partial<PendingChainSwap>
): Promise<void> {
    await saveFunc({
        ...swap,
        status,
        ...additionalFields,
    });
}

/**
 * Enrich a reverse swap with its preimage after validation.
 */
export function enrichReverseSwapPreimage(
    swap: PendingReverseSwap,
    preimage: string
): PendingReverseSwap {
    const computedHash = hex.encode(sha256(hex.decode(preimage)));
    if (computedHash !== swap.request.preimageHash) {
        throw new Error(
            `Preimage does not match swap: expected hash ${swap.request.preimageHash}, got ${computedHash}`
        );
    }
    swap.preimage = preimage;
    return swap;
}

/**
 * Enrich a submarine swap with its invoice after validation.
 */
export function enrichSubmarineSwapInvoice(
    swap: PendingSubmarineSwap,
    invoice: string
): PendingSubmarineSwap {
    let paymentHash: string;
    try {
        const decoded = decodeInvoice(invoice);
        if (!decoded.paymentHash) {
            throw new Error("Invoice missing payment hash");
        }
        paymentHash = decoded.paymentHash;
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Invalid Lightning invoice: ${error.message}`);
        }
        throw new Error(`Invalid Lightning invoice format`);
    }

    if (swap.preimageHash && paymentHash !== swap.preimageHash) {
        throw new Error(
            `Invoice payment hash does not match swap: expected ${swap.preimageHash}, got ${paymentHash}`
        );
    }

    swap.request.invoice = invoice;
    return swap;
}
