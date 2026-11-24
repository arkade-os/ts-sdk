import type { NetworkName } from "@arkade-os/sdk";

/**
 * Validation utilities
 */
const VALID_NETWORKS: NetworkName[] = ["bitcoin", "testnet", "signet", "mutinynet", "regtest"];

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Check if a value is a valid network name.
 * @param network - The value to check.
 * @returns True if the value is a valid NetworkName.
 */
function isValidNetwork(network: unknown): network is NetworkName {
    return typeof network === "string" && VALID_NETWORKS.includes(network as NetworkName);
}

/**
 * Validate and return a network name.
 * @param network - The network value to validate.
 * @returns The validated NetworkName.
 * @throws If the network is invalid.
 */
function validateNetwork(network: unknown): NetworkName {
    if (typeof network !== "string") {
        throw new Error(`Invalid network type: expected string, got ${typeof network}`);
    }
    if (!isValidNetwork(network)) {
        throw new Error(
            `Invalid network: ${network}. Must be one of: ${VALID_NETWORKS.join(", ")}`,
        );
    }
    return network;
}

/**
 * Validate an operator URL and return it without a trailing slash.
 * @param operatorUrl - The operator URL to validate.
 * @returns The normalized URL.
 * @throws If it is not a URL, or not https outside loopback.
 */
function validateOperatorUrl(operatorUrl: unknown): string {
    if (typeof operatorUrl !== "string") {
        throw new Error(`Invalid operatorUrl type: expected string, got ${typeof operatorUrl}`);
    }
    let url: URL;
    try {
        url = new URL(operatorUrl);
    } catch {
        throw new Error(`Invalid operatorUrl: ${operatorUrl}`);
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
        throw new Error("operatorUrl must use https (plain http only on loopback)");
    }
    return url.href.replace(/\/+$/u, "");
}

/**
 * Validate and return a PSBT string.
 * @param psbt - The PSBT to validate.
 * @returns The validated base64-encoded PSBT string.
 * @throws If the PSBT is invalid.
 */
function validatePsbt(psbt: unknown): string {
    if (typeof psbt !== "string") {
        throw new Error(`Invalid psbt type: expected string, got ${typeof psbt}`);
    }
    if (psbt.length === 0) {
        throw new Error("PSBT cannot be empty");
    }
    // Validate base64 format
    if (!/^[A-Za-z0-9+/=]+$/u.test(psbt)) {
        throw new Error("Invalid PSBT: must be a valid base64 string");
    }
    return psbt;
}

/**
 * Validate and return input indexes array.
 * @param inputIndexes - The input indexes to validate.
 * @returns The validated array of input indexes.
 * @throws If the input indexes are invalid.
 */
function validateInputIndexes(inputIndexes: unknown): number[] {
    if (!Array.isArray(inputIndexes)) {
        throw new Error(`Invalid inputIndexes type: expected array, got ${typeof inputIndexes}`);
    }
    if (inputIndexes.length === 0) {
        throw new Error("inputIndexes cannot be empty");
    }
    for (let i = 0; i < inputIndexes.length; i++) {
        const idx = inputIndexes[i];
        if (typeof idx !== "number") {
            throw new Error(`Invalid inputIndexes[${i}]: expected number, got ${typeof idx}`);
        }
        if (!Number.isInteger(idx)) {
            throw new Error(`Invalid inputIndexes[${i}]: must be an integer, got ${idx}`);
        }
        if (idx < 0) {
            throw new Error(`Invalid inputIndexes[${i}]: must be non-negative, got ${idx}`);
        }
    }
    return inputIndexes;
}

export { validateInputIndexes, validateNetwork, validateOperatorUrl, validatePsbt, isValidNetwork };
