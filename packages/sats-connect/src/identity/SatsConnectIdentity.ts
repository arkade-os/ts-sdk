import { base64, hex } from "@scure/base";
import { Identity, type SignerSession, type SignRequest, Transaction } from "@arkade-os/sdk";
import {
    AddressPurpose,
    BitcoinNetworkType,
    signMultipleTransactions,
    type InputToSign,
    type SignMultipleTransactionsResponse,
} from "sats-connect";
import type { SatsConnectRequest, SatsConnectNetwork } from "../types";

/** Maps SatsConnectNetwork config strings to BitcoinNetworkType enum values. */
function toBitcoinNetworkType(network?: SatsConnectNetwork): BitcoinNetworkType {
    switch (network) {
        case "Mainnet":
            return BitcoinNetworkType.Mainnet;
        case "Testnet":
            return BitcoinNetworkType.Testnet;
        case "Signet":
            return BitcoinNetworkType.Signet;
        case "Regtest":
            return BitcoinNetworkType.Regtest;
        default:
            return BitcoinNetworkType.Mainnet;
    }
}

/**
 * External wallet identity implementation using sats-connect signPsbt.
 * Delegates signing to the connected Sats Connect wallet.
 *
 * Supports batch signing via `signMultiple()` using the sats-connect
 * `signMultipleTransactions` API, reducing N+1 wallet popups to 1
 * during Arkade send transactions with checkpoints.
 */
export class SatsConnectIdentity implements Identity {
    private publicKey: Uint8Array;
    private address: string;
    private satsConnectRequest: SatsConnectRequest;
    private networkType: BitcoinNetworkType;

    constructor(
        publicKey: Uint8Array,
        address: string,
        satsConnectRequest: SatsConnectRequest,
        network?: SatsConnectNetwork,
    ) {
        if (publicKey.length !== 33 && publicKey.length !== 32) {
            throw new Error(
                `Invalid public key length: ${publicKey.length}. Expected 32 or 33 bytes.`,
            );
        }
        this.publicKey = publicKey;
        this.address = address;
        this.satsConnectRequest = satsConnectRequest;
        this.networkType = toBitcoinNetworkType(network);
    }

    async xOnlyPublicKey(): Promise<Uint8Array> {
        if (this.publicKey.length === 33) {
            return this.publicKey.slice(1);
        }
        if (this.publicKey.length === 32) {
            return this.publicKey;
        }
        throw new Error(
            `Invalid public key length: ${this.publicKey.length}. Expected 32 or 33 bytes.`,
        );
    }

    async compressedPublicKey(): Promise<Uint8Array> {
        if (this.publicKey.length !== 33) {
            throw new Error(
                `Compressed public key requires 33 bytes, got ${this.publicKey.length}.`,
            );
        }
        return this.publicKey;
    }

    signerSession(): SignerSession {
        return {
            async getPublicKey(): Promise<Uint8Array> {
                throw new Error("MuSig2 getPublicKey is not supported by Sats Connect wallets");
            },
            async init(): Promise<void> {
                throw new Error("MuSig2 init is not supported by Sats Connect wallets");
            },
            async getNonces(): Promise<any> {
                throw new Error("MuSig2 getNonces is not supported by Sats Connect wallets");
            },
            async aggregatedNonces(): Promise<{ hasAllNonces: boolean }> {
                throw new Error("MuSig2 aggregatedNonces is not supported by Sats Connect wallets");
            },
            async sign(): Promise<any> {
                throw new Error("MuSig2 sign is not supported by Sats Connect wallets");
            },
        };
    }

    async signMessage(
        _message: Uint8Array,
        signatureType: "schnorr" | "ecdsa" = "schnorr",
    ): Promise<Uint8Array> {
        throw new Error(
            `Message signing (${signatureType}) is not yet implemented for Sats Connect wallets. ` +
                "This feature requires implementing the signMessage method from Sats Connect.",
        );
    }

    getAddress(): string {
        return this.address;
    }

    async isConnected(): Promise<boolean> {
        try {
            const response = await this.satsConnectRequest("wallet_connect", {
                addresses: [AddressPurpose.Ordinals],
                message: "Checking connection status",
            });
            return response.status === "success";
        } catch (error) {
            return false;
        }
    }

    async reconnect(): Promise<boolean> {
        try {
            const response = await this.satsConnectRequest("wallet_connect", {
                addresses: [AddressPurpose.Payment, AddressPurpose.Ordinals],
                message: "Reconnecting to Arkade wallet",
            });

            if (response.status === "success") {
                const addresses = response.result.addresses;
                const matchingAddress = addresses.find(
                    (addr: any) => addr.address === this.address,
                );

                if (matchingAddress) {
                    return true;
                }
            }
            return false;
        } catch (error) {
            return false;
        }
    }

