import { base64, hex } from "@scure/base";
import * as btc from "@scure/btc-signer";
import { TAP_LEAF_VERSION, tapLeafHash } from "@scure/btc-signer/payment";
import { clearInterval, setInterval } from "timers";

import { BIP21 } from "../utils/bip21";
import { ArkAddress } from "../core/address";
import { checkSequenceVerifyScript, VtxoTapscript } from "../core/tapscript";
import { selectCoins, selectVirtualCoins } from "../utils/coinselect";
import { getNetwork, Network, NetworkName } from "./networks";
import {
    ESPLORA_URL,
    EsploraProvider,
    OnchainProvider,
} from "../providers/onchain";
import {
    ArkInfo,
    FinalizationEvent,
    SettlementEvent,
    SettlementEventType,
    SigningNoncesGeneratedEvent,
    SigningStartEvent,
    ArkProvider,
    Output,
    VtxoInput,
    RestArkProvider,
} from "../providers/ark";
import { SignerSession } from "./signingSession";
import { buildForfeitTx } from "./forfeit";
import { TxWeightEstimator } from "../utils/txSizeEstimator";
import { validateConnectorsTree, validateVtxoTree } from "./tree/validation";
import { TransactionOutput } from "@scure/btc-signer/psbt";
import { Identity } from "./identity";

export interface WalletConfig {
    network: NetworkName;
    identity: Identity;
    esploraUrl?: string;
    arkServerUrl?: string;
    arkServerPublicKey?: string;
}

export interface WalletBalance {
    onchain: {
        confirmed: number;
        unconfirmed: number;
        total: number;
    };
    offchain: {
        swept: number;
        settled: number;
        pending: number;
        total: number;
    };
    total: number;
}

export interface SendBitcoinParams {
    address: string;
    amount: number;
    feeRate?: number;
    memo?: string;
}

export interface Recipient {
    address: string;
    amount: number;
}

// SpendableVtxo embed the forfeit script to use as spending path for the boarding utxo or vtxo
export type SpendableVtxo = VtxoInput & {
    forfeitScript: string;
};

export interface SettleParams {
    inputs: (string | SpendableVtxo)[];
    outputs: Output[];
}

// VtxoTaprootAddress embed the tapscripts composing the address
// it admits the internal key is the unspendable x-only public key
export interface VtxoTaprootAddress {
    address: string;
    scripts: {
        exit: string[];
        forfeit: string[];
    };
}

export interface AddressInfo {
    onchain: string;
    offchain?: VtxoTaprootAddress;
    boarding?: VtxoTaprootAddress;
    bip21: string;
}

export interface TapscriptInfo {
    offchain?: string[];
    boarding?: string[];
}

export interface Status {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
}

export interface VirtualStatus {
    state: "pending" | "settled" | "swept" | "spent";
    batchTxID?: string;
    batchExpiry?: number;
}

export interface Outpoint {
    txid: string;
    vout: number;
}

export interface Coin extends Outpoint {
    value: number;
    status: Status;
}

export interface VirtualCoin extends Coin {
    virtualStatus: VirtualStatus;
}

export class Wallet {
    private identity: Identity;
    private network: Network;
    private onchainProvider: OnchainProvider;
    private arkProvider?: ArkProvider;
    private unsubscribeEvents?: () => void;
    private onchainAddress: string;
    private offchainAddress?: VtxoTaprootAddress;
    private boardingAddress?: VtxoTaprootAddress;
    private onchainP2TR: ReturnType<typeof btc.p2tr>;
    private offchainTapscript?: VtxoTapscript;

    public boardingTapscript?: VtxoTapscript;

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
            this.arkProvider = new RestArkProvider(config.arkServerUrl);

