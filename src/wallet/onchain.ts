import { p2tr } from "@scure/btc-signer";
import { P2TR } from "@scure/btc-signer/payment.js";
import { Coin, SendBitcoinParams } from ".";
import { Identity } from "../identity";
import { getNetwork, Network, NetworkName } from "../networks";
import {
    ESPLORA_URL,
    EsploraProvider,
    OnchainProvider,
} from "../providers/onchain";
import { AnchorBumper, findP2AOutput, P2A } from "../utils/anchor";
import { TxWeightEstimator } from "../utils/txSizeEstimator";
import { Transaction } from "../utils/transaction";
import { DUST_AMOUNT } from "./utils";

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

    private estimateFeesAndSelectCoins(
        coins: Coin[],
        amount: number,
        feeRate: number,
        recipientAddress: string
    ): { inputs: Coin[]; changeAmount: bigint; fee: number } {
        const MAX_ITERATIONS = 10;
        let fee = 0;

        for (let i = 0; i < MAX_ITERATIONS; i++) {
            const totalNeeded = amount + fee;

            const selected = selectCoins(coins, totalNeeded);

            const estimator = TxWeightEstimator.create();

            for (const _ of selected.inputs) {
                estimator.addKeySpendInput();
            }

            estimator.addOutputAddress(recipientAddress, this.network);

            if (selected.changeAmount >= BigInt(DUST_AMOUNT)) {
                estimator.addOutputAddress(this.address, this.network);
            }

            const newFee = Number(estimator.vsize().value) * feeRate;
            const roundedNewFee = Math.ceil(newFee);

            if (roundedNewFee <= fee) {
                return { ...selected, fee: roundedNewFee };
            }

            fee = roundedNewFee;
        }

        throw new Error("Fee estimation failed: could not converge");
    }

    async send(params: SendBitcoinParams): Promise<string> {
        if (params.amount <= 0) {
            throw new Error("Amount must be positive");
        }
        if (params.amount < DUST_AMOUNT) {
            throw new Error("Amount is below dust limit");
        }

        const coins = await this.getCoins();
        let feeRate = params.feeRate;
        if (!feeRate) {
            feeRate = await this.provider.getFeeRate();
        }

        if (!feeRate || feeRate < OnchainWallet.MIN_FEE_RATE) {
            feeRate = OnchainWallet.MIN_FEE_RATE;
        }

        const { inputs, changeAmount } = this.estimateFeesAndSelectCoins(
            coins,
            params.amount,
            feeRate,
            params.address
        );

        if (!inputs) {
            throw new Error("Fee estimation failed");
        }

        // Create transaction
        let tx = new Transaction();

        // Add inputs
        for (const input of inputs) {
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

        // Prevent oscillation loops when change falls just below the dust limit.
        // If removing the change output reduces the fee below our budget,
        // we accept the valid transaction state to guarantee convergence.
        if (changeAmount >= BigInt(DUST_AMOUNT)) {
            tx.addOutputAddress(this.address, changeAmount, this.network);
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
            .addOutputAddress(this.address, this.network)
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
