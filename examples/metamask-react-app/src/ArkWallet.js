import * as scureBase from "@scure/base";
import { Wallet } from "@arkade-os/sdk";
import { MetaMaskSnapIdentity } from "./MetaMaskSnapIdentity.js";

const ARK_SERVER_URL = "https://signet.arkade.sh";
const ESPLORA_URL = "https://mempool.space/signet/api";

export class ArkWallet {
    constructor() {
        this.reset();
    }

    reset() {
        this.connected = false;
        this.taprootAddress = null;
        this.arkAddress = null;
        this.userPubKey = null;
        this.wallet = null;
        this.identity = null;
        this.snapId = "local:http://localhost:8080";
        
        this.loadCachedConnection();
    }
    
    loadCachedConnection() {
        try {
            const cached = localStorage.getItem('ark-wallet-cache');
            if (cached) {
                const data = JSON.parse(cached);
                if (Date.now() - data.timestamp < 5 * 60 * 1000) {
                    this.taprootAddress = data.taprootAddress;
                    this.arkAddress = data.arkAddress;
                    this.userPubKey = data.userPubKey;
                    console.log("Loaded cached wallet data:", data);
                }
            }
        } catch (error) {
            console.log("No cached connection or error loading:", error);
        }
    }
    
    cacheConnection(data) {
        try {
            const cacheData = { ...data, timestamp: Date.now() };
            localStorage.setItem('ark-wallet-cache', JSON.stringify(cacheData));
        } catch (error) {
            console.log("Error caching connection:", error);
        }
    }

    async connect() {
        try {
            if (!window.ethereum) {
                throw new Error("MetaMask not found. Please install MetaMask extension.");
            }

            console.log("Connecting to MetaMask Snap...");

            try {
                const installedSnaps = await window.ethereum.request({
                    method: 'wallet_getSnaps',
                });
                
                const isSnapInstalled = installedSnaps && installedSnaps[this.snapId];
                
                if (!isSnapInstalled) {
                    await window.ethereum.request({
                        method: 'wallet_requestSnaps',
                        params: {
                            [this.snapId]: { version: "^1.0.0" },
                        },
                    });
                }
            } catch (checkError) {
                await window.ethereum.request({
                    method: 'wallet_requestSnaps',
                    params: {
                        [this.snapId]: { version: "^1.0.0" },
                    },
                });
            }

            await new Promise(resolve => setTimeout(resolve, 500));

            const accountResponse = await window.ethereum.request({
                method: 'wallet_invokeSnap',
                params: {
                    snapId: this.snapId,
                    request: { method: 'bitcoin_getAccounts' },
                },
            });

            if (!accountResponse || !accountResponse.accounts || accountResponse.accounts.length === 0) {
                throw new Error("No accounts found in snap");
            }

            const account = accountResponse.accounts[0];
            this.taprootAddress = account.address;

            const publicKey = account.publicKey;
            const fullPubkey = scureBase.hex.decode(publicKey);
            this.userPubKey = account.xOnlyPublicKey ? 
                scureBase.hex.decode(account.xOnlyPublicKey) :
                (fullPubkey.length === 33 ? fullPubkey.slice(1) : fullPubkey);

            if (this.userPubKey.length !== 32) {
                throw new Error(`Invalid public key length: ${this.userPubKey.length}`);
            }

            this.identity = new MetaMaskSnapIdentity(
                fullPubkey,
                this.taprootAddress,
                window.ethereum
            );

            this.wallet = await Wallet.create({
                identity: this.identity,
                arkServerUrl: ARK_SERVER_URL,
                esploraUrl: ESPLORA_URL,
            });

            this.arkAddress = await this.wallet.getAddress();
            this.connected = true;

            const result = {
                taprootAddress: this.taprootAddress,
                arkAddress: this.arkAddress,
                userPubKey: scureBase.hex.encode(this.userPubKey),
            };
            
            this.cacheConnection(result);
            return result;
        } catch (error) {
            console.error("Connection failed:", error);
            this.reset();
            throw error;
        }
    }

