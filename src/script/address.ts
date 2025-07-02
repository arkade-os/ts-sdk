import { bech32m } from "@scure/base";
import { Bytes } from "@scure/btc-signer/utils";
import { Script } from "@scure/btc-signer";

// ArkAddress is a bech32m encoded address with a custom HRP (ark/tark)
export class ArkAddress {
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

    static decode(address: string): ArkAddress {
        const decoded = bech32m.decodeUnsafe(address, 1023);
        if (!decoded) {
            throw new Error("Invalid address");
        }
        const data = new Uint8Array(bech32m.fromWords(decoded.words));

        // First the version byte, then 32 bytes server pubkey, then 32 bytes vtxo taproot pubkey
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

    encode(): string {
        // Combine version byte, server pubkey, and vtxo taproot pubkey
        const data = new Uint8Array(1 + 32 + 32);
        data[0] = this.version;
        data.set(this.serverPubKey, 1);
        data.set(this.vtxoTaprootKey, 33);

        const words = bech32m.toWords(data);
        return bech32m.encode(this.hrp, words, 1023);
    }

    // pkScript is the script that should be used to send non-dust funds to the address
    get pkScript(): Bytes {
        return Script.encode(["OP_1", this.vtxoTaprootKey]);
    }

    // subdustPkScript is the script that should be used to send sub-dust funds to the address
    get subdustPkScript(): Bytes {
        return Script.encode(["RETURN", this.vtxoTaprootKey]);
    }
}
