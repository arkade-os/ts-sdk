import { base64, hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { SatsConnectDebugger } from "./SatsConnectDebugger.js";

/**
 * External wallet identity implementation using sats-connect signPsbt.
 * This allows signing transactions through browser extension wallets like Xverse.
 *
 * This implementation fixes the previous issue where the public key was being
 * incorrectly used as a private key with SingleKey. Instead, this class:
 *
 * 1. Stores only the public key and address
 * 2. Uses sats-connect's signPsbt method for actual signing
 * 3. Delegates all cryptographic operations to the external wallet
 * 4. Provides a secure integration with browser extension wallets
 *
 * @example
 * ```javascript
 * import { request } from 'sats-connect';
 *
 * // Create identity with user's public key and address
 * const identity = new SatsConnectIdentity(
 *     userPublicKey,
 *     userAddress,
 *     request
 * );
 *
 * // Sign a transaction - this will prompt the user in their wallet
 * const signedTx = await identity.sign(transaction);
 * ```
 */
export class SatsConnectIdentity {
    constructor(publicKey, address, satsConnectRequest) {
        this.publicKey = publicKey;
        this.address = address;
        this.satsConnectRequest = satsConnectRequest;
    }

    async sign(tx, inputIndexes = null) {
        console.log("SatsConnectIdentity.sign called with:", {
            inputIndexes,
            txInputsLength: tx.inputsLength,
            address: this.address,
        });

        // First, test if wallet is still connected
        console.log("Testing wallet connection...");
        try {
            const connectionTest = await SatsConnectDebugger.testConnection(
                this.satsConnectRequest
            );
            if (!connectionTest.success) {
                console.log(
                    "Initial connection test failed, attempting reconnection..."
                );
                const reconnected = await this.reconnect();
                if (!reconnected) {
                    throw new Error(
                        `Wallet not connected: ${connectionTest.error}`
                    );
                }
            }
            console.log("Wallet connection verified");
        } catch (error) {
            console.error("Wallet connection test failed:", error);
            throw new Error(
                "Wallet not connected. Please reconnect your wallet and try again."
            );
        }

        // Log transaction details for debugging
        SatsConnectDebugger.logTransaction(tx);

        try {
            // Convert transaction to PSBT
            const psbt = tx.toPSBT();
            const psbtBase64 = base64.encode(psbt);

            console.log("PSBT generated:", {
                psbtLength: psbtBase64.length,
                psbtPreview: psbtBase64.substring(0, 100) + "...",
            });

            // Determine which inputs to sign
            let signInputs;

            if (inputIndexes) {
                // Sign only specified inputs
                signInputs = {
                    [this.address]: inputIndexes,
                };
            } else {
                // Try to sign all inputs - get all input indexes
                const allIndexes = Array.from(
                    { length: tx.inputsLength },
                    (_, i) => i
                );
                signInputs = {
                    [this.address]: allIndexes,
                };
            }

            console.log("Sign inputs configuration:", signInputs);

            // Try the signPsbt method - based on sats-connect documentation
            const requestParams = {
                psbt: psbtBase64,
                signInputs,
                broadcast: false,
            };

            console.log("Making signPsbt request with params:", requestParams);

            // Request signature from wallet using the documented API
            const response = await this.satsConnectRequest(
                "signPsbt",
                requestParams
            );

            console.log("Wallet response:", {
                status: response.status,
                hasError: !!response.error,
                errorCode: response.error?.code,
                errorMessage: response.error?.message,
                hasPsbt: !!(response.psbt || response.result?.psbt),
                fullResponse: response,
            });

            if (response.status === "success") {
                // Handle both possible response structures
                const signedPsbtBase64 = response.psbt || response.result?.psbt;

                if (signedPsbtBase64) {
                    // Parse the signed PSBT back into a Transaction
                    const signedPsbtBytes = base64.decode(signedPsbtBase64);
                    const signedTx = Transaction.fromPSBT(signedPsbtBytes);
                    console.log("Successfully created signed transaction");
                    return signedTx;
                } else {
                    console.error(
                        "No PSBT found in successful response:",
                        response
                    );
                    throw new Error("No signed PSBT returned from wallet");
                }
            } else {
                const errorMsg = response.error?.message || "Unknown error";
                const errorCode = response.error?.code || "UNKNOWN";
                console.error("Wallet signing failed:", {
                    errorCode,
                    errorMsg,
                    fullResponse: response,
                });

                // If we get an unknown error, try to test different methods
                if (errorCode === "UNKNOWN" || !response.status) {
                    console.log("Testing alternative signing methods...");
                    const testResults =
                        await SatsConnectDebugger.testSignPsbtMethods(
                            this.satsConnectRequest,
                            psbtBase64,
                            this.address
                        );
                    console.log("Method test results:", testResults);
                }

                // Try to provide more helpful error messages
                if (errorCode === "UNAUTHORIZED") {
                    throw new Error(
                        "Wallet not connected or unauthorized. Please reconnect your wallet."
                    );
                } else if (errorCode === "USER_REJECTION") {
                    throw new Error("User cancelled the transaction signing.");
                } else {
                    throw new Error(
                        `Failed to sign transaction: ${errorCode} - ${errorMsg}`
                    );
                }
            }
        } catch (error) {
            console.error("SatsConnectIdentity.sign error:", error);

            // Check if it's a network/connection error
            if (
                error.message.includes("network") ||
                error.message.includes("fetch")
            ) {
                throw new Error(
                    "Network error: Could not connect to wallet. Please check your wallet connection."
                );
            }

            if (error instanceof Error) {
                // Re-throw with more context
                throw new Error(`SatsConnect signing failed: ${error.message}`);
            }
            throw error;
        }
    }

    xOnlyPublicKey() {
        // Return the x-only public key (32 bytes, no prefix)
        // If the public key is 33 bytes (compressed), remove the prefix
        if (this.publicKey.length === 33) {
            return this.publicKey.slice(1);
        }
        // If it's already 32 bytes, return as-is
        if (this.publicKey.length === 32) {
            return this.publicKey;
        }
        throw new Error(
            `Invalid public key length: ${this.publicKey.length}. Expected 32 or 33 bytes.`
        );
    }

    signerSession() {
        // For external wallets, we can't control the signing session
        // Return a random session as a placeholder
        // This would need to be imported from the SDK if needed
        throw new Error("signerSession not implemented for external wallets");
    }

    /**
     * Get the address associated with this identity
     */
    getAddress() {
        return this.address;
    }

    /**
     * Check if the wallet is still connected
     */
    async isConnected() {
        try {
            const response = await this.satsConnectRequest("wallet_connect", {
                addresses: ["payment"],
                message: "Checking connection status",
            });
            return response.status === "success";
        } catch (error) {
            console.error("Connection check failed:", error);
            return false;
        }
    }

    /**
     * Reconnect to the wallet
     */
    async reconnect() {
        try {
            const response = await this.satsConnectRequest("wallet_connect", {
                addresses: ["payment", "ordinals"],
                message: "Reconnecting to ARK Wallet",
            });

            if (response.status === "success") {
                const addresses = response.result.addresses;
                const matchingAddress = addresses.find(
                    (addr) => addr.address === this.address
                );

                if (matchingAddress) {
                    console.log("Wallet reconnected successfully");
                    return true;
                } else {
                    console.warn("Address not found in reconnected wallet");
                    return false;
                }
            }
            return false;
        } catch (error) {
            console.error("Reconnection failed:", error);
            return false;
        }
    }
}
