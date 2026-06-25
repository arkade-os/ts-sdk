import { base64, hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";

/**
 * MetaMask Snap identity implementation for Bitcoin signing.
 * Provides the same interface as SatsConnectIdentity but uses MetaMask Snap.
 */
export class MetaMaskSnapIdentity {
    constructor(publicKey, address, ethereum) {
        this.publicKey = publicKey;
        this.address = address;
        this.ethereum = ethereum;
        this.snapId = "local:http://localhost:8080";
    }

    xOnlyPublicKey() {
        const fullPubkey = typeof this.publicKey === 'string' 
            ? hex.decode(this.publicKey) 
            : this.publicKey;
        
        return fullPubkey.length === 33 ? fullPubkey.slice(1) : fullPubkey;
    }

    getAddress() {
        return this.address;
    }

    async isConnected() {
        try {
            const accounts = await this.ethereum.request({
                method: 'wallet_invokeSnap',
                params: {
                    snapId: this.snapId,
                    request: { method: 'bitcoin_getAccounts' },
                },
            });
            
            return accounts && accounts.accounts && accounts.accounts.length > 0;
        } catch (error) {
            console.error("Connection check failed:", error);
            return false;
        }
    }

    async reconnect() {
        try {
            await this.ethereum.request({
                method: 'wallet_requestSnaps',
                params: { [this.snapId]: {} },
            });

            return await this.isConnected();
        } catch (error) {
            console.error("Reconnection failed:", error);
            return false;
        }
    }

    async sign(tx, inputIndexes = null) {
        console.log("MetaMaskSnapIdentity.sign called with:", {
            inputIndexes,
            txInputsLength: tx.inputsLength,
            address: this.address,
        });

        try {
            const isConnected = await this.isConnected();
            if (!isConnected) {
                const reconnected = await this.reconnect();
                if (!reconnected) {
                    throw new Error("Snap not connected");
                }
            }

            const psbt = tx.toPSBT();
            const psbtBase64 = base64.encode(psbt);

            let signInputs;
            if (inputIndexes) {
                signInputs = inputIndexes;
            } else {
                signInputs = Array.from({ length: tx.inputsLength }, (_, i) => i);
            }

            const requestParams = {
                psbt: psbtBase64,
                inputIndexes: signInputs,
            };

            const response = await this.ethereum.request({
                method: 'wallet_invokeSnap',
                params: {
                    snapId: this.snapId,
                    request: {
                        method: 'bitcoin_signPsbt',
                        params: requestParams,
                    },
                },
            });

            if (response && response.psbt) {
                const signedPsbtBytes = base64.decode(response.psbt);
                const signedTx = Transaction.fromPSBT(signedPsbtBytes);
                console.log("Successfully created signed transaction");
                return signedTx;
            } else {
                throw new Error("No signed PSBT returned from snap");
            }
        } catch (error) {
            console.error("Snap signing failed:", error);
            
            if (error.code === 4001) {
                throw new Error("User rejected the signing request");
            } else if (error.code === 4100) {
                throw new Error("The requested method and/or account has not been authorized by the user");
            } else if (error.code === -32002) {
                throw new Error("A request is already pending. Please wait.");
            } else if (error.message.includes("network") || error.message.includes("fetch")) {
                throw new Error("Network error: Could not connect to snap. Please check your snap connection.");
            }
            
            if (error instanceof Error) {
                throw new Error(`MetaMask Snap signing failed: ${error.message}`);
            }
            throw error;
        }
    }
}
