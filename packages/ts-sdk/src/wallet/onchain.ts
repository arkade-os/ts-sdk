import { p2tr } from "@scure/btc-signer";
import { P2TR } from "@scure/btc-signer/payment.js";
import { hex } from "@scure/base";
import { Coin, SendBitcoinParams } from ".";
import { Identity } from "../identity";
import { DEFAULT_NETWORK_NAME, getNetwork, Network, NetworkName } from "../networks";
import { ESPLORA_URL, EsploraProvider, OnchainProvider } from "../providers/onchain";
import { AnchorBumper, buildAnchorChild } from "../utils/anchor";
import { TxWeightEstimator } from "../utils/txSizeEstimator";
import { Transaction } from "../utils/transaction";
import { DUST_AMOUNT } from "./utils";

/**
 * Onchain Bitcoin wallet implementation for traditional Bitcoin transactions.
 *
 * This wallet handles regular Bitcoin transactions on the blockchain without
 * using the Arkade protocol. It supports P2TR (Pay-to-Taproot) addresses and
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
        provider: OnchainProvider,
    ) {
        this.network = network;
        this.onchainP2TR = onchainP2TR;
        this.provider = provider;
    }

    /**
     * Create an onchain wallet for the given identity and Bitcoin network.
     *
     * @param identity - Identity used to derive the Taproot key and sign transactions
     * @param networkName - Bitcoin network name, @see NetworkName
     * @param provider - Optional onchain provider override, @see OnchainProvider
     * @returns Configured onchain wallet
     * @throws Error if the configured identity cannot produce a valid x-only public key
     */
    static async create(
        identity: Identity,
        networkName: NetworkName = DEFAULT_NETWORK_NAME,
        provider?: OnchainProvider,
    ): Promise<OnchainWallet> {
        const pubkey = await identity.xOnlyPublicKey();
        if (!pubkey) {
            throw new Error("Invalid configured public key");
        }

        const network = getNetwork(networkName);
        const onchainProvider = provider || new EsploraProvider(ESPLORA_URL[networkName]);
        const onchainP2TR = p2tr(pubkey, undefined, network);

        return new OnchainWallet(identity, network, onchainP2TR, onchainProvider);
    }

    get address(): string {
        return this.onchainP2TR.address || "";
    }

    /**
     * Fetch spendable onchain outputs for the wallet address.
     *
     * @returns Spendable onchain outputs for the wallet address
     * @see getBalance
     */
    async getCoins(): Promise<Coin[]> {
        return this.provider.getCoins(this.address);
    }

    /**
     * Return the wallet's total onchain balance in satoshis.
     *
     * @returns Confirmed plus unconfirmed onchain balance
     * @see getCoins
     */
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

    /**
     * Iteratively selects coins and estimates transaction fees until convergence.
     *
     * This method handles the circular dependency between output selection and fee
     * estimation: the fee depends on transaction size, which depends on the number
     * of inputs (selected outputs) and whether a change output is needed.
     *
     * The algorithm iterates up to 10 times, refining the fee estimate based on
     * the actual transaction structure. It resolves dust oscillation loops that
     * occur when the change amount hovers near the dust threshold—adding/removing
     * the change output causes the fee to fluctuate, preventing convergence.
     * When a lower fee is computed (indicating the change output was dropped),
     * the function accepts this state to guarantee termination.
     *
     * @param coins - Available onchain outputs to select from
     * @param amount - Target send amount in satoshis
     * @param feeRate - Fee rate in sat/vbyte
     * @param recipientAddress - Destination address for size estimation
     * @returns Selected inputs, change amount, and calculated fee
     * @throws Error if fee estimation fails to converge within max iterations
     */
    private estimateFeesAndSelectCoins(
        coins: Coin[],
        amount: number,
        feeRate: number,
        recipientAddress: string,
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

            // Prevent oscillation loops when change falls just below the dust limit.
            // If removing the change output reduces the fee below our budget,
            // we accept the valid transaction state to guarantee convergence.
            if (roundedNewFee <= fee) {
                return { ...selected, fee: roundedNewFee };
            }

            fee = roundedNewFee;
        }

        throw new Error("Fee estimation failed: could not converge");
    }

    /**
     * Send bitcoin to a single onchain address.
     *
     * @param params - destination `address`, `amount` (in satoshis), and optional `feeRate` override (other fields ignored)
     * @returns Broadcast transaction id
     * @throws Error if the amount is non-positive, below dust, or cannot be funded
     * @see SendBitcoinParams
     */
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
            params.address,
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
        tx.addOutputAddress(params.address, BigInt(params.amount), this.network);

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

    /**
     * CPFP-bump a parent transaction that contains a pay-to-anchor output.
     *
     * @param parent - Parent transaction containing a pay-to-anchor output
     * @returns Tuple of parent transaction id and child transaction id
     * @throws Error if the parent transaction has no pay-to-anchor output or bumping cannot be funded
     * @see send
     */
    async bumpP2A(parent: Transaction): Promise<[string, string]> {
        let feeRate = await this.provider.getFeeRate();
        if (!feeRate || feeRate < OnchainWallet.MIN_FEE_RATE) {
            feeRate = OnchainWallet.MIN_FEE_RATE;
        }

        const child = await this.buildBumpPackage(parent, feeRate, await this.getCoins());

        try {
            await this.provider.broadcastTransaction(parent.hex, child.hex);
        } catch (error) {
            console.error(error);
        } finally {
            return [parent.hex, child.hex];
        }
    }

    /**
     * Build and sign a CPFP fee child for a parent tx (given as raw hex)
     * carrying a P2A anchor, funding it from this wallet's **confirmed**
     * coins, and return the 1P1C package hexes WITHOUT broadcasting.
     *
     * This is the graph-mode fee source ({@link ExitFeeWallet}): the exit
     * executor calls it to bump each transported virtual tx at execution
     * time, so funding can be deferred rather than pre-signed.
     *
     * @param parentHex - Finalized parent transaction, raw network hex
     * @param feeRate - sat/vB floor for the package (raised to MIN_FEE_RATE)
     * @returns Tuple of parent hex (unchanged) and signed child hex
     * @throws If the parent has no anchor, or funding cannot be selected/signed
     */
    async bumpAnchor(parentHex: string, feeRate: number): Promise<[string, string]> {
        const parent = Transaction.fromRaw(hex.decode(parentHex));
        // A CPFP fee input must be confirmed: an unconfirmed one would make
        // the child depend on two unconfirmed ancestors, breaking 1P1C relay.
        const coins = (await this.getCoins()).filter((c) => c.status.confirmed);
        const child = await this.buildBumpPackage(parent, feeRate, coins);
        return [parent.hex, child.hex];
    }

    /**
     * Shared core of {@link bumpP2A} and {@link bumpAnchor}: probe the package
     * fee with a single-input child, select coins for it, then build and sign
     * with the actual selection (the fee grows per extra input).
     */
    private async buildBumpPackage(
        parent: Transaction,
        feeRate: number,
        coins: Coin[],
    ): Promise<Transaction> {
        let rate = feeRate;
        if (!rate || rate < OnchainWallet.MIN_FEE_RATE) {
            rate = OnchainWallet.MIN_FEE_RATE;
        }

        const probeVsize = TxWeightEstimator.create()
            .addKeySpendInput(true)
            .addP2AInput()
            .addOutputAddress(this.address, this.network)
            .vsize().value;
        const probeFee = Math.ceil(rate * (parent.vsize + Number(probeVsize)));
        if (!probeFee) {
            throw new Error(
                `invalid fee, got ${probeFee} with vsize ${parent.vsize + Number(probeVsize)}, feeRate ${rate}`,
            );
        }

        const selected = selectCoins(coins, probeFee, true);

        const { child } = buildAnchorChild({
            parent,
            feeRate: rate,
            fundingCoins: selected.inputs,
            changeAddress: this.address,
            changeScript: this.onchainP2TR.script,
            tapInternalKey: this.onchainP2TR.tapInternalKey,
            network: this.network,
        });

        // Sign inputs and finalize everything except the keyless P2A anchor.
        const signed = await this.identity.sign(child);
        for (let i = 1; i < signed.inputsLength; i++) {
            signed.finalizeIdx(i);
        }
        return signed;
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
    forceChange: boolean = false,
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

        if (forceChange ? selectedAmount > targetAmount : selectedAmount >= targetAmount) {
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
