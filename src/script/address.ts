import { bech32m } from "@scure/base";
import { Bytes } from "@scure/btc-signer/utils.js";
import { Script } from "@scure/btc-signer/script.js";

/**
 * ArkAddress allows creating and decoding bech32m-encoded Arkade addresses.
 *
 * An Arkade address is composed of:
 * - a human readable prefix (hrp)
 * - a version byte (1 byte)
 * - a server public key (32 bytes)
 * - a vtxo taproot public key (32 bytes)
 *
 * @remarks
 * This is an Arkade-specific address format.
 * It is distinct from the Taproot onchain address returned by `VtxoScript.onchainAddress`.
 *
 * @see VtxoScript
 *
 * @example
 * ```typescript
 * const address = new ArkAddress(
 *     new Uint8Array(32), // server public key
 *     new Uint8Array(32), // vtxo taproot public key
 *     "ark"
 * );
 *
 * const encoded = address.encode();
 * console.log("address: ", encoded);
 *
 * const decoded = ArkAddress.decode(encoded);
 * ```
 */
export class ArkAddress {
    /**
     * Create an Arkade address from its server key, vtxo taproot public key, and prefix.
     *
     * @param serverPubKey - 32-byte Arkade server public key
     * @param vtxoTaprootKey - 32-byte tweaked vtxo taproot public key
     * @param hrp - Bech32 human-readable prefix
     * @param version - Address version byte
     * @defaultValue `version = 0`
     * @throws Error if either public key is not 32 bytes long
     */
    constructor(
        readonly serverPubKey: Bytes,
        readonly vtxoTaprootKey: Bytes,
        readonly hrp: string,
        readonly version: number = 0
    ) {
        if (serverPubKey.length !== 32) {
            throw new Error(
                "Invalid server public key length, expected 32 bytes, got " +
                    serverPubKey.length
            );
        }
        if (vtxoTaprootKey.length !== 32) {
            throw new Error(
                "Invalid vtxo taproot public key length, expected 32 bytes, got " +
                    vtxoTaprootKey.length
            );
        }
    }

    /**
     * Decode an Arkade address from its bech32m string form.
     *
     * @param address - Bech32m-encoded Arkade address
     * @returns Decoded Arkade address
     * @throws Error if the address is malformed or has an invalid payload length
     * @see encode
     */
    static decode(address: string): ArkAddress {
        const decoded = bech32m.decodeUnsafe(address, 1023);
        if (!decoded) {
            throw new Error("Invalid address");
        }
        const data = new Uint8Array(bech32m.fromWords(decoded.words));

        // First the version byte, then 32 bytes server pubkey, then 32 bytes vtxo taproot public key.
        if (data.length !== 1 + 32 + 32) {
            throw new Error(
                "Invalid data length, expected 65 bytes, got " + data.length
            );
        }

        const version = data[0];
        const serverPubKey = data.slice(1, 33);
        const vtxoTaprootPubKey = data.slice(33, 65);

        return new ArkAddress(
            serverPubKey,
            vtxoTaprootPubKey,
            decoded.prefix,
            version
        );
    }

    /**
     * Encode the address to its bech32m string form.
     *
     * @returns Bech32m-encoded Arkade address
     * @see decode
     */
    encode(): string {
        // Combine version byte, server pubkey, and vtxo taproot public key.
        const data = new Uint8Array(1 + 32 + 32);
        data[0] = this.version;
        data.set(this.serverPubKey, 1);
        data.set(this.vtxoTaprootKey, 33);

        const words = bech32m.toWords(data);
        return bech32m.encode(this.hrp, words, 1023);
    }

    /** ScriptPubKey used to send non-dust funds to the address. */
    get pkScript(): Bytes {
        return Script.encode(["OP_1", this.vtxoTaprootKey]);
    }

    /** ScriptPubKey used to send sub-dust funds to the address. */
    get subdustPkScript(): Bytes {
        return Script.encode(["RETURN", this.vtxoTaprootKey]);
    }
}
