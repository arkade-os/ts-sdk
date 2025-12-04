import {
    pubECDSA,
    pubSchnorr,
    randomPrivateKeyBytes,
} from "@scure/btc-signer/utils.js";
import { SigHash } from "@scure/btc-signer";
import { hex } from "@scure/base";
import { Identity, ReadonlyIdentity } from ".";
import { Transaction } from "../utils/transaction";
import { SignerSession, TreeSignerSession } from "../tree/signingSession";
import { schnorr, signAsync } from "@noble/secp256k1";

const ALL_SIGHASH = Object.values(SigHash).filter((x) => typeof x === "number");

/**
 * In-memory single key implementation for Bitcoin transaction signing.
 *
 * @example
 * ```typescript
 * // Create from hex string
 * const key = SingleKey.fromHex('your_private_key_hex');
 *
 * // Create from raw bytes
 * const key = SingleKey.fromPrivateKey(privateKeyBytes);
 *
 * // Create random key
 * const randomKey = SingleKey.fromRandomBytes();
 *
 * // Sign a transaction
 * const signedTx = await key.sign(transaction);
 * ```
 */
export class SingleKey implements Identity {
    private key: Uint8Array;

    private constructor(key: Uint8Array | undefined) {
        this.key = key || randomPrivateKeyBytes();
    }

    static fromPrivateKey(privateKey: Uint8Array): SingleKey {
        return new SingleKey(privateKey);
    }

    static fromHex(privateKeyHex: string): SingleKey {
        return new SingleKey(hex.decode(privateKeyHex));
    }

    static fromRandomBytes(): SingleKey {
        return new SingleKey(randomPrivateKeyBytes());
    }

    /**
     * Export the private key as a hex string.
     *
     * @returns The private key as a hex string
     */
    toHex(): string {
        return hex.encode(this.key);
    }

    async sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> {
        const txCpy = tx.clone();

        if (!inputIndexes) {
            try {
                if (!txCpy.sign(this.key, ALL_SIGHASH)) {
                    throw new Error("Failed to sign transaction");
                }
            } catch (e) {
                if (
                    e instanceof Error &&
                    e.message.includes("No inputs signed")
                ) {
                    // ignore
                } else {
                    throw e;
                }
            }
            return txCpy;
        }

        for (const inputIndex of inputIndexes) {
            if (!txCpy.signIdx(this.key, inputIndex, ALL_SIGHASH)) {
                throw new Error(`Failed to sign input #${inputIndex}`);
            }
        }

        return txCpy;
    }

    compressedPublicKey(): Promise<Uint8Array> {
        return Promise.resolve(pubECDSA(this.key, true));
    }

    xOnlyPublicKey(): Promise<Uint8Array> {
        return Promise.resolve(pubSchnorr(this.key));
    }

    signerSession(): SignerSession {
        return TreeSignerSession.random();
    }

    async signMessage(
        message: Uint8Array,
        signatureType: "schnorr" | "ecdsa" = "schnorr"
    ): Promise<Uint8Array> {
        if (signatureType === "ecdsa")
            return signAsync(message, this.key, { prehash: false });
        return schnorr.signAsync(message, this.key);
    }

    async toReadonly(): Promise<ReadonlySingleKey> {
        return new ReadonlySingleKey(await this.compressedPublicKey());
    }
}

export class ReadonlySingleKey implements ReadonlyIdentity {
    constructor(private readonly publicKey: Uint8Array) {
        if (publicKey.length !== 33) {
            throw new Error("Invalid public key length");
        }
    }

    /**
     * Create a ReadonlySingleKey from a compressed public key.
     *
     * @param publicKey - 33-byte compressed public key (02/03 prefix + 32-byte x coordinate)
     * @returns A new ReadonlySingleKey instance
     * @example
     * ```typescript
     * const pubkey = new Uint8Array(33); // your compressed public key
     * const readonlyKey = ReadonlySingleKey.fromPublicKey(pubkey);
     * ```
     */
    static fromPublicKey(publicKey: Uint8Array): ReadonlySingleKey {
        return new ReadonlySingleKey(publicKey);
    }

    xOnlyPublicKey(): Promise<Uint8Array> {
        return Promise.resolve(this.publicKey.slice(1));
    }
    compressedPublicKey(): Promise<Uint8Array> {
        return Promise.resolve(this.publicKey);
    }
}
