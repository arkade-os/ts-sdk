import * as scureBase from "@scure/base";
import {
    ArkAddress,
    EsploraProvider,
    RestIndexerProvider,
    RestOperatorProvider,
    Transaction,
    Wallet,
    buildOffchainTx,
} from "@arkade-os/sdk";
import { getProviders, request } from "sats-connect";
import { SatsConnectIdentity } from "../identity/SatsConnectIdentity";
import type { ArkadeWalletConfig, ArkadeWalletInfo, SatsConnectRequest } from "../types";

export class ArkadeWallet {
    private connected = false;
    private ordinalAddress: string | null = null;
    private paymentAddress: string | null = null;
    private arkAddress: string | null = null;
    private userPubKey: Uint8Array | null = null;
    private wallet: Wallet | null = null;
    private identity: SatsConnectIdentity | null = null;
    private config: ArkadeWalletConfig;
    private satsConnectRequest: SatsConnectRequest;
    /** Bumped by reset() and updateConfig(), so a connect() they overtake publishes nothing. */
    private attempt = 0;

    constructor(config: ArkadeWalletConfig) {
        this.config = config;
        this.satsConnectRequest = this.buildSatsConnectRequest(config);
        this.reset();
    }

    updateConfig(config: ArkadeWalletConfig) {
        this.attempt++;
        this.config = config;
        this.satsConnectRequest = this.buildSatsConnectRequest(config);
    }

    reset() {
        this.attempt++;
        disposeQuietly(this.wallet);
        this.connected = false;
        this.ordinalAddress = null;
        this.paymentAddress = null;
        this.arkAddress = null;
        this.userPubKey = null;
        this.wallet = null;
        this.identity = null;
    }

    getWallet(): Wallet | null {
        return this.wallet;
    }

    getIdentity(): SatsConnectIdentity | null {
        return this.identity;
    }

    async connect(): Promise<ArkadeWalletInfo> {
        // One configuration and transport for the whole attempt, whatever changes meanwhile.
        const attempt = ++this.attempt;
        const config = this.config;
        const request = this.satsConnectRequest;
        const stillCurrent = () => {
            if (attempt !== this.attempt) {
                throw new Error("Connection superseded by a reset or a new configuration");
            }
        };
        let wallet: Wallet | null = null;
        try {
            if (config.checkProvider !== false) {
                const providers = getProviders();
                if (!providers || providers.length === 0) {
                    throw new Error(
                        "Sats Connect provider not found. Please install a compatible wallet.",
                    );
                }
            }

            const requestParams: Record<string, any> = {
                message:
                    config.connectMessage ||
                    "Connect to Arkade wallet to create and manage Ark transactions",
                addresses: ["payment", "ordinals"],
            };
            if (config.satsConnectNetwork) {
                requestParams.network = config.satsConnectNetwork;
            }

            const response = await request("wallet_connect", requestParams);
            stillCurrent();

            if (response.status !== "success") {
                throw new Error(response.error?.message || "Connection failed");
            }

            const addresses = response.result?.addresses;
            if (!Array.isArray(addresses) || addresses.length === 0) {
                throw new Error("No usable address found in wallet");
            }

            const paymentAccount =
                addresses.find((addr: any) => addr.purpose === "payment") || addresses[0];
            const ordinalsAccount = addresses.find((addr: any) => addr.purpose === "ordinals");

            if (!ordinalsAccount) {
                throw new Error("No ordinals address found in wallet");
            }

            // Always use the ordinals address for Taproot signing.
            const signingAccount = ordinalsAccount;

            const signingAccountKey = signingAccount as { publicKey?: string; pubkey?: string };
            const publicKeyHex = signingAccountKey.publicKey || signingAccountKey.pubkey;
            if (!publicKeyHex) {
                throw new Error("No public key found in wallet");
            }

            const fullPubkey = scureBase.hex.decode(publicKeyHex);
            const userPubKey = fullPubkey.length === 33 ? fullPubkey.slice(1) : fullPubkey;

            if (userPubKey.length !== 32) {
                throw new Error(`Invalid public key length: ${userPubKey.length}`);
            }

            const ordinalAddress = ordinalsAccount.address;
            const paymentAddress = paymentAccount.address;

            const identity = new SatsConnectIdentity(
                fullPubkey,
                signingAccount.address,
                request,
                config.satsConnectNetwork,
                // The batch API reaches the default wallet only, not a configured transport.
                config.satsConnectRequest === undefined && config.providerId === undefined,
            );

            wallet = await Wallet.create({
                identity,
                operatorProvider: new RestOperatorProvider(config.arkServerUrl),
                indexerProvider: new RestIndexerProvider(config.arkServerUrl),
                onchainProvider: new EsploraProvider(config.esploraUrl),
            });

            const arkAddress = await wallet.getAddress();
            const boardingAddress = await wallet.getBoardingAddress();
            stillCurrent();

            this.userPubKey = userPubKey;
            this.ordinalAddress = ordinalAddress;
            this.paymentAddress = paymentAddress;
            this.identity = identity;
            this.wallet = wallet;
            this.arkAddress = arkAddress;
            this.connected = true;

            return {
                ordinalAddress,
                paymentAddress,
                arkAddress,
                boardingAddress,
                userPubKey: scureBase.hex.encode(userPubKey),
            };
        } catch (error) {
            if (wallet !== this.wallet) disposeQuietly(wallet);
            if (attempt === this.attempt) this.reset();
            throw error;
        }
    }

