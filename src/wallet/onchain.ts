import { p2tr, P2TR } from "@scure/btc-signer/payment";
import { Coin, SendBitcoinParams } from ".";
import { Identity } from "../identity";
import { getNetwork, Network, NetworkName } from "../networks";
import {
    ESPLORA_URL,
    EsploraProvider,
    OnchainProvider,
} from "../providers/onchain";
import { Transaction } from "@scure/btc-signer";
import { selectCoins } from "../utils/coinselect";
import { AnchorBumper, findP2AOutput, P2A } from "../utils/anchor";
import { TxWeightEstimator } from "../utils/txSizeEstimator";

export class OnchainWallet implements AnchorBumper {
    static DUST_AMOUNT = 546; // sats

    private onchainP2TR: P2TR;
    private provider: OnchainProvider;
    private network: Network;

    constructor(
        private identity: Identity,
        network: NetworkName,
        provider?: OnchainProvider
    ) {
        const pubkey = identity.xOnlyPublicKey();
        if (!pubkey) {
            throw new Error("Invalid configured public key");
        }

        this.provider = provider || new EsploraProvider(ESPLORA_URL[network]);
        this.network = getNetwork(network);
        this.onchainP2TR = p2tr(pubkey, undefined, this.network);
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

        const coins = await this.getCoins();
        let feeRate = params.feeRate;
        if (!feeRate) {
            feeRate = await this.provider.getFeeRate();
        }

        // Ensure fee is an integer by rounding up
        const estimatedFee = Math.ceil(174 * feeRate);
        const totalNeeded = params.amount + estimatedFee;

        // Select coins
        const selected = selectCoins(coins, totalNeeded);
        if (!selected.inputs) {
            throw new Error("Insufficient funds");
        }

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
        if (selected.changeAmount > 0) {
            tx.addOutputAddress(
                this.address,
                BigInt(selected.changeAmount),
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
            allowUnknownInputs: true,
            allowLegacyWitnessUtxo: true,
            version: 3,
        });
        child.addInput(findP2AOutput(parent)); // throws if not found

        const childVsize = TxWeightEstimator.create()
            .addKeySpendInput(true)
            .addP2AInput()
            .addP2TROutput()
            .vsize().value;

        const packageVSize = parentVsize + Number(childVsize);

        const feeRate = await this.provider.getFeeRate();
        const fee = Math.ceil(feeRate * packageVSize);

        // Select coins
        let selected = selectCoins(await this.getCoins(), fee);
        if (!selected.inputs) {
            throw new Error(
                `Insufficient funds to pay for the package, needed ${fee} sats, got ${await this.getBalance()} sats`
            );
        }

        // ensure we have a change
        let change = BigInt(selected.changeAmount);
        if (change == 0n) {
            selected = selectCoins(await this.getCoins(), fee + 600);
            if (!selected.inputs) {
                throw new Error("Insufficient funds to pay for the package");
            }
            change = BigInt(selected.changeAmount) + 600n;
        }

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

        child.addOutputAddress(this.address, P2A.amount + change, this.network);

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
