import { p2tr, TaprootControlBlock } from "@scure/btc-signer";
import { P2TR } from "@scure/btc-signer/payment.js";
import { Coin, ExtendedCoin, SendBitcoinParams } from ".";
import { Identity, SingleKey } from "../identity";
import { getNetwork, Network, NetworkName } from "../networks";
import {
    ESPLORA_URL,
    EsploraProvider,
    OnchainProvider,
} from "../providers/onchain";
import { AnchorBumper, findP2AOutput, P2A } from "../utils/anchor";
import { TxWeightEstimator } from "../utils/txSizeEstimator";
import { Transaction } from "../utils/transaction";
import { extendCoin } from "./utils";
import { VtxoScript } from "../script/base";
import { hex } from "@scure/base";
import {
    ConditionCSVMultisigTapscript,
    CSVMultisigTapscript,
} from "../script/tapscript";
import { BlockTime } from "./unroll";
import { Wallet } from "./wallet";

/**
 * Onchain Bitcoin wallet implementation for traditional Bitcoin transactions.
 *
 * This wallet handles regular Bitcoin transactions on the blockchain without
 * using the Ark protocol. It supports P2TR (Pay-to-Taproot) addresses and
 * provides basic Bitcoin wallet functionality.
 *
 * @example
 * ```typescript
 * const wallet = await OnchainWallet.create(identity, 'mainnet');
 * const balance = await wallet.getBalance();
 * const txid = await wallet.send({
 *   address: 'bc1...',
 *   amount: 50000
 * });
 * ```
 */
export class OnchainWallet implements AnchorBumper {
    static MIN_FEE_RATE = 1; // sat/vbyte
    static DUST_AMOUNT = 546; // sats

    readonly onchainP2TR: P2TR;
    readonly provider: OnchainProvider;
    readonly network: Network;

    private constructor(
        private identity: Identity,
        network: Network,
        onchainP2TR: P2TR,
        provider: OnchainProvider
    ) {
        this.network = network;
        this.onchainP2TR = onchainP2TR;
        this.provider = provider;
    }

    static async create(
        identity: Identity,
        networkName: NetworkName,
        provider?: OnchainProvider
    ): Promise<OnchainWallet> {
        const pubkey = await identity.xOnlyPublicKey();
        if (!pubkey) {
            throw new Error("Invalid configured public key");
        }

        const network = getNetwork(networkName);
        const onchainProvider =
            provider || new EsploraProvider(ESPLORA_URL[networkName]);
        const onchainP2TR = p2tr(pubkey, undefined, network);

        return new OnchainWallet(
            identity,
            network,
            onchainP2TR,
            onchainProvider
        );
    }

    get address(): string {
        return this.onchainP2TR.address || "";
    }

    async getCoins(): Promise<Coin[]> {
        return this.provider.getCoins(this.address);
    }

    async getBalance(): Promise<number> {
        const coins = await this.getCoins();
        const onchainConfirmed = coins
            .filter((coin) => coin.status.confirmed)
            .reduce((sum, coin) => sum + coin.value, 0);
        const onchainUnconfirmed = coins
            .filter((coin) => !coin.status.confirmed)
            .reduce((sum, coin) => sum + coin.value, 0);
        const onchainTotal = onchainConfirmed + onchainUnconfirmed;
        return onchainTotal;
    }