    async sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> {
        await this.ensureConnected();

        try {
            const psbt = tx.toPSBT();
            const psbtBase64 = base64.encode(psbt);

            const signInputs = this.buildSignInputs(tx, inputIndexes);
            const requestParams = {
                psbt: psbtBase64,
                signInputs,
                broadcast: false,
            };

            const response = await this.satsConnectRequest("signPsbt", requestParams);

            if (response.status === "success") {
                const signedPsbtBase64 = response.result?.psbt ?? (response as any).psbt;

                if (signedPsbtBase64) {
                    return this.mergeAndValidate(tx, base64.decode(signedPsbtBase64));
                }
                throw new Error("No signed PSBT returned from wallet");
            }

            const errorMsg = response.error?.message || "Unknown error";
            const errorCode = response.error?.code || "UNKNOWN";
            throw new Error(`Failed to sign transaction: ${errorCode} - ${errorMsg}`);
        } catch (error: any) {
            if (error?.message?.includes("network") || error?.message?.includes("fetch")) {
                throw new Error(
                    "Network error: Could not connect to wallet. Please check your wallet connection.",
                );
            }

            if (error instanceof Error) {
                throw new Error(`Sats Connect wallet signing failed: ${error.message}`);
            }
            throw error;
        }
    }

    /**
     * Sign multiple PSBTs in a single wallet popup using sats-connect's
     * signMultipleTransactions API. Returns signed Transactions in the
     * same order as the input requests.
     */
    async signMultiple(requests: SignRequest[]): Promise<Transaction[]> {
        await this.ensureConnected();

        const psbts = requests.map((req) => {
            const psbtBase64 = base64.encode(req.tx.toPSBT());
            const indexes = this.buildInputIndexArray(req.tx, req.inputIndexes);
            const inputsToSign: InputToSign[] = [
                {
                    address: this.address,
                    signingIndexes: indexes,
                },
            ];
            return { psbtBase64, inputsToSign };
        });

        const responses = await new Promise<SignMultipleTransactionsResponse>((resolve, reject) => {
            signMultipleTransactions({
                payload: {
                    network: { type: this.networkType },
                    message: "Sign Arkade transactions",
                    psbts,
                },
                onFinish: resolve,
                onCancel: () => reject(new Error("User cancelled batch signing")),
            });
        });

        return requests.map((req, i) => {
            const signedPsbtBase64 = responses[i].psbtBase64;
            const signedPsbtBytes = base64.decode(signedPsbtBase64);
            return this.mergeAndValidate(req.tx, signedPsbtBytes);
        });
    }

    private async ensureConnected(): Promise<void> {
        try {
            const response = await this.satsConnectRequest("wallet_connect", {
                addresses: [AddressPurpose.Ordinals],
                message: "Checking connection status",
            });
            if (response.status === "success") {
                return;
            }
            const reconnected = await this.reconnect();
            if (!reconnected) {
                throw new Error(response.error?.message || "Wallet not connected");
            }
        } catch (error) {
            throw new Error("Wallet not connected. Please reconnect your wallet and try again.");
        }
    }

    private buildSignInputs(tx: Transaction, inputIndexes?: number[]) {
        if (inputIndexes && inputIndexes.length > 0) {
            return { [this.address]: inputIndexes };
        }
        return {
            [this.address]: Array.from({ length: tx.inputsLength }, (_, i) => i),
        };
    }

    private buildInputIndexArray(tx: Transaction, inputIndexes?: number[]): number[] {
        if (inputIndexes && inputIndexes.length > 0) return inputIndexes;
        return Array.from({ length: tx.inputsLength }, (_, i) => i);
    }

    /**
     * Merge a wallet-signed PSBT back onto the original (preserving taproot
     * metadata) and validate that the unsigned transaction bytes weren't tampered with.
     */
    private mergeAndValidate(original: Transaction, signedPsbtBytes: Uint8Array): Transaction {
        const signedTx = Transaction.fromPSBT(signedPsbtBytes);
        const mergedTx = Transaction.fromPSBT(original.toPSBT());
        mergedTx.combine(signedTx);

        const unsignedBefore = original.unsignedTx;
        const unsignedAfter = mergedTx.unsignedTx;
        const unsignedMatches =
            unsignedBefore.length === unsignedAfter.length &&
            unsignedBefore.every((byte, index) => byte === unsignedAfter[index]);

        if (!unsignedMatches) {
            const prefixLen = 16;
            const suffixLen = 16;
            const mismatchDetails = {
                beforeLength: unsignedBefore.length,
                afterLength: unsignedAfter.length,
                beforePrefix: hex.encode(unsignedBefore.slice(0, prefixLen)),
                afterPrefix: hex.encode(unsignedAfter.slice(0, prefixLen)),
                beforeSuffix: hex.encode(unsignedBefore.slice(-suffixLen)),
                afterSuffix: hex.encode(unsignedAfter.slice(-suffixLen)),
                beforeVersion: original.version,
                afterVersion: mergedTx.version,
                beforeLockTime: original.lockTime,
                afterLockTime: mergedTx.lockTime,
            };
            throw new Error(
                `Signed transaction changed the unsigned payload: ${JSON.stringify(mismatchDetails)}`,
            );
        }

        return mergedTx;
    }
}
