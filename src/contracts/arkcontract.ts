import { hex } from "@scure/base";
import { Contract } from "./types";
import { contractHandlers } from "./handlers";

/**
 * Prefix for arkcontract strings.
 */
const ARKCONTRACT_PREFIX = "arkcontract";

/**
 * Encode a contract to the arkcontract string format.
 *
 * Format: arkcontract={type}&{key1}={value1}&{key2}={value2}...
 *
 * This format is compatible with NArk and allows contracts to be
 * shared/imported across different Ark implementations.
 *
 * @example
 * ```typescript
 * const contract: Contract = {
 *   id: "abc123",
 *   type: "vhtlc",
 *   params: { sender: "ab12...", receiver: "cd34...", ... },
 *   // ...
 * };
 *
 * const encoded = encodeArkContract(contract);
 * // "arkcontract=vhtlc&sender=ab12...&receiver=cd34...&..."
 * ```
 */
export function encodeArkContract(contract: Contract): string {
    const parts: string[] = [`${ARKCONTRACT_PREFIX}=${contract.type}`];

    // Add all params
    for (const [key, value] of Object.entries(contract.params)) {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }

    // Add runtime data if present
    if (contract.data) {
        for (const [key, value] of Object.entries(contract.data)) {
            parts.push(
                `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
            );
        }
    }

    return parts.join("&");
}

/**
 * Parsed result from decoding an arkcontract string.
 */
export interface ParsedArkContract {
    /** Contract type */
    type: string;

    /** All key-value pairs from the string */
    data: Record<string, string>;
}

/**
 * Decode an arkcontract string.
 *
 * @param encoded - The arkcontract string
 * @returns Parsed contract data
 * @throws If the string is not a valid arkcontract
 *
 * @example
 * ```typescript
 * const parsed = decodeArkContract("arkcontract=vhtlc&sender=ab12...");
 * // { type: "vhtlc", data: { sender: "ab12...", ... } }
 * ```
 */
export function decodeArkContract(encoded: string): ParsedArkContract {
    if (!encoded.startsWith(ARKCONTRACT_PREFIX)) {
        throw new Error(
            `Invalid arkcontract string: must start with '${ARKCONTRACT_PREFIX}'`
        );
    }

    const data: Record<string, string> = {};
    const parts = encoded.split("&");

    for (const part of parts) {
        const eqIndex = part.indexOf("=");
        if (eqIndex === -1) {
            throw new Error(
                `Invalid arkcontract string: malformed part '${part}'`
            );
        }

        const key = decodeURIComponent(part.substring(0, eqIndex));
        const value = decodeURIComponent(part.substring(eqIndex + 1));
        data[key] = value;
    }

    // Extract type from the arkcontract key
    const type = data[ARKCONTRACT_PREFIX];
    if (!type) {
        throw new Error("Invalid arkcontract string: missing contract type");
    }

    // Remove the arkcontract key from data
    delete data[ARKCONTRACT_PREFIX];

    return { type, data };
}

/**
 * Create a Contract from an arkcontract string.
 *
 * This requires a handler to be registered for the contract type.
 *
 * @param encoded - The arkcontract string
 * @param options - Additional options for the contract
 * @returns A Contract object
 * @throws If the string is invalid or no handler exists for the type
 *
 * @example
 * ```typescript
 * const contract = contractFromArkContract(
 *   "arkcontract=vhtlc&sender=ab12...",
 *   {
 *     id: "my-swap",
 *     label: "Lightning Receive",
 *     autoSweep: true,
 *   }
 * );
 * ```
 */
export function contractFromArkContract(
    encoded: string,
    options: {
        id?: string;
        label?: string;
        state?: "active" | "inactive";
        autoSweep?: boolean;
        sweepDestination?: string;
        expiresAt?: number;
        metadata?: Record<string, unknown>;
    } = {}
): Omit<Contract, "script" | "address"> & {
    script?: string;
    address?: string;
} {
    const parsed = decodeArkContract(encoded);
    const handler = contractHandlers.get(parsed.type);

    if (!handler) {
        throw new Error(
            `No handler registered for contract type '${parsed.type}'`
        );
    }

    // Separate params from runtime data
    // This is type-specific - the handler knows which keys are params
    // For now, we treat all data as params
    const params = parsed.data;

    return {
        id: options.id || generateContractId(),
        label: options.label,
        type: parsed.type,
        params,
        state: options.state || "active",
        createdAt: Date.now(),
        expiresAt: options.expiresAt,
        autoSweep: options.autoSweep,
        sweepDestination: options.sweepDestination,
        metadata: options.metadata,
    };
}

/**
 * Create a full Contract with derived script and address.
 *
 * @param encoded - The arkcontract string
 * @param serverPubKey - Server public key (for address derivation)
 * @param addressPrefix - Address prefix (e.g., "tark" for testnet)
 * @param options - Additional options
 * @returns A complete Contract object
 */
export function contractFromArkContractWithAddress(
    encoded: string,
    serverPubKey: Uint8Array,
    addressPrefix: string,
    options: {
        id?: string;
        label?: string;
        state?: "active" | "inactive";
        autoSweep?: boolean;
        sweepDestination?: string;
        expiresAt?: number;
        metadata?: Record<string, unknown>;
    } = {}
): Contract {
    const parsed = decodeArkContract(encoded);
    const handler = contractHandlers.getOrThrow(parsed.type);

    const params = parsed.data;
    const vtxoScript = handler.createScript(params);

    return {
        id: options.id || generateContractId(),
        label: options.label,
        type: parsed.type,
        params,
        script: hex.encode(vtxoScript.pkScript),
        address: vtxoScript.address(addressPrefix, serverPubKey).encode(),
        state: options.state || "active",
        createdAt: Date.now(),
        expiresAt: options.expiresAt,
        autoSweep: options.autoSweep,
        sweepDestination: options.sweepDestination,
        metadata: options.metadata,
    };
}

/**
 * Generate a unique contract ID.
 */
function generateContractId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `contract_${timestamp}_${random}`;
}

/**
 * Check if a string is an arkcontract.
 */
export function isArkContract(str: string): boolean {
    return str.startsWith(ARKCONTRACT_PREFIX + "=");
}