    async sendBitcoin(recipient: string, amount: number) {
        const wallet = this.ensureWallet();

        try {
            await this.ensureIdentityConnected();

            if (!this.isValidArkAddress(recipient)) {
                throw new Error("Invalid Ark address format");
            }

            const normalizedAmount = wholeSats(amount);

            return await wallet.send({ address: recipient, amount: normalizedAmount });
        } catch (error: any) {
            if (
                error?.message?.includes("Wallet not connected") ||
                error?.message?.includes("not connected") ||
                error?.message?.includes("UNAUTHORIZED")
            ) {
                throw new Error(
                    "Wallet connection lost. Please refresh the page and reconnect your wallet.",
                );
            }
            throw new Error(`Transaction failed: ${error?.message || "Unknown error"}`);
        }
    }

    // Advanced flow: manual offchain tx construction/signing for custom outputs.
    // Kept as a helper for more complex scenarios.
    async sendBitcoinAdvanced(recipient: string, amount: number) {
        const wallet = this.ensureWallet();

        await this.ensureIdentityConnected();

        if (!this.isValidArkAddress(recipient)) {
            throw new Error("Invalid Ark address format");
        }

        const normalizedAmount = wholeSats(amount);

        const vtxos = await wallet.getVtxos({ withRecoverable: false });
        const selected = selectVirtualCoins(vtxos, normalizedAmount);

        const selectedLeaf = wallet.offchainTapscript.forfeit();
        if (!selectedLeaf) {
            throw new Error("Selected leaf not found");
        }

        const outputAddress = ArkAddress.decode(recipient);
        const outputScript =
            BigInt(normalizedAmount) < wallet.dustAmount
                ? outputAddress.subdustPkScript
                : outputAddress.pkScript;

        const outputs: Array<{ script: Uint8Array; amount: bigint }> = [
            {
                script: outputScript,
                amount: BigInt(normalizedAmount),
            },
        ];

        // As in wallet.send(): no fee is taken, and change below dust goes to the subdust script.
        if (selected.changeAmount > 0n) {
            const changeScript =
                selected.changeAmount < wallet.dustAmount
                    ? wallet.arkAddress.subdustPkScript
                    : wallet.arkAddress.pkScript;
            outputs.push({
                script: changeScript,
                amount: selected.changeAmount,
            });
        }

        const tapTree = wallet.offchainTapscript.encode();
        const offchainTx = buildOffchainTx(
            selected.inputs.map((input) => ({
                ...input,
                tapLeafScript: selectedLeaf,
                tapTree,
            })),
            outputs,
            wallet.serverUnrollScript,
        );

        const signedVirtualTx = await wallet.identity.sign(offchainTx.arkTx);
        const { arkTxid, signedCheckpointTxs } = await wallet.arkProvider.submitTx(
            scureBase.base64.encode(signedVirtualTx.toPSBT()),
            offchainTx.checkpoints.map((checkpoint) =>
                scureBase.base64.encode(checkpoint.toPSBT()),
            ),
        );

        const finalCheckpoints = await Promise.all(
            signedCheckpointTxs.map(async (checkpoint) => {
                const serverCheckpoint = Transaction.fromPSBT(scureBase.base64.decode(checkpoint));
                const signedCheckpoint = await wallet.identity.sign(serverCheckpoint);
                return scureBase.base64.encode(signedCheckpoint.toPSBT());
            }),
        );

        await wallet.arkProvider.finalizeTx(arkTxid, finalCheckpoints);

        return arkTxid;
    }

