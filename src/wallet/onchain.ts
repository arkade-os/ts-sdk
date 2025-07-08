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

/**
 * Onchain Bitcoin wallet implementation for traditional Bitcoin transactions.
 *
 * This wallet handles regular Bitcoin transactions on the blockchain without
 * using the Ark protocol. It supports P2TR (Pay-to-Taproot) addresses and
 * provides basic Bitcoin wallet functionality.
 *
 * @example
 * ```typescript
 * const wallet = new OnchainWallet(identity, 'mainnet');
 * const balance = await wallet.getBalance();
 * const txid = await wallet.send({
 *   address: 'bc1...',
 *   amount: 50000
 * });
 * ```
 */
export class OnchainWallet {
    static FEE_RATE = 1; // sats/vbyte
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
        const feeRate = params.feeRate || OnchainWallet.FEE_RATE;

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
}

/**
 * Select coins to reach a target amount, prioritizing those closer to expiry
 * @param coins List of coins to select from
 * @param targetAmount Target amount to reach in satoshis
 * @returns Selected coins and change amount, or null if insufficient funds
 */
function selectCoins(
    coins: Coin[],
    targetAmount: number
): {
    inputs: Coin[] | null;
    changeAmount: number;
} {
    // Sort coins by amount (descending)
    const sortedCoins = [...coins].sort((a, b) => b.value - a.value);

    const selectedCoins: Coin[] = [];
    let selectedAmount = 0;

    // Select coins until we have enough
    for (const coin of sortedCoins) {
        selectedCoins.push(coin);
        selectedAmount += coin.value;

        if (selectedAmount >= targetAmount) {
            break;
        }
    }

    // Check if we have enough
    if (selectedAmount < targetAmount) {
        return { inputs: null, changeAmount: 0 };
    }

    // Calculate change
    const changeAmount = selectedAmount - targetAmount;

    return {
        inputs: selectedCoins,
        changeAmount,
    };
}
