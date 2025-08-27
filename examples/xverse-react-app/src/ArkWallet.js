import { getProviders, request } from "sats-connect";
import * as scureBase from "@scure/base";
import * as btcSigner from "@scure/btc-signer";
import {
    Wallet,
    SingleKey,
    RestArkProvider,
    RestIndexerProvider,
    EsploraProvider,
    networks,
    ArkAddress,
} from "@arkade-os/sdk";
import { SatsConnectIdentity } from "./SatsConnectIdentity.js";

// ARK Server configuration for signet
const ARK_SERVER_URL = "https://signet.arkade.sh";
const ESPLORA_URL = "https://mempool.space/signet/api";

export class ArkWallet {
    constructor() {
        this.reset();
    }

    reset() {
        this.connected = false;
        this.ordinalAddress = null;
        this.arkAddress = null;
        this.userPubKey = null;
        this.wallet = null;
        this.identity = null;
    }

    async connect() {
        try {
            // Check for available providers
            const providers = getProviders();
            const xverseProvider = providers.find(
                (p) =>
                    p.name === "Xverse Wallet" ||
                    p.id === "BitcoinProvider" ||
                    p.id === "xverseProviders.BitcoinProvider"
            );

            if (!xverseProvider) {
                throw new Error(
                    "Xverse wallet not found. Please install Xverse extension."
                );
            }

            // Connect to wallet using wallet_connect (correct sats-connect API)
            const response = await request("wallet_connect", {
                message:
                    "Connect to ARK Wallet to create and manage ARK transactions",
                addresses: ["payment", "ordinals"], // Request both payment and ordinals addresses
                network: "Signet", // Use Signet network to match ARK_SERVER_URL
            });

            if (response.status !== "success") {
                throw new Error(response.error?.message || "Connection failed");
            }

            // Access addresses from the correct response structure
            const addresses = response.result.addresses;
            const ordinalAccount =
                addresses.find(
                    (addr) =>
                        addr.purpose === "ordinals" ||
                        addr.purpose === "payment"
                ) || addresses[0];

            if (!ordinalAccount) {
                throw new Error("No usable address found in wallet");
            }

            // Store ordinal address for reference
            this.ordinalAddress = ordinalAccount.address;

            // Extract user public key
            const publicKey = ordinalAccount.publicKey || ordinalAccount.pubkey;
            const fullPubkey = scureBase.hex.decode(publicKey);
            this.userPubKey =
                fullPubkey.length === 33 ? fullPubkey.slice(1) : fullPubkey;

            if (this.userPubKey.length !== 32) {
                throw new Error(
                    `Invalid public key length: ${this.userPubKey.length}`
                );
            }

            // Create identity using SatsConnectIdentity for external wallet signing
            // This fixes the previous issue where we incorrectly used the public key
            // as a private key with SingleKey. Now we properly delegate signing
            // to the external wallet through sats-connect's signPsbt method.
            // Uses the correct wallet_connect API as documented.
            this.identity = new SatsConnectIdentity(
                fullPubkey, // Use the full public key (with prefix if present)
                this.ordinalAddress, // The wallet address
                request // Pass the sats-connect request function
            );

            // Create wallet instance using the SDK
            this.wallet = await Wallet.create({
                identity: this.identity,
                arkServerUrl: ARK_SERVER_URL,
                esploraUrl: ESPLORA_URL,
            });

            // Get ARK address from the wallet
            this.arkAddress = await this.wallet.getAddress();
            this.connected = true;

            return {
                ordinalAddress: this.ordinalAddress,
                arkAddress: this.arkAddress,
                userPubKey: scureBase.hex.encode(this.userPubKey),
            };
        } catch (error) {
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
                error.message.includes("UNAUTHORIZED")
            ) {
                throw new Error(
                    "Wallet connection lost. Please refresh the page and reconnect your wallet."
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
                error.message.includes("UNAUTHORIZED")
            ) {
                throw new Error(
                    "Wallet connection lost. Please refresh the page and reconnect your wallet."
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
            ordinalAddress: this.ordinalAddress,
            hasWallet: !!this.wallet,
            hasIdentity: !!this.identity,
            arkServerUrl: ARK_SERVER_URL,
            esploraUrl: ESPLORA_URL,
            providers: getProviders().map((p) => ({
                name: p.name,
                id: p.id,
                methods: p.methods,
            })),
        };
    }
}

export default ArkWallet;