    async settle(outputs: Array<{ address: string; amount: number }> | null = null) {
        const wallet = this.ensureWallet();

        await this.ensureIdentityConnected();

        try {
            let settleParams: any;
            if (outputs) {
                settleParams = {
                    outputs: outputs.map((output) => ({
                        address: output.address,
                        amount: BigInt(output.amount),
                    })),
                };
            }

            const events: any[] = [];
            const eventCallback = (event: any) => {
                events.push(event);
            };

            const txid = await wallet.settle(settleParams, eventCallback);

            return {
                txid,
                events,
            };
        } catch (error: any) {
            if (
                error?.message?.includes("Wallet not connected") ||
                error?.message?.includes("not connected") ||
                error?.message?.includes("UNAUTHORIZED")
            ) {
                throw new Error(
                    "Wallet connection lost. Please refresh the page and reconnect your wallet.",
                );
            }
            throw new Error(`Settlement failed: ${error?.message || "Unknown error"}`);
        }
    }

    async getBalance() {
        const wallet = this.ensureWallet();
        try {
            return await wallet.getBalance();
        } catch (error: any) {
            throw new Error(`Failed to get balance: ${error?.message || "Unknown error"}`);
        }
    }

    async getVtxos() {
        const wallet = this.ensureWallet();
        try {
            return await wallet.getVtxos();
        } catch (error: any) {
            throw new Error(`Failed to get VTXOs: ${error?.message || "Unknown error"}`);
        }
    }

    async getBoardingUtxos() {
        const wallet = this.ensureWallet();
        try {
            return await wallet.getBoardingUtxos();
        } catch (error: any) {
            throw new Error(`Failed to get boarding UTXOs: ${error?.message || "Unknown error"}`);
        }
    }

    isValidArkAddress(address: string) {
        try {
            ArkAddress.decode(address);
            return true;
        } catch {
            return false;
        }
    }

    getDebugInfo() {
        let providers: { name?: string; id?: string; methods?: string[] }[] = [];
        try {
            providers = getProviders().map((p) => ({
                name: p.name,
                id: p.id,
                methods: p.methods,
            }));
        } catch {
            providers = [];
        }

        return {
            connected: this.connected,
            userPubKey: this.userPubKey ? scureBase.hex.encode(this.userPubKey) : null,
            arkAddress: this.arkAddress,
            ordinalAddress: this.ordinalAddress,
            paymentAddress: this.paymentAddress,
            hasWallet: !!this.wallet,
            hasIdentity: !!this.identity,
            arkServerUrl: this.config.arkServerUrl,
            esploraUrl: this.config.esploraUrl,
            providers,
        };
    }

    private ensureWallet(): Wallet {
        if (!this.connected || !this.wallet) {
            throw new Error("Wallet not connected");
        }
        return this.wallet;
    }

    private async ensureIdentityConnected(): Promise<void> {
        if (!this.identity) {
            return;
        }
        const isConnected = await this.identity.isConnected();
        if (!isConnected) {
            throw new Error("Wallet connection lost. Please reconnect your wallet.");
        }
    }

    private buildSatsConnectRequest(config: ArkadeWalletConfig): SatsConnectRequest {
        const baseRequest = config.satsConnectRequest ?? request;
        const providerId = config.providerId;
        return (method, params, overrideProviderId) =>
            baseRequest(method, params, overrideProviderId ?? providerId);
    }
}

type VirtualCoinLike = {
    value: number;
    virtualStatus?: { batchExpiry?: number };
};

function selectVirtualCoins<T extends VirtualCoinLike>(coins: T[], targetAmount: number) {
    const sortedCoins = [...coins].sort((a, b) => {
        const expiryA = a.virtualStatus?.batchExpiry ?? Number.MAX_SAFE_INTEGER;
        const expiryB = b.virtualStatus?.batchExpiry ?? Number.MAX_SAFE_INTEGER;
        if (expiryA !== expiryB) {
            return expiryA - expiryB;
        }
        return b.value - a.value;
    });

    const selectedCoins: T[] = [];
    let selectedAmount = 0;

    for (const coin of sortedCoins) {
        selectedCoins.push(coin);
        selectedAmount += coin.value;
        if (selectedAmount >= targetAmount) {
            break;
        }
    }

    if (selectedAmount === targetAmount) {
        return { inputs: selectedCoins, changeAmount: 0n };
    }

    if (selectedAmount < targetAmount) {
        throw new Error("Insufficient funds");
    }

    return {
        inputs: selectedCoins,
        changeAmount: BigInt(selectedAmount - targetAmount),
    };
}

function wholeSats(amount: number): number {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new Error("Amount must be a positive whole number of sats");
    }
    return amount;
}

function disposeQuietly(wallet: Wallet | null): void {
    wallet?.dispose().catch((error) => console.warn("Failed to dispose the Arkade wallet", error));
}