            // Generate tapscripts for Offchain and Boarding address
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
            this.offchainAddress = {
                address: new ArkAddress(
                    serverPubKey,
                    bareVtxoTapscript.toP2TR().tweakedPubkey,
                    this.network
                ).encode(),
                scripts: {
                    exit: [hex.encode(bareVtxoTapscript.getExitScript())],
                    forfeit: [hex.encode(bareVtxoTapscript.getForfeitScript())],
                },
            };
            this.boardingAddress = {
                address: boardingTapscript.toP2TR().address!,
                scripts: {
                    exit: [hex.encode(boardingTapscript.getExitScript())],
                    forfeit: [hex.encode(boardingTapscript.getForfeitScript())],
                },
            };
            // Save tapscripts
            this.offchainTapscript = bareVtxoTapscript;
            this.boardingTapscript = boardingTapscript;
        }

        // Save onchain Taproot address key-path only
        this.onchainP2TR = btc.p2tr(pubkey, undefined, this.network);
        this.onchainAddress = this.onchainP2TR.address!;
    }

    getAddress(): AddressInfo {
        const addressInfo: AddressInfo = {
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
                ark: this.offchainAddress.address,
            });
            addressInfo.boarding = this.boardingAddress;
        }

        return addressInfo;
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

    async getVtxos(): Promise<(SpendableVtxo & VirtualCoin)[]> {
        if (!this.arkProvider) {
            return [];
        }

        // TODO: add caching logic to lower the number of requests to provider
        const address = this.getAddress();
        if (!address.offchain) {
            return [];
        }

        const virtualCoins = await this.arkProvider.getVirtualCoins(
            address.offchain.address
        );
        return virtualCoins.map((vtxo) => ({
            ...vtxo,
            outpoint: {
                txid: vtxo.txid,
                vout: vtxo.vout,
            },
            forfeitScript: address.offchain!.scripts.forfeit[0],
            tapscripts: [
                ...address.offchain!.scripts.forfeit,
                ...address.offchain!.scripts.exit,
            ],
        }));
    }

    async getVirtualCoins(): Promise<VirtualCoin[]> {
        if (!this.arkProvider) {
            return [];
        }

        const address = this.getAddress();
        if (!address.offchain) {
            return [];
        }

        return this.arkProvider.getVirtualCoins(address.offchain.address);
    }

    async getBoardingUtxos(): Promise<SpendableVtxo[]> {
        if (!this.arkProvider) {
            return [];
        }

        if (!this.boardingAddress) {
            throw new Error("Boarding address not configured");
        }

        const boardingUtxos = await this.onchainProvider.getCoins(
            this.boardingAddress.address
        );

        return boardingUtxos.map((coin) => ({
            ...coin,
            outpoint: {
                txid: coin.txid,
                vout: coin.vout,
            },
            forfeitScript: this.boardingAddress!.scripts.forfeit[0],
            tapscripts: [
                ...this.boardingAddress!.scripts.forfeit,
                ...this.boardingAddress!.scripts.exit,
            ],
        }));
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
        let tx = new btc.Transaction();

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
        tx = await this.identity.sign(tx);
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

        let tx = new btc.Transaction({
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
                        new Uint8Array([
                            ...selectedLeaf.script,
                            TAP_LEAF_VERSION,
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

        // Sign inputs
        tx = await this.identity.sign(tx);

        const psbt = tx.toPSBT();
        // Broadcast to Ark
        return this.arkProvider.submitVirtualTx(base64.encode(psbt));
    }

    async settle(
        params: SettleParams,
        eventCallback?: (event: SettlementEvent) => void
    ): Promise<string> {
        if (!this.arkProvider) {
            throw new Error("Ark provider not configured");
        }

        // register inputs
        const { requestId } =
            await this.arkProvider!.registerInputsForNextRound(params.inputs);

        // session holds the state of the musig2 signing process of the vtxo tree
        const session = this.identity.signerSession();

        // register outputs
        await this.arkProvider.registerOutputsForNextRound(
            requestId,
            params.outputs,
            [hex.encode(session.getPublicKey())]
        );

        // start pinging every seconds
        const interval = setInterval(() => {
            this.arkProvider?.ping(requestId).catch(stopPing);
        }, 1000);
        let pingRunning = true;
        const stopPing = () => {
            if (pingRunning) {
                pingRunning = false;
                clearInterval(interval);
            }
        };

        // listen to settlement events
        const settlementStream = this.arkProvider.getEventStream();
        let step: SettlementEventType | undefined;

        const info = await this.arkProvider.getInfo();

        const sweepTapscript = checkSequenceVerifyScript(
            {
                value: info.batchExpiry,
                type: info.batchExpiry >= 512n ? "seconds" : "blocks",
            },
            hex.decode(info.pubkey).slice(1)
        );

        const sweepTapTreeRoot = tapLeafHash(sweepTapscript);

        for await (const event of settlementStream) {
            if (eventCallback) {
                eventCallback(event);
            }
            switch (event.type) {
                // the settlement failed
                case SettlementEventType.Failed:
                    if (step === undefined) {
                        continue;
                    }
                    stopPing();
                    throw new Error(event.reason);
                // the server has started the signing process of the vtxo tree transactions
                // the server expects the partial musig2 nonces for each tx
                case SettlementEventType.SigningStart:
                    if (step !== undefined) {
                        continue;
                    }
                    stopPing();
                    if (!session) {
                        throw new Error("Signing session not found");
                    }
                    await this.handleSettlementSigningEvent(
                        event,
                        sweepTapTreeRoot,
                        session
                    );
                    break;
                // the musig2 nonces of the vtxo tree transactions are generated
                // the server expects now the partial musig2 signatures
                case SettlementEventType.SigningNoncesGenerated:
                    if (step !== SettlementEventType.SigningStart) {
                        continue;
                    }
                    stopPing();
                    if (!session) {
                        throw new Error("Signing session not found");
                    }
                    await this.handleSettlementSigningNoncesGeneratedEvent(
                        event,
                        session
                    );
                    break;
                // the vtxo tree is signed, craft, sign and submit forfeit transactions
                // if any boarding utxos are involved, the settlement tx is also signed
                case SettlementEventType.Finalization:
                    if (step !== SettlementEventType.SigningNoncesGenerated) {
                        continue;
                    }
                    stopPing();
                    await this.handleSettlementFinalizationEvent(
                        event,
                        params.inputs,
                        info
                    );
                    break;
                // the settlement is done, last event to be received
                case SettlementEventType.Finalized:
                    if (step !== SettlementEventType.Finalization) {
                        continue;
                    }
                    return event.roundTxid;
            }

            step = event.type;
        }

        throw new Error("Settlement failed");
    }

    // validates the vtxo tree, creates a signing session and generates the musig2 nonces
    private async handleSettlementSigningEvent(
        event: SigningStartEvent,
        sweepTapTreeRoot: Uint8Array,
        session: SignerSession
    ) {
        const vtxoTree = event.unsignedVtxoTree;
        if (!this.arkProvider) {
            throw new Error("Ark provider not configured");
        }

        // validate the unsigned vtxo tree
        validateVtxoTree(
            event.unsignedSettlementTx,
            vtxoTree,
            sweepTapTreeRoot
        );

        // TODO check if our registered outputs are in the vtxo tree

        const settlementPsbt = base64.decode(event.unsignedSettlementTx);
        const settlementTx = btc.Transaction.fromPSBT(settlementPsbt);
        const sharedOutput = settlementTx.getOutput(0);
        if (!sharedOutput?.amount) {
            throw new Error("Shared output not found");
        }

        session.init(vtxoTree, sweepTapTreeRoot, sharedOutput.amount);

        await this.arkProvider.submitTreeNonces(
            event.id,
            hex.encode(session.getPublicKey()),
            session.getNonces()
        );
    }

    private async handleSettlementSigningNoncesGeneratedEvent(
        event: SigningNoncesGeneratedEvent,
        session: SignerSession
    ) {
        if (!this.arkProvider) {
            throw new Error("Ark provider not configured");
        }

        session.setAggregatedNonces(event.treeNonces);
        const signatures = session.sign();

        await this.arkProvider.submitTreeSignatures(
            event.id,
            hex.encode(session.getPublicKey()),
            signatures
        );
    }

    private async handleSettlementFinalizationEvent(
        event: FinalizationEvent,
        inputs: SettleParams["inputs"],
        infos: ArkInfo
    ) {
        if (!this.arkProvider) {
            throw new Error("Ark provider not configured");
        }

        // parse the server forfeit address
        // server is expecting funds to be sent to this address
        const forfeitAddress = btc
            .Address(this.network)
            .decode(infos.forfeitAddress);
        const serverScript = btc.OutScript.encode(forfeitAddress);

        // the signed forfeits transactions to submit
        const signedForfeits: string[] = [];

        const vtxos = await this.getVirtualCoins();
        let settlementPsbt = btc.Transaction.fromPSBT(
            base64.decode(event.roundTx)
        );
        let hasBoardingUtxos = false;
        let connectorsTreeValid = false;

        for (const input of inputs) {
            if (typeof input === "string") continue; // skip notes

            // compute the tapLeafScript from the forfeit script
            const forfeitTapLeafScript = getTapLeafScript(input, this.network);

            // check if the input is an offchain "virtual" coin
            const vtxo = vtxos.find(
                (vtxo) =>
                    vtxo.txid === input.outpoint.txid &&
                    vtxo.vout === input.outpoint.vout
            );
            // boarding utxo, we need to sign the settlement tx
            if (!vtxo) {
                hasBoardingUtxos = true;

                const inputIndexes: number[] = [];
                for (let i = 0; i < settlementPsbt.inputsLength; i++) {
                    const settlementInput = settlementPsbt.getInput(i);

                    if (
                        !settlementInput.txid ||
                        settlementInput.index === undefined
                    ) {
                        throw new Error(
                            "The server returned incomplete data. No settlement input found in the PSBT"
                        );
                    }

                    const inputTxId = hex.encode(settlementInput.txid);
                    if (inputTxId !== input.outpoint.txid) continue;
                    if (settlementInput.index !== input.outpoint.vout) continue;

                    // input found in the settlement tx, sign it
                    settlementPsbt.updateInput(i, {
                        tapLeafScript: [forfeitTapLeafScript],
                    });
                    inputIndexes.push(i);
                }
                settlementPsbt = await this.identity.sign(
                    settlementPsbt,
                    inputIndexes
                );

                continue;
            }

            if (!connectorsTreeValid) {
                // validate that the connectors tree is valid and contains our expected connectors
                validateConnectorsTree(event.roundTx, event.connectors);
                connectorsTreeValid = true;
            }

            const forfeitControlBlock = btc.TaprootControlBlock.encode(
                forfeitTapLeafScript[0]
            );

            const fees = TxWeightEstimator.create()
                .addKeySpendInput() // connector
                .addTapscriptInput(
                    64 * 2, // TODO: handle conditional script
                    forfeitTapLeafScript[1].length,
                    forfeitControlBlock.length
                )
                .addP2WKHOutput()
                .vsize()
                .fee(event.minRelayFeeRate);

            const connectorsLeaves = event.connectors.leaves();
            const connectorOutpoint = event.connectorsIndex.get(
                `${vtxo.txid}:${vtxo.vout}`
            );
            if (!connectorOutpoint) {
                throw new Error("Connector outpoint not found");
            }

            let connectorOutput: TransactionOutput | undefined;
            for (const leaf of connectorsLeaves) {
                if (leaf.txid === connectorOutpoint.txid) {
                    try {
                        const connectorTx = btc.Transaction.fromPSBT(
                            base64.decode(leaf.tx)
                        );
                        connectorOutput = connectorTx.getOutput(
                            connectorOutpoint.vout
                        );
                        break;
                    } catch {
                        throw new Error("Invalid connector tx");
                    }
                }
            }
            if (
                !connectorOutput ||
                !connectorOutput.amount ||
                !connectorOutput.script
            ) {
                throw new Error("Connector output not found");
            }

            let forfeitTx = buildForfeitTx({
                connectorInput: connectorOutpoint,
                connectorAmount: connectorOutput.amount,
                feeAmount: fees,
                serverScript,
                connectorScript: connectorOutput.script,
                vtxoAmount: BigInt(vtxo.value),
                vtxoInput: input.outpoint,
                vtxoScript: ArkAddress.fromTapscripts(
                    hex.decode(infos.pubkey),
                    input.tapscripts,
                    this.network
                ).script,
            });

            // add the tapscript
            forfeitTx.updateInput(1, {
                tapLeafScript: [forfeitTapLeafScript],
            });

            // do not sign the connector input
            forfeitTx = await this.identity.sign(forfeitTx, [1]);

            signedForfeits.push(base64.encode(forfeitTx.toPSBT()));
        }

        await this.arkProvider.submitSignedForfeitTxs(
            signedForfeits,
            hasBoardingUtxos
                ? base64.encode(settlementPsbt.toPSBT())
                : undefined
        );
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

function getTapLeafScript(input: SpendableVtxo, network: Network) {
    const forfeitLeafHash = tapLeafHash(
        hex.decode(input.forfeitScript),
        TAP_LEAF_VERSION
    );
    const taprootTree = btc.taprootListToTree(
        input.tapscripts.map((script) => ({
            script: hex.decode(script),
        }))
    );
    const p2tr = btc.p2tr(
        btc.TAPROOT_UNSPENDABLE_KEY,
        taprootTree,
        network,
        true
    );
    if (!p2tr.leaves || !p2tr.tapLeafScript)
        throw new Error("invalid vtxo tapscripts");

    const tapLeafScriptIndex = p2tr.leaves?.findIndex(
        (leaf) => hex.encode(leaf.hash) === hex.encode(forfeitLeafHash)
    );
    if (tapLeafScriptIndex === -1 || tapLeafScriptIndex === undefined) {
        throw new Error("forfeit tapscript not found in vtxo tapscripts");
    }

    return p2tr.tapLeafScript[tapLeafScriptIndex];
}
