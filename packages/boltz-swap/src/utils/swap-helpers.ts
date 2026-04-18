import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import {
    isPendingChainSwap,
    isPendingReverseSwap,
    isPendingSubmarineSwap,
} from "../boltz-swap-provider";
import {
    BoltzChainSwap,
    BoltzReverseSwap,
    BoltzSubmarineSwap,
    BoltzSwap,
} from "../types";
import { decodeInvoice } from "./decoding";

/**
 * Generic type for swap save functions
 */
export type SwapSaver = {
    saveChainSwap?: (swap: BoltzChainSwap) => Promise<void>;
    saveReverseSwap?: (swap: BoltzReverseSwap) => Promise<void>;
    saveSubmarineSwap?: (swap: BoltzSubmarineSwap) => Promise<void>;
};

/**
 * Save a swap of any type using the appropriate saver function
 * This eliminates the need for type checking in multiple places
 */
export async function saveSwap(
    swap: BoltzSwap,
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
    swap: BoltzReverseSwap,
    status: BoltzReverseSwap["status"],
    saveFunc: (swap: BoltzReverseSwap) => Promise<void>,
    additionalFields?: Partial<BoltzReverseSwap>
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
    swap: BoltzSubmarineSwap,
    status: BoltzSubmarineSwap["status"],
    saveFunc: (swap: BoltzSubmarineSwap) => Promise<void>,
    additionalFields?: Partial<BoltzSubmarineSwap>
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
    swap: BoltzChainSwap,
    status: BoltzChainSwap["status"],
    saveFunc: (swap: BoltzChainSwap) => Promise<void>,
    additionalFields?: Partial<BoltzChainSwap>
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
    swap: BoltzReverseSwap,
    preimage: string
): BoltzReverseSwap {
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
    swap: BoltzSubmarineSwap,
    invoice: string
): BoltzSubmarineSwap {
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