    async sendBitcoin(recipient, amount) {
        if (!this.connected || !this.wallet) {
            throw new Error("Wallet not connected");
        }

        // Check if wallet is still connected before sending
        if (this.identity && typeof this.identity.isConnected === "function") {
            const isConnected = await this.identity.isConnected();
            if (!isConnected) {
                throw new Error(
                    "Wallet connection lost. Please reconnect your wallet."
                );
            }
        }

        try {
            // Validate recipient address
            if (!this.isValidArkAddress(recipient)) {
                throw new Error("Invalid ARK address format");
            }

            // Use the wallet's sendBitcoin method
            const arkTxid = await this.wallet.sendBitcoin({
                address: recipient,
                amount: parseInt(amount, 10),
            });

            return arkTxid;
        } catch (error) {
            // If it's a wallet connection error, provide helpful message
            if (
                error.message.includes("Wallet not connected") ||
                error.message.includes("not connected") ||
                error.message.includes("UNAUTHORIZED") ||
                error.message.includes("User rejected")
            ) {
                throw new Error(
                    "Wallet connection lost or user rejected. Please refresh the page and reconnect your wallet."
                );
            }
            throw new Error(`Transaction failed: ${error.message}`);
        }
    }

    async settle(outputs = null) {
        if (!this.connected || !this.wallet) {
            throw new Error("Wallet not connected");
        }

        // Check if wallet is still connected before settling
        if (this.identity && typeof this.identity.isConnected === "function") {
            const isConnected = await this.identity.isConnected();
            if (!isConnected) {
                throw new Error(
                    "Wallet connection lost. Please reconnect your wallet."
                );
            }
        }

        try {
            let settleParams;

            if (outputs) {
                // Custom outputs provided
                settleParams = {
                    outputs: outputs.map((output) => ({
                        address: output.address,
                        amount: BigInt(output.amount),
                    })),
                };
            }
            // If no outputs provided, settle() will use default behavior (all to offchain)

            // Set up event callback to track settlement progress
            const events = [];
            const eventCallback = (event) => {
                events.push(event);
                console.log("Settlement event:", event);
            };

            const txid = await this.wallet.settle(settleParams, eventCallback);

            return {
                txid,
                events,
            };
        } catch (error) {
            // If it's a wallet connection error, provide helpful message
            if (
                error.message.includes("Wallet not connected") ||
                error.message.includes("not connected") ||
                error.message.includes("UNAUTHORIZED") ||
                error.message.includes("User rejected")
            ) {
                throw new Error(
                    "Wallet connection lost or user rejected. Please refresh the page and reconnect your wallet."
                );
            }
            throw new Error(`Settlement failed: ${error.message}`);
        }
    }

    async getBalance() {
        if (!this.connected || !this.wallet) {
            throw new Error("Wallet not connected");
        }

        try {
            const balance = await this.wallet.getBalance();
            return balance;
        } catch (error) {
            throw new Error(`Failed to get balance: ${error.message}`);
        }
    }

    async getVtxos() {
        if (!this.connected || !this.wallet) {
            throw new Error("Wallet not connected");
        }

        try {
            const vtxos = await this.wallet.getVtxos();
            return vtxos;
        } catch (error) {
            throw new Error(`Failed to get VTXOs: ${error.message}`);
        }
    }

    async getBoardingUtxos() {
        if (!this.connected || !this.wallet) {
            throw new Error("Wallet not connected");
        }

        try {
            const utxos = await this.wallet.getBoardingUtxos();
            return utxos;
        } catch (error) {
            throw new Error(`Failed to get boarding UTXOs: ${error.message}`);
        }
    }

    isValidArkAddress(address) {
        try {
            ArkAddress.decode(address);
            return true;
        } catch {
            return false;
        }
    }

    getDebugInfo() {
        return {
            connected: this.connected,
            userPubKey: this.userPubKey
                ? scureBase.hex.encode(this.userPubKey)
                : null,
            arkAddress: this.arkAddress,
            taprootAddress: this.taprootAddress,
            hasWallet: !!this.wallet,
            hasIdentity: !!this.identity,
            arkServerUrl: ARK_SERVER_URL,
            esploraUrl: ESPLORA_URL,
            snapId: this.snapId,
            hasMetaMask: !!window.ethereum,
        };
    }
}

export default ArkWallet;
