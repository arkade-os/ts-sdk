import { base64, hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha256";
import * as btc from "@scure/btc-signer";

import type {
    Wallet as IWallet,
    WalletConfig,
    WalletBalance,
    SendBitcoinParams,
    AddressInfo,
    Coin,
    VirtualCoin,
    Identity,
} from "../types/wallet";
import { ESPLORA_URL, EsploraProvider } from "../providers/esplora";
import { ArkProvider } from "../providers/ark";
import { BIP21 } from "../utils/bip21";
import { ArkAddress } from "../core/address";
import { VtxoTapscript } from "../core/tapscript";
import { selectCoins, selectVirtualCoins } from "../utils/coinselect";
import { getNetwork, Network, NetworkName } from "../types/networks";
import { TAP_LEAF_VERSION } from "@scure/btc-signer/payment";

export class Wallet implements IWallet {
    private identity: Identity;
    private network: Network;
    private onchainProvider: EsploraProvider;
    private arkProvider?: ArkProvider;
    private unsubscribeEvents?: () => void;
    private onchainAddress: string;
    private offchainAddress?: string;
    private boardingAddress?: string;
    private onchainP2TR: ReturnType<typeof btc.p2tr>;
    private offchainTapscript?: VtxoTapscript;
    private boardingTapscript?: VtxoTapscript;

    static DUST_AMOUNT = BigInt(546); // Bitcoin dust limit in satoshis = 546
    static FEE_RATE = 1; // sats/vbyte

    constructor(config: WalletConfig) {
        this.identity = config.identity;
        this.network = getNetwork(config.network as NetworkName);
        this.onchainProvider = new EsploraProvider(
            config.esploraUrl || ESPLORA_URL[config.network as NetworkName]
        );

        // Derive onchain address
        const pubkey = this.identity.xOnlyPublicKey();
        if (!pubkey) {
            throw new Error("Invalid configured public key");
        }

        // Setup Ark provider and derive offchain address if configured
        if (config.arkServerUrl && config.arkServerPublicKey) {
            this.arkProvider = new ArkProvider(
                config.arkServerUrl,
                config.arkServerPublicKey
            );

            // Generate tapscripts for Offchain adn Boarding address
            const serverPubKey = hex.decode(config.arkServerPublicKey);
            const bareVtxoTapscript = VtxoTapscript.createBareVtxo(
                pubkey,
                serverPubKey,
                this.network
            );
            const boardingTapscript = VtxoTapscript.createBoarding(
                pubkey,
                serverPubKey,
                this.network
            );
            // Save offchain and boarding address
            this.offchainAddress = new ArkAddress(
                serverPubKey,
                bareVtxoTapscript.toP2TR().tweakedPubkey,
                this.network
            ).encode();
            this.boardingAddress = boardingTapscript.toP2TR().address;
            // Save tapscripts
            this.offchainTapscript = bareVtxoTapscript;
            this.boardingTapscript = boardingTapscript;
        }

        // Save onchain Taproot address key-path only
        this.onchainP2TR = btc.p2tr(pubkey, undefined, this.network);
        this.onchainAddress = this.onchainP2TR.address!;
    }

    getAddress(): AddressInfo {
        const addressInfo: Partial<AddressInfo> = {
            onchain: this.onchainAddress,
            bip21: BIP21.create({
                address: this.onchainAddress,
            }),
        };

        // Only include Ark-related fields if Ark provider is configured and address is available
        if (this.arkProvider && this.offchainAddress) {
            addressInfo.offchain = this.offchainAddress;
            addressInfo.bip21 = BIP21.create({
                address: this.onchainAddress,
                ark: this.offchainAddress,
            });
        }

        return addressInfo as AddressInfo;
    }

    async getBalance(): Promise<WalletBalance> {
        // Get onchain coins
        const coins = await this.getCoins();
        const onchainConfirmed = coins
            .filter((coin) => coin.status.confirmed)
            .reduce((sum, coin) => sum + coin.value, 0);
        const onchainUnconfirmed = coins
            .filter((coin) => !coin.status.confirmed)
            .reduce((sum, coin) => sum + coin.value, 0);
        const onchainTotal = onchainConfirmed + onchainUnconfirmed;

        // Get offchain coins if Ark provider is configured
        let offchainSettled = 0;
        let offchainPending = 0;
        let offchainSwept = 0;
        if (this.arkProvider) {
            const vtxos = await this.getVirtualCoins();
            offchainSettled = vtxos
                .filter((coin) => coin.virtualStatus.state === "settled")
                .reduce((sum, coin) => sum + coin.value, 0);
            offchainPending = vtxos
                .filter((coin) => coin.virtualStatus.state === "pending")
                .reduce((sum, coin) => sum + coin.value, 0);
            offchainSwept = vtxos
                .filter((coin) => coin.virtualStatus.state === "swept")
                .reduce((sum, coin) => sum + coin.value, 0);
        }
        const offchainTotal = offchainSettled + offchainPending;

        return {
            onchain: {
                confirmed: onchainConfirmed,
                unconfirmed: onchainUnconfirmed,
                total: onchainTotal,
            },
            offchain: {
                swept: offchainSwept,
                settled: offchainSettled,
                pending: offchainPending,
                total: offchainTotal,
            },
            total: onchainTotal + offchainTotal,
        };
    }

    async getCoins(): Promise<Coin[]> {
        // TODO: add caching logic to lower the number of requests to provider
        const address = this.getAddress();
        return this.onchainProvider.getCoins(address.onchain);
    }

    async getVirtualCoins(): Promise<VirtualCoin[]> {
        if (!this.arkProvider) {
            return [];
        }

        // TODO: add caching logic to lower the number of requests to provider
        const address = this.getAddress();
        if (!address.offchain) {
            return [];
        }

        return this.arkProvider.getVirtualCoins(address.offchain);
    }

    async sendBitcoin(
        params: SendBitcoinParams,
        zeroFee: boolean = true
    ): Promise<string> {
        if (params.amount <= 0) {
            throw new Error("Amount must be positive");
        }

        if (params.amount < Wallet.DUST_AMOUNT) {
            throw new Error("Amount is below dust limit");
        }

        // If Ark is configured and amount is suitable, send via offchain
        if (this.arkProvider && this.isOffchainSuitable(params)) {
            return this.sendOffchain(params, zeroFee);
        }

        // Otherwise, send via onchain
        return this.sendOnchain(params);
    }

    private isOffchainSuitable(params: SendBitcoinParams): boolean {
        // TODO: Add proper logic to determine if transaction is suitable for offchain
        // For now, just check if amount is greater than dust
        return params.amount > Wallet.DUST_AMOUNT;
    }

    async sendOnchain(params: SendBitcoinParams): Promise<string> {
        const coins = await this.getCoins();
        const feeRate = params.feeRate || Wallet.FEE_RATE;

        // Ensure fee is an integer by rounding up
        const estimatedFee = Math.ceil(174 * feeRate);
        const totalNeeded = params.amount + estimatedFee;

        // Select coins
        const selected = selectCoins(coins, totalNeeded);
        if (!selected.inputs) {
            throw new Error("Insufficient funds");
        }

        // Create transaction
        const tx = new btc.Transaction();

        // Add inputs
        for (const input of selected.inputs) {
            tx.addInput({
                txid: input.txid,
                index: input.vout,
                witnessUtxo: {
                    script: this.onchainP2TR.script,
                    amount: BigInt(input.value),
                },
                tapInternalKey: this.onchainP2TR.tapInternalKey,
                tapMerkleRoot: this.onchainP2TR.tapMerkleRoot,
            });
        }

        // Add payment output
        tx.addOutputAddress(
            params.address,
            BigInt(params.amount),
            this.network
        );
        // Add change output if needed
        if (selected.changeAmount > 0) {
            tx.addOutputAddress(
                this.onchainAddress,
                BigInt(selected.changeAmount),
                this.network
            );
        }

        // Sign inputs and Finalize
        tx.sign(this.identity.privateKey());
        tx.finalize();

        // Broadcast
        const txid = await this.onchainProvider.broadcastTransaction(tx.hex);
        return txid;
    }

    async sendOffchain(
        params: SendBitcoinParams,
        zeroFee: boolean = true
    ): Promise<string> {
        if (
            !this.arkProvider ||
            !this.offchainAddress ||
            !this.offchainTapscript
        ) {
            throw new Error("Ark provider not configured");
        }

        const virtualCoins = await this.getVirtualCoins();

        const estimatedFee = zeroFee
            ? 0
            : Math.ceil(174 * (params.feeRate || Wallet.FEE_RATE));
        const totalNeeded = params.amount + estimatedFee;

        const selected = await selectVirtualCoins(virtualCoins, totalNeeded);

        if (!selected || !selected.inputs) {
            throw new Error("Insufficient funds");
        }

        const tx = new btc.Transaction({
            allowUnknownOutputs: true,
            disableScriptCheck: true,
            allowUnknownInputs: true,
        });

        // Add inputs with proper taproot script information
        for (const input of selected.inputs) {
            // Get the first leaf (multisig) since we're using the default tapscript
            const taprootPayment = this.offchainTapscript.toP2TR();
            const scriptHex = hex.encode(
                this.offchainTapscript.getForfeitScript()
            );
            const selectedLeaf = taprootPayment.leaves?.find(
                (l) => hex.encode(l.script) === scriptHex
            );
            if (!selectedLeaf) {
                throw new Error("Selected leaf not found");
            }

            // Add taproot input
            tx.addInput({
                txid: input.txid,
                index: input.vout,
                witnessUtxo: {
                    script: taprootPayment.script,
                    amount: BigInt(input.value),
                },
                tapInternalKey: undefined,
                tapLeafScript: [
                    [
                        {
                            version: TAP_LEAF_VERSION,
                            internalKey: btc.TAPROOT_UNSPENDABLE_KEY,
                            merklePath: selectedLeaf.path,
                        },
                        Buffer.concat([
                            selectedLeaf.script,
                            Buffer.from([TAP_LEAF_VERSION]),
                        ]),
                    ],
                ],
            });
        }

        // Add payment output
        const paymentAddress = ArkAddress.decode(params.address);
        tx.addOutput({
            script: new Uint8Array([
                0x51,
                0x20,
                ...paymentAddress.tweakedPubKey,
            ]),
            amount: BigInt(params.amount),
        });

        // Add change output if needed
        if (selected.changeAmount > 0) {
            tx.addOutput({
                script: this.offchainTapscript.toP2TR().script,
                amount: BigInt(selected.changeAmount),
            });
        }

        // Sign inputs and Finalize
        tx.sign(this.identity.privateKey(), undefined, new Uint8Array(32));

        const psbt = tx.toPSBT();
        // Broadcast to Ark
        return this.arkProvider.submitVirtualTx(base64.encode(psbt));
    }

    async signMessage(message: string): Promise<string> {
        const messageHash = sha256(new TextEncoder().encode(message));
        const signature = await this.identity.sign(messageHash);
        return hex.encode(signature);
    }

    /* eslint-disable @typescript-eslint/no-unused-vars */
    async verifyMessage(
        _message: string,
        _signature: string,
        _address: string
    ): Promise<boolean> {
        throw new Error("Method not implemented.");
    }

    async subscribeToEvents(
        _message: string,
        _signature: string,
        _address: string
    ): Promise<void> {
        throw new Error("Method not implemented.");
    }
    /* eslint-enable @typescript-eslint/no-unused-vars */

    dispose() {
        if (this.unsubscribeEvents) {
            this.unsubscribeEvents();
        }
    }
}