    async send(params: SendBitcoinParams): Promise<string> {
        if (params.amount <= 0) {
            throw new Error("Amount must be positive");
        }
        if (params.amount < OnchainWallet.DUST_AMOUNT) {
            throw new Error("Amount is below dust limit");
        }

        const chainTip = await this.provider.getChainTip();

        const coins = await this.getCoins();
        let feeRate = params.feeRate;
        if (!feeRate) {
            feeRate = await this.provider.getFeeRate();
        }

        if (!feeRate || feeRate < OnchainWallet.MIN_FEE_RATE) {
            feeRate = OnchainWallet.MIN_FEE_RATE;
        }

        const txWeightEstimator = TxWeightEstimator.create();

        // TODO: import ark wallet or find another way to create utxo from coin
        const arkWallet = await Wallet.create({
            identity: this.identity,
            arkServerUrl: "http://localhost:7070",
            onchainProvider: this.provider,
        });

        for (const coin of coins) {
            const utxo = extendCoin(arkWallet, coin);

            const txStatus = await this.provider.getTxStatus(utxo.txid);
            if (!txStatus.confirmed) {
                throw new Error(`tx ${utxo.txid} is not confirmed`);
            }

            const exit = availableUtxoExitPath(
                { height: txStatus.blockHeight, time: txStatus.blockTime },
                chainTip,
                utxo
            );
            if (!exit) {
                throw new Error(
                    `no available exit path found for utxo ${utxo.txid}:${utxo.vout}`
                );
            }

            const spendingLeaf = VtxoScript.decode(utxo.tapTree).findLeaf(
                hex.encode(exit.script)
            );
            if (!spendingLeaf) {
                throw new Error(
                    `spending leaf not found for utxo ${utxo.txid}:${utxo.vout}`
                );
            }

            txWeightEstimator.addTapscriptInput(
                64,
                spendingLeaf[1].length,
                TaprootControlBlock.encode(spendingLeaf[0]).length
            );
        }

        txWeightEstimator.addP2TROutput();

        // Ensure fee is an integer by rounding up
        const estimatedFee = txWeightEstimator.vsize().fee(BigInt(feeRate));
        const totalNeeded = Math.ceil(params.amount + Number(estimatedFee));

        // Select coins
        const selected = selectCoins(coins, totalNeeded);

        // Create transaction
        let tx = new Transaction();

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
            });
        }

        // Add payment output
        tx.addOutputAddress(
            params.address,
            BigInt(params.amount),
            this.network
        );
        // Add change output if needed
        if (selected.changeAmount > 0n) {
            tx.addOutputAddress(
                this.address,
                selected.changeAmount,
                this.network
            );
        }

        // Sign inputs and Finalize
        tx = await this.identity.sign(tx);
        tx.finalize();

        // Broadcast
        const txid = await this.provider.broadcastTransaction(tx.hex);
        return txid;
    }

    async bumpP2A(parent: Transaction): Promise<[string, string]> {
        const parentVsize = parent.vsize;

        let child = new Transaction({
            version: 3,
            allowLegacyWitnessUtxo: true,
        });
        child.addInput(findP2AOutput(parent)); // throws if not found

        const childVsize = TxWeightEstimator.create()
            .addKeySpendInput(true)
            .addP2AInput()
            .addP2TROutput()
            .vsize().value;

        const packageVSize = parentVsize + Number(childVsize);

        let feeRate = await this.provider.getFeeRate();
        if (!feeRate || feeRate < OnchainWallet.MIN_FEE_RATE) {
            feeRate = OnchainWallet.MIN_FEE_RATE;
        }
        const fee = Math.ceil(feeRate * packageVSize);
        if (!fee) {
            throw new Error(
                `invalid fee, got ${fee} with vsize ${packageVSize}, feeRate ${feeRate}`
            );
        }

        // Select coins
        const coins = await this.getCoins();
        const selected = selectCoins(coins, fee, true);

        for (const input of selected.inputs) {
            child.addInput({
                txid: input.txid,
                index: input.vout,
                witnessUtxo: {
                    script: this.onchainP2TR.script,
                    amount: BigInt(input.value),
                },
                tapInternalKey: this.onchainP2TR.tapInternalKey,
            });
        }

        child.addOutputAddress(
            this.address,
            P2A.amount + selected.changeAmount,
            this.network
        );

        // Sign inputs and Finalize
        child = await this.identity.sign(child);
        for (let i = 1; i < child.inputsLength; i++) {
            child.finalizeIdx(i);
        }

        try {
            await this.provider.broadcastTransaction(parent.hex, child.hex);
        } catch (error) {
            console.error(error);
        } finally {
            return [parent.hex, child.hex];
        }
    }
}

/**
 * Select coins to reach a target amount, prioritizing those closer to expiry
 * @param coins List of coins to select from
 * @param targetAmount Target amount to reach in satoshis
 * @param forceChange If true, ensure the coin selection will require a change output
 * @returns Selected coins and change amount, or null if insufficient funds
 */
export function selectCoins(
    coins: Coin[],
    targetAmount: number,
    forceChange: boolean = false
): {
    inputs: Coin[];
    changeAmount: bigint;
} {
    if (isNaN(targetAmount)) {
        throw new Error("Target amount is NaN, got " + targetAmount);
    }

    if (targetAmount < 0) {
        throw new Error("Target amount is negative, got " + targetAmount);
    }

    if (targetAmount === 0) {
        return { inputs: [], changeAmount: 0n };
    }

    // Sort coins by amount (descending)
    const sortedCoins = [...coins].sort((a, b) => b.value - a.value);

    const selectedCoins: Coin[] = [];
    let selectedAmount = 0;

    // Select coins until we have enough
    for (const coin of sortedCoins) {
        selectedCoins.push(coin);
        selectedAmount += coin.value;

        if (
            forceChange
                ? selectedAmount > targetAmount
                : selectedAmount >= targetAmount
        ) {
            break;
        }
    }

    if (selectedAmount === targetAmount) {
        return { inputs: selectedCoins, changeAmount: 0n };
    }

    if (selectedAmount < targetAmount) {
        throw new Error("Insufficient funds");
    }

    const changeAmount = BigInt(selectedAmount - targetAmount);

    return {
        inputs: selectedCoins,
        changeAmount,
    };
}

function availableUtxoExitPath(
    confirmedAt: BlockTime,
    current: BlockTime,
    utxo: ExtendedCoin
): CSVMultisigTapscript.Type | ConditionCSVMultisigTapscript.Type | undefined {
    const exits = VtxoScript.decode(utxo.tapTree).exitPaths();
    for (const exit of exits) {
        if (exit.params.timelock.type === "blocks") {
            if (
                current.height >=
                confirmedAt.height + Number(exit.params.timelock.value)
            ) {
                return exit;
            }
        } else {
            if (
                current.time >=
                confirmedAt.time + Number(exit.params.timelock.value)
            ) {
                return exit;
            }
        }
    }

    return undefined;
}
