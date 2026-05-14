import { bech32m } from "@scure/base";
import { pubSchnorr, randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import { SingleKey } from "../identity/singleKey";
import { DefaultVtxo } from "../script/default";
import { ArkAddress } from "../script/address";
import { RelativeTimelock } from "../script/tapscript";
import {
    sequenceToTimelock,
    timelockToSequence,
} from "../contracts/handlers/helpers";

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

    readonly publicKey: Uint8Array;

    constructor(
        readonly privateKey: Uint8Array,
        readonly serverPubKey: Uint8Array,
        readonly csvTimelock: RelativeTimelock,
        readonly hrp: string = ArkCash.DefaultHRP
    ) {
        if (privateKey.length !== 32) {
            throw new Error(
                `Invalid private key length: expected 32 bytes, got ${privateKey.length}`
            );
        }
        if (serverPubKey.length !== 32) {
            throw new Error(
                `Invalid server public key length: expected 32 bytes, got ${serverPubKey.length}`
            );
        }
        this.publicKey = pubSchnorr(privateKey);
    }

    static generate(
        serverPubKey: Uint8Array,
        csvTimelock: RelativeTimelock,
        hrp?: string
    ): ArkCash {
        return new ArkCash(
            randomPrivateKeyBytes(),
            serverPubKey,
            csvTimelock,
            hrp
        );
    }

    static fromString(encoded: string): ArkCash {
        const decoded = bech32m.decodeUnsafe(
            encoded.trim().toLowerCase(),
            1023
        );
        if (!decoded) {
            throw new Error("Invalid arkcash string: failed to decode bech32m");
        }

        const data = new Uint8Array(bech32m.fromWords(decoded.words));
        if (data.length !== ArkCash.PayloadLength) {
            throw new Error(
                `Invalid arkcash data length: expected ${ArkCash.PayloadLength} bytes, got ${data.length}`
            );
        }

        const version = data[0];
        if (version !== ArkCash.Version) {
            throw new Error(`Unsupported arkcash version: ${version}`);
        }

        const privateKey = data.slice(1, 33);
        const serverPubKey = data.slice(33, 65);
        const sequence = new DataView(
            data.buffer,
            data.byteOffset + 65,
            4
        ).getUint32(0, false);
        const csvTimelock = sequenceToTimelock(sequence);

        return new ArkCash(
            privateKey,
            serverPubKey,
            csvTimelock,
            decoded.prefix
        );
    }

    toString(): string {
        const data = new Uint8Array(ArkCash.PayloadLength);
        data[0] = ArkCash.Version;
        data.set(this.privateKey, 1);
        data.set(this.serverPubKey, 33);
        const sequence = timelockToSequence(this.csvTimelock);
        new DataView(data.buffer, data.byteOffset + 65, 4).setUint32(
            0,
            sequence,
            false
        );
        const words = bech32m.toWords(data);
        return bech32m.encode(this.hrp, words, 1023);
    }

    get identity(): SingleKey {
        return SingleKey.fromPrivateKey(this.privateKey);
    }

    get vtxoScript(): DefaultVtxo.Script {
        return new DefaultVtxo.Script({
            pubKey: this.publicKey,
            serverPubKey: this.serverPubKey,
            csvTimelock: this.csvTimelock,
        });
    }

    address(addressHrp: string): ArkAddress {
        return this.vtxoScript.address(addressHrp, this.serverPubKey);
    }
}
