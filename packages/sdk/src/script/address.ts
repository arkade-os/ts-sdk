import { bech32m } from "@scure/base";
import { Bytes } from "@scure/btc-signer/utils.js";
import { Script } from "@scure/btc-signer/script.js";
import { DEFAULT_NETWORK } from "../networks";

/**
 * ArkAddress allows creating and decoding bech32m-encoded Arkade addresses: an hrp plus a
 * 65-byte payload of version byte ‖ 32-byte server pubkey ‖ 32-byte VTXO taproot key.
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
     * Create an Arkade address from its server public key, Taproot output key, and prefix.
     *
     * @param serverPubKey - 32-byte Arkade server public key
     * @param vtxoTaprootKey - 32-byte Taproot output key (a.k.a. tweaked public key)
     * @param hrp - Bech32 human-readable prefix
     * @param version - Address version byte
     * @defaultValue `version = 0`
     * @throws Error if either public key is not 32 bytes long
     */
    constructor(
        readonly serverPubKey: Bytes,
        readonly vtxoTaprootKey: Bytes,
        readonly hrp: string = DEFAULT_NETWORK.hrp,
        readonly version: number = 0,
    ) {
        if (serverPubKey.length !== 32) {
            throw new Error(
                "Invalid server public key length, expected 32 bytes, got " + serverPubKey.length,
            );
        }
        if (vtxoTaprootKey.length !== 32) {
            throw new Error(
                "Invalid vtxo taproot public key length, expected 32 bytes, got " +
                    vtxoTaprootKey.length,
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

        if (data.length !== 1 + 32 + 32) {
            throw new Error("Invalid data length, expected 65 bytes, got " + data.length);
        }

        const version = data[0];
        const serverPubKey = data.slice(1, 33);
        const vtxoTaprootPubKey = data.slice(33, 65);

        return new ArkAddress(serverPubKey, vtxoTaprootPubKey, decoded.prefix, version);
    }

    /**
     * Encode the address to its bech32m string form.
     *
     * @returns Bech32m-encoded Arkade address
     * @see decode
     */
    encode(): string {
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
