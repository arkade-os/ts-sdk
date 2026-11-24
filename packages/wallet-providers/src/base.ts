import { Identity, type SignerSession, Transaction } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";

/**
 * Base class for browser wallet provider identities.
 * Handles public key storage/normalization and provides stubs for
 * unsupported operations (MuSig2, message signing).
 */
export abstract class BrowserWalletIdentity implements Identity {
    protected readonly pubkey: Uint8Array;
    protected readonly address: string;

    constructor(publicKey: Uint8Array, address: string) {
        if (publicKey.length !== 33 && publicKey.length !== 32) {
            throw new Error(
                `Invalid public key length: ${publicKey.length}. Expected 32 or 33 bytes.`,
            );
        }
        this.pubkey = publicKey;
        this.address = address;
    }

    async xOnlyPublicKey(): Promise<Uint8Array> {
        return this.pubkey.length === 33 ? this.pubkey.slice(1) : this.pubkey;
    }

    async compressedPublicKey(): Promise<Uint8Array> {
        if (this.pubkey.length !== 33) {
            throw new Error(`Compressed public key requires 33 bytes, got ${this.pubkey.length}.`);
        }
        return this.pubkey;
    }

    signerSession(): SignerSession {
        const name = this.constructor.name;
        return {
            async getPublicKey(): Promise<Uint8Array> {
                throw new Error(`MuSig2 getPublicKey is not supported by ${name}`);
            },
            async init(): Promise<void> {
                throw new Error(`MuSig2 init is not supported by ${name}`);
            },
            async getNonces(): Promise<any> {
                throw new Error(`MuSig2 getNonces is not supported by ${name}`);
            },
            async aggregatedNonces(): Promise<{ hasAllNonces: boolean }> {
                throw new Error(`MuSig2 aggregatedNonces is not supported by ${name}`);
            },
            async sign(): Promise<any> {
                throw new Error(`MuSig2 sign is not supported by ${name}`);
            },
        };
    }

    async signMessage(
        _message: Uint8Array,
        signatureType: "schnorr" | "ecdsa" = "schnorr",
    ): Promise<Uint8Array> {
        throw new Error(
            `Message signing (${signatureType}) is not yet implemented for ${this.constructor.name}.`,
        );
    }

    abstract sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction>;

    getAddress(): string {
        return this.address;
    }

    /** Convert a Transaction to a hex-encoded PSBT string. */
    protected psbtToHex(tx: Transaction): string {
        return hex.encode(tx.toPSBT());
    }

    /** Convert a Transaction to a base64-encoded PSBT string. */
    protected psbtToBase64(tx: Transaction): string {
        return base64.encode(tx.toPSBT());
    }

    /**
     * Merge a wallet-signed PSBT back onto the original, preserving
     * taproot metadata that some wallets strip.
     * Validates that the unsigned transaction bytes were not tampered with.
     */
    protected mergeSignedPsbt(original: Transaction, signedPsbtBytes: Uint8Array): Transaction {
        const signedTx = Transaction.fromPSBT(signedPsbtBytes);
        const mergedTx = Transaction.fromPSBT(original.toPSBT());
        mergedTx.combine(signedTx);

        const unsignedBefore = original.unsignedTx;
        const unsignedAfter = mergedTx.unsignedTx;
        if (
            unsignedBefore.length !== unsignedAfter.length ||
            !unsignedBefore.every((byte, i) => byte === unsignedAfter[i])
        ) {
            throw new Error("Signed transaction changed the unsigned payload — possible tampering");
        }

        return mergedTx;
    }

    /** Build input index array — specific indexes or all inputs. */
    protected allInputIndexes(tx: Transaction, inputIndexes?: number[]): number[] {
        if (inputIndexes && inputIndexes.length > 0) return inputIndexes;
        return Array.from({ length: tx.inputsLength }, (_, i) => i);
    }
}
