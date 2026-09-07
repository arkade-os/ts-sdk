import { vi } from "vitest";

import type { ArkadeAddress, PubKeyHex, XOnlyPubKeyHex } from "../types";
import {
    validateInputIndexes,
    validateNetwork,
    validatePsbt,
    validateSignerPubkey,
    validateUnilateralExitDelay,
} from "../utils";

/**
 * Mock wallet functions for testing RPC contract.
 * These mocks validate inputs using the real validation utilities,
 * but return mock data to avoid SDK dependencies.
 */

export const getPublicKey = vi.fn(
    async (): Promise<{
        compressedPublicKey: PubKeyHex;
        xOnlyPublicKey: XOnlyPubKeyHex;
    }> => {
        return {
            compressedPublicKey:
                "02a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
            xOnlyPublicKey: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        };
    },
);

export const getAddress = vi.fn(async (params: unknown): Promise<{ address: ArkadeAddress }> => {
    // Validate params structure (same as real implementation)
    if (!params || typeof params !== "object") {
        throw new Error("Invalid params: expected object");
    }

    const { network, signerPubkey, unilateralExitDelay } = params as {
        network: unknown;
        signerPubkey: unknown;
        unilateralExitDelay: unknown;
    };

    // Validate individual parameters using real validation
    const validatedNetwork = validateNetwork(network);
    validateSignerPubkey(signerPubkey);
    validateUnilateralExitDelay(unilateralExitDelay);

    // Return mock address with appropriate prefix
    const prefix = validatedNetwork === "bitcoin" ? "ark" : "tark";
    return {
        address: `${prefix}1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq5zz8tt`,
    };
});

export const signPsbt = vi.fn(async (params: unknown): Promise<{ psbt: string }> => {
    // Validate params structure (same as real implementation)
    if (!params || typeof params !== "object") {
        throw new Error("Invalid params: expected object");
    }

    const { psbt, inputIndexes } = params as { psbt: unknown; inputIndexes: unknown };

    // Validate individual parameters using real validation
    const validatedPsbt = validatePsbt(psbt);
    validateInputIndexes(inputIndexes);

    // Return mock signed PSBT
    return {
        psbt: `${validatedPsbt}_signed`,
    };
});
