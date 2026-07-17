import { bech32m } from "@scure/base";
import { pubSchnorr, randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import { SingleKey } from "../identity/singleKey";
import { DefaultVtxo } from "../script/default";
import { ArkAddress } from "../script/address";
import { RelativeTimelock } from "../script/tapscript";
import { sequenceToTimelock, timelockToSequence } from "../utils/timelock";

/**
 * ArkCash is a bearer instrument for the Ark protocol.
 * It encodes a private key and contract parameters as a bech32m string,
 * enabling wallet-to-wallet transfers without address exchange.
 *
 * Format: arkcash1... (bech32m encoded)
 * Payload: version (1 byte) + private key (32 bytes) + server pubkey (32 bytes) + csv timelock sequence (4 bytes)
 */
export class ArkCash {
    static readonly DefaultHRP = "arkcash";
    static readonly Version = 0;
    static readonly PayloadLength = 1 + 32 + 32 + 4; // 69 bytes

    // Keys are held as private copies so a caller mutating the array it passed
    // in — or one it reads back from a getter — cannot alter this note's
    // identity or the outputs derived from it.
    private readonly _privateKey: Uint8Array;
    private readonly _serverPubKey: Uint8Array;
    private readonly _publicKey: Uint8Array;

    constructor(
        privateKey: Uint8Array,
        serverPubKey: Uint8Array,
        readonly csvTimelock: RelativeTimelock,
        readonly hrp: string = ArkCash.DefaultHRP,
    ) {
        if (privateKey.length !== 32) {
            throw new Error(
                `Invalid private key length: expected 32 bytes, got ${privateKey.length}`,
            );
        }
        if (serverPubKey.length !== 32) {
            throw new Error(
                `Invalid server public key length: expected 32 bytes, got ${serverPubKey.length}`,
            );
        }
        this._privateKey = privateKey.slice();
        this._serverPubKey = serverPubKey.slice();
        this._publicKey = pubSchnorr(this._privateKey);
    }

    /** The note's private key. Returns a fresh copy; mutating it is a no-op. */
    get privateKey(): Uint8Array {
        return this._privateKey.slice();
    }

    /** The server's public key. Returns a fresh copy; mutating it is a no-op. */
    get serverPubKey(): Uint8Array {
        return this._serverPubKey.slice();
    }

    /** The note's public key. Returns a fresh copy; mutating it is a no-op. */
    get publicKey(): Uint8Array {
        return this._publicKey.slice();
    }

    static generate(
        serverPubKey: Uint8Array,
        csvTimelock: RelativeTimelock,
        hrp?: string,
    ): ArkCash {
        return new ArkCash(randomPrivateKeyBytes(), serverPubKey, csvTimelock, hrp);
    }

    static fromString(encoded: string): ArkCash {
        const decoded = bech32m.decodeUnsafe(encoded.trim().toLowerCase(), 1023);
        if (!decoded) {
            throw new Error("Invalid arkcash string: failed to decode bech32m");
        }

        const data = new Uint8Array(bech32m.fromWords(decoded.words));
        if (data.length !== ArkCash.PayloadLength) {
            throw new Error(
                `Invalid arkcash data length: expected ${ArkCash.PayloadLength} bytes, got ${data.length}`,
            );
        }

        const version = data[0];
        if (version !== ArkCash.Version) {
            throw new Error(`Unsupported arkcash version: ${version}`);
        }

        const privateKey = data.slice(1, 33);
        const serverPubKey = data.slice(33, 65);
        const sequence = new DataView(data.buffer, data.byteOffset + 65, 4).getUint32(0, false);
        const csvTimelock = sequenceToTimelock(sequence);

        return new ArkCash(privateKey, serverPubKey, csvTimelock, decoded.prefix);
    }

    toString(): string {
        const data = new Uint8Array(ArkCash.PayloadLength);
        data[0] = ArkCash.Version;
        data.set(this._privateKey, 1);
        data.set(this._serverPubKey, 33);
        const sequence = timelockToSequence(this.csvTimelock);
        new DataView(data.buffer, data.byteOffset + 65, 4).setUint32(0, sequence, false);
        const words = bech32m.toWords(data);
        return bech32m.encode(this.hrp, words, 1023);
    }

    get identity(): SingleKey {
        return SingleKey.fromPrivateKey(this._privateKey);
    }

    get vtxoScript(): DefaultVtxo.Script {
        return new DefaultVtxo.Script({
            pubKey: this._publicKey,
            serverPubKey: this._serverPubKey,
            csvTimelock: this.csvTimelock,
        });
    }

    address(addressHrp: string): ArkAddress {
        return this.vtxoScript.address(addressHrp, this._serverPubKey);
    }
}
