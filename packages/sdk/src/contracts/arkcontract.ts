import { hex } from "@scure/base";
import { Contract } from "./types";
import { contractHandlers } from "./handlers";
import { DEFAULT_NETWORK } from "../networks";

const ARKCONTRACT_PREFIX = "arkcontract";

/**
 * Encode a contract to the arkcontract string format:
 * `arkcontract={type}&{key1}={value1}&...`. NArk-compatible, so contracts can be shared
 * across Arkade SDKs.
 *
 * @example
 * ```typescript
 * const contract: Contract = {
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
    const params = new URLSearchParams();

    // First, so the string starts with `arkcontract=` (what `isArkContract` tests).
    params.set(ARKCONTRACT_PREFIX, contract.type);

    for (const [key, value] of Object.entries(contract.params)) {
        params.set(key, value);
    }

    return params.toString();
}

/**
 * Raw (unvalidated) result of decoding an arkcontract string. For typed contracts use
 * `contractFromArkContract` / `contractFromArkContractWithAddress`, which validate via handlers.
 */
export interface ParsedArkContract {
    /** Contract type (e.g., "vhtlc", "default") */
    type: string;

    /** All other key-value pairs from the string */
    data: Record<string, string>;
}

/**
 * Decode an arkcontract string into raw type and data (low-level; see {@link ParsedArkContract}).
 *
 * @throws If the string is not a valid arkcontract
 *
 * @example
 * ```typescript
 * const parsed = decodeArkContract("arkcontract=vhtlc&sender=ab12...");
 * // { type: "vhtlc", data: { sender: "ab12...", ... } }
 * ```
 */
export function decodeArkContract(encoded: string): ParsedArkContract {
    const params = new URLSearchParams(encoded);

    const type = params.get(ARKCONTRACT_PREFIX);
    if (!type) {
        throw new Error(`Invalid arkcontract string: missing '${ARKCONTRACT_PREFIX}' key`);
    }

    const data: Record<string, string> = {};
    for (const [key, value] of params.entries()) {
        if (key !== ARKCONTRACT_PREFIX) {
            data[key] = value;
        }
    }

    return { type, data };
}

/**
 * Create a Contract (without script/address) from an arkcontract string.
 *
 * @throws If the string is invalid or no handler is registered for the type
 *
 * @example
 * ```typescript
 * const contract = contractFromArkContract(
 *   "arkcontract=vhtlc&sender=ab12...",
 *   {
 *     label: "Lightning Receive",
 *   }
 * );
 * ```
 */
export function contractFromArkContract(
    encoded: string,
    options: {
        label?: string;
        state?: "active" | "inactive";
        metadata?: Record<string, unknown>;
    } = {},
): Omit<Contract, "script" | "address"> & {
    script?: string;
    address?: string;
} {
    const parsed = decodeArkContract(encoded);
    const handler = contractHandlers.get(parsed.type);

    if (!handler) {
        throw new Error(`No handler registered for contract type '${parsed.type}'`);
    }

    // All data is treated as params; splitting out type-specific runtime keys isn't done yet.
    const params = parsed.data;

    return {
        label: options.label,
        type: parsed.type,
        params,
        state: options.state || "active",
        createdAt: Date.now(),
        metadata: options.metadata,
    };
}

/**
 * Create a full Contract with derived script and address.
 *
 * @param serverPubKey - Server public key (for address derivation)
 * @param addressPrefix - Address prefix (e.g., "tark" for testnet)
 */
export function contractFromArkContractWithAddress(
    encoded: string,
    serverPubKey: Uint8Array,
    addressPrefix: string = DEFAULT_NETWORK.hrp,
    options: {
        label?: string;
        state?: "active" | "inactive";
        metadata?: Record<string, unknown>;
    } = {},
): Contract {
    const parsed = decodeArkContract(encoded);
    const handler = contractHandlers.getOrThrow(parsed.type);

    const params = parsed.data;
    const vtxoScript = handler.createScript(params);

    return {
        label: options.label,
        type: parsed.type,
        params,
        script: hex.encode(vtxoScript.pkScript),
        address: vtxoScript.address(addressPrefix, serverPubKey).encode(),
        state: options.state || "active",
        createdAt: Date.now(),
        metadata: options.metadata,
    };
}

/** Check if a string is an arkcontract. */
export function isArkContract(str: string): boolean {
    return str.startsWith(ARKCONTRACT_PREFIX + "=");
}
