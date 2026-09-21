import { ExtendedCoin, IWallet } from ".";
import { toOffchainInputFeeParams, type NormalizedExtendedVirtualCoin } from "./vtxo";
import { ArkadeInfo, FeeInfo, SettlementEvent } from "../providers/ark";
import { Estimator } from "../arkfee";
import { Address, OutScript } from "@scure/btc-signer";
import { hex } from "@scure/base";
import { networks, NetworkName } from "../networks";
import { ArkAddress } from "../script/address";
import { getDustAmount } from "./utils";

/**
 * Thrown when a collaborative-exit / offboard would leave a change VTXO below
 * the dust threshold. Lets callers (e.g. wallet UI) react with appropriate UX
 * — for instance, offering to exit the full balance — instead of forwarding a
 * server-side dust rejection to the user.
 */
export class DustChangeError extends Error {
    readonly change: bigint;
    readonly dustAmount: bigint;
    constructor(change: bigint, dustAmount: bigint) {
        super(
            `change ${change} sats is below dust threshold ${dustAmount}; ` +
                `consider exiting the full balance`,
        );
        this.name = "DustChangeError";
        this.change = change;
        this.dustAmount = dustAmount;
    }
}

/** Thrown when a collaborative exit's change VTXO is above the server's
 *  per-output ceiling, which arkd answers with `AMOUNT_TOO_HIGH`. */
export class OversizedChangeError extends Error {
    readonly change: bigint;
    readonly maxAmount: bigint;
    constructor(change: bigint, maxAmount: bigint) {
        super(
            `change ${change} sats is above the server's ${maxAmount} sat per-output ` +
                `ceiling; exit more of the balance, or split it into smaller VTXOs first`,
        );
        this.name = "OversizedChangeError";
        this.change = change;
        this.maxAmount = maxAmount;
    }
}

const offboardNetworkNames: NetworkName[] = [
    "bitcoin",
    "regtest",
    "testnet",
    "signet",
    "mutinynet",
];

/**
 * Decode an offboard destination address to its output script, trying each
 * supported network in turn.
 *
 * Exported so the payment router's `onchain` rail can price an offboard against
 * the very script {@link Ramps.offboard} will settle to — a fee program may be
 * script-size dependent, so quoting against anything else would drift.
 *
 * @param destinationAddress - The on-chain address to decode.
 * @returns The output script for the address.
 * @throws Error if the address cannot be decoded on any supported network.
 */
export function offboardDestinationScript(destinationAddress: string): Uint8Array {
    for (const networkName of offboardNetworkNames) {
        try {
            const network = networks[networkName];
            const addr = Address(network).decode(destinationAddress);
            return OutScript.encode(addr);
        } catch {
            // Try next network
            continue;
        }
    }

    throw new Error(`Failed to decode destination address: ${destinationAddress}`);
}

const CHANGE_FEE_MAX_ROUNDS = 8;

/**
 * Settle a change output against the fee charged on its own size — the two define each
 * other, so one subtraction is only right for a flat schedule. Shared because writing it
 * twice is how the unpriced-change bug reached both ramps. `0n` when the fee outruns it.
 */
function settleChangeAgainstFee(change: bigint, feeOn: (amount: bigint) => bigint): bigint {
    let net = change;
    for (let i = 0; i < CHANGE_FEE_MAX_ROUNDS; i++) {
        // Divergence drives `net` negative, and a fee on a negative amount is meaningless.
        const next = change - feeOn(net > 0n ? net : 0n);
        if (next === net) return net > 0n ? net : 0n;
        net = next;
    }
    // Sign-blind: which round a divergence ends on is an accident of the round count.
    throw new Error(
        `change fee does not settle after ${CHANGE_FEE_MAX_ROUNDS} rounds ` +
            `(${change} sats of change); settle the full balance instead`,
    );
}

/** What an exit leaves as change, and what that change output costs. Exported so
 *  the payment router prices an exit with the arithmetic that settles it. */
export function changeAfterOutputFee(
    left: bigint,
    feeOn: (amount: bigint) => bigint,
): { change: bigint; fee: bigint } {
    if (left <= 0n) return { change: 0n, fee: 0n };
    const change = settleChangeAgainstFee(left, feeOn);
    return { change, fee: left - change };
}

/** `logUngatedInputs` is on the concrete wallet, not `IWallet` — probed like `dustAmount`. */
function reportUngatedInputs(wallet: IWallet, inputs: readonly ExtendedCoin[]): void {
    if (!("logUngatedInputs" in wallet)) return;
    const logger = wallet as {
        logUngatedInputs(source: string, inputs: readonly ExtendedCoin[]): Promise<void>;
    };
    void logger.logUngatedInputs("Ramps.offboard({ vtxos })", inputs);
}

/** Price inputs, dropping the uneconomic ones — except from a NAMED set, where
 *  a silent drop would spend a subset of the caller's choice. */
function filterOffboardInputs(
    vtxos: readonly NormalizedExtendedVirtualCoin[],
    feeInfo: FeeInfo,
    named: boolean,
): { inputs: NormalizedExtendedVirtualCoin[]; subtotal: bigint } {
    const estimator = new Estimator(feeInfo?.intentFee ?? {});
    const inputs: NormalizedExtendedVirtualCoin[] = [];
    let subtotal = 0n;

    for (const vtxo of vtxos) {
        const inputFee = estimator.evalOffchainInput(toOffchainInputFeeParams(vtxo));
        if (inputFee.satoshis >= vtxo.value) {
            if (named) {
                throw new Error(
                    `selected vtxo ${vtxo.txid}:${vtxo.vout} costs ${inputFee.satoshis} sats ` +
                        `to spend and is worth ${vtxo.value} — drop it from the selection`,
                );
            }
            continue;
        }
        inputs.push(vtxo);
        subtotal += BigInt(vtxo.value) - BigInt(inputFee.satoshis);
    }

    if (inputs.length === 0) {
        throw new Error("No vtxos available after deducting fees");
    }
    return { inputs, subtotal };
}

/** The server's per-output ceiling, `undefined` on a wallet with no provider
 *  (mocks, watch-only). `-1` is the server's own "no limit" sentinel. */
async function serverVtxoMaxAmount(wallet: IWallet): Promise<bigint | undefined> {
    const provider = (wallet as { arkProvider?: { getInfo(): Promise<ArkadeInfo> } }).arkProvider;
    if (!provider) return undefined;
    return (await provider.getInfo()).vtxoMaxAmount;
}

/** Both bounds on a change VTXO: the dust floor and the per-output ceiling.
 *  Either rejection kills the whole intent, so both are judged here. */
function assertChangeSettleable(
    change: bigint,
    dustAmount: bigint,
    maxAmount: bigint | undefined,
): void {
    if (change === 0n) return;
    if (change < dustAmount) throw new DustChangeError(change, dustAmount);
    if (maxAmount !== undefined && maxAmount >= 0n && change > maxAmount) {
        throw new OversizedChangeError(change, maxAmount);
    }
}

/**
 * Ramps is a class wrapping `settle` method to provide a more convenient interface for onboarding and offboarding operations.
 *
 * @see IWallet.settle
 * @see onboard
 * @see offboard
 *
 * @example
 * ```typescript
 * const ramps = new Ramps(wallet);
 * const feeInfo = { intentFee: {}, txFeeRate: '1' };
 * await ramps.onboard(feeInfo); // onboard all boarding inputs
 * await ramps.offboard('bc1q...', feeInfo); // collaboratively exit all virtual outputs to an onchain address
 * ```
 */
export class Ramps {
    /**
     * Create convenience wrappers for onboarding and offboarding flows.
     *
     * @param wallet - Wallet used to query funds and execute settlement transactions
     */
    constructor(readonly wallet: IWallet) {}

    /**
     * Onboard boarding inputs.
     *
     * @param feeInfo - The fee info to deduct from the onboard amount.
     * @param boardingUtxos - Specific boarding inputs to onboard. If not provided, all boarding inputs will be used.
     * @param amount - Amount to onboard. If not provided, the total amount of boarding inputs will be onboarded.
     * @param eventCallback - Optional callback that receives settlement events
     * @returns The Arkade transaction id created by settlement
     * @throws Error if no boarding inputs remain after fee deduction or if `amount` exceeds available value
     * @see IWallet.getBoardingUtxos
     * @see IWallet.settle
     * @example
     * ```typescript
     * const feeInfo = { intentFee: {}, txFeeRate: '1' };
     * const ramps = new Ramps(wallet);
     * await ramps.onboard(feeInfo);
     * ```
     */
    async onboard(
        feeInfo: FeeInfo,
        boardingUtxos?: ExtendedCoin[],
        amount?: bigint,
        eventCallback?: (event: SettlementEvent) => void,
    ): ReturnType<IWallet["settle"]> {
        boardingUtxos = boardingUtxos ?? (await this.wallet.getBoardingUtxos());

        // Calculate input fees and filter out boarding inputs where fee >= value.
        const estimator = new Estimator(feeInfo?.intentFee ?? {});
        const filteredBoardingUtxos: ExtendedCoin[] = [];
        let totalAmount = 0n;

        for (const utxo of boardingUtxos) {
            const inputFee = estimator.evalOnchainInput({
                amount: BigInt(utxo.value),
            });
            if (inputFee.satoshis >= utxo.value) {
                // Skip boarding inputs where spending fees are greater than or equal to the input value.
                continue;
            }

            filteredBoardingUtxos.push(utxo);
            totalAmount += BigInt(utxo.value) - BigInt(inputFee.satoshis);
        }

        if (filteredBoardingUtxos.length === 0) {
            throw new Error("No boarding utxos available after deducting fees");
        }

        let change = 0n;
        if (amount) {
            if (amount > totalAmount) {
                throw new Error("Amount is greater than total amount of boarding utxos after fees");
            }
            change = totalAmount - amount;
        }

        // Change goes to a BOARDING address, which `settle` classifies as an ONCHAIN output.
        let boardingAddress: string | undefined;
        if (change > 0n) {
            boardingAddress = await this.wallet.getBoardingAddress();
            const changeScript = hex.encode(offboardDestinationScript(boardingAddress));
            change = settleChangeAgainstFee(change, (amt) =>
                BigInt(estimator.evalOnchainOutput({ amount: amt, script: changeScript }).satoshis),
            );
            // Post-fee, as `offboard`: arkd's sub-dust exception covers OP_RETURN VTXO
            // outputs, not a boarding one, so below the floor it is rejected server-side.
            const dustAmount = getDustAmount(this.wallet);
            if (change > 0n && change < dustAmount) {
                throw new DustChangeError(change, dustAmount);
            }
        }

        amount = amount ?? totalAmount;

        // Calculate offchain output fee using Estimator
        const offchainAddress = await this.wallet.getAddress();
        const offchainAddr = ArkAddress.decode(offchainAddress);
        const offchainScript = hex.encode(offchainAddr.pkScript);

        const outputFee = estimator.evalOffchainOutput({
            amount,
            script: offchainScript,
        });

        if (BigInt(outputFee.satoshis) > amount) {
            throw new Error(
                `can't deduct fees from onboard amount (${outputFee.satoshis} > ${amount})`,
            );
        }
        amount -= BigInt(outputFee.satoshis);

        const outputs = [
            {
                address: offchainAddress,
                amount,
            },
        ];

        if (change > 0n) {
            outputs.push({
                address: boardingAddress!,
                amount: change,
            });
        }

        return this.wallet.settle(
            {
                inputs: filteredBoardingUtxos,
                outputs,
            },
            eventCallback,
        );
    }

    /**
     * Offboard virtual outputs, or collaboratively exit them to an onchain address.
     *
     * @param destinationAddress - The destination address to offboard to.
     * @param feeInfo - The fee info to deduct from the offboard amount.
     * @param amount - The amount to offboard. If not provided, the total amount of virtual outputs will be offboarded.
     * @param eventCallback - Optional callback that receives settlement events
     * @param vtxos - Specific virtual outputs to spend, mirroring {@link onboard}'s
     * `boardingUtxos`. Omitted, every spendable one is spent — merging the whole
     * off-chain balance into a single change output. Taken as given like
     * `settle({ inputs })`: an `amount` these cannot cover is an error, not a top-up.
     * @returns The Arkade transaction id created by settlement
     * @throws Error if no virtual outputs remain after fee deduction or the destination address cannot be decoded
     * @see IWallet.getSpendableVtxos
     * @see IWallet.settle
     * @example
     * ```typescript
     * const feeInfo = { intentFee: {}, txFeeRate: '1' };
     * const ramps = new Ramps(wallet);
     * await ramps.offboard('bc1q...', feeInfo);
     * ```
     */
    async offboard(
        destinationAddress: string,
        feeInfo: FeeInfo,
        amount?: bigint,
        eventCallback?: (event: SettlementEvent) => void,
        vtxos?: NormalizedExtendedVirtualCoin[],
    ): ReturnType<IWallet["settle"]> {
        const named = vtxos !== undefined;
        if (vtxos) reportUngatedInputs(this.wallet, vtxos);
        const spendable =
            vtxos ??
            (await this.wallet.getSpendableVtxos({
                withRecoverable: true,
                withUnrolled: false,
            }));

        const estimator = new Estimator(feeInfo?.intentFee ?? {});
        const { inputs, subtotal } = filterOffboardInputs(spendable, feeInfo, named);

        if (amount && amount > subtotal) {
            throw new Error("Amount is greater than total amount of vtxos after fees");
        }
        const handed = amount || subtotal;

        // The change is an offchain output charged on its own size, so fee and amount define
        // each other. Unpaid, the outputs outclaim the inputs and arkd rejects the settlement.
        const { change, changeAddress } = await this.fundChange(
            amount ? subtotal - handed : 0n,
            estimator,
        );

        const outputFee = estimator.evalOnchainOutput({
            amount: handed,
            script: hex.encode(offboardDestinationScript(destinationAddress)),
        });
        if (BigInt(outputFee.satoshis) > handed) {
            throw new Error(
                `can't deduct fees from offboard amount (${outputFee.satoshis} > ${handed})`,
            );
        }

        const outputs = [
            { address: destinationAddress, amount: handed - BigInt(outputFee.satoshis) },
        ];
        if (change > 0n) outputs.push({ address: changeAddress!, amount: change });
        return this.wallet.settle({ inputs, outputs }, eventCallback);
    }

    /**
     * Collaboratively exit with the DESTINATION paid exactly `amount`, pricing the
     * fee on that output rather than on a grossed-up figure. {@link offboard} keeps
     * the other anchor, which needs `g - fee(g) = amount` solved — impossible for
     * a program charging the whole output.
     */
    async offboardExact(params: {
        destinationAddress: string;
        feeInfo: FeeInfo;
        /** Sats the destination receives, exactly. */
        amount: bigint;
        eventCallback?: (event: SettlementEvent) => void;
        vtxos?: NormalizedExtendedVirtualCoin[];
    }): ReturnType<IWallet["settle"]> {
        const { destinationAddress, feeInfo, amount, eventCallback, vtxos } = params;
        if (amount <= 0n) {
            throw new Error(`offboard amount must be positive, got ${amount}`);
        }

        const named = vtxos !== undefined;
        if (vtxos) reportUngatedInputs(this.wallet, vtxos);
        const spendable =
            vtxos ??
            (await this.wallet.getSpendableVtxos({
                withRecoverable: true,
                withUnrolled: false,
            }));

        const estimator = new Estimator(feeInfo?.intentFee ?? {});
        const { inputs, subtotal } = filterOffboardInputs(spendable, feeInfo, named);

        const outputFee = BigInt(
            estimator.evalOnchainOutput({
                amount,
                script: hex.encode(offboardDestinationScript(destinationAddress)),
            }).satoshis,
        );
        const needed = amount + outputFee;
        if (needed > subtotal) {
            throw new Error(
                `selected vtxos net ${subtotal} sats, ${needed} needed to deliver ${amount} ` +
                    `exactly (${amount} + a ${outputFee} sat exit fee)`,
            );
        }

        const { change, changeAddress } = await this.fundChange(subtotal - needed, estimator);

        const outputs = [{ address: destinationAddress, amount }];
        if (change > 0n) outputs.push({ address: changeAddress!, amount: change });
        return this.wallet.settle({ inputs, outputs }, eventCallback);
    }

    /** Fund the change output: pay its own fee, then judge it against both
     *  server-side bounds. `0n` in is `0n` out — no change output at all. */
    private async fundChange(
        left: bigint,
        estimator: Estimator,
    ): Promise<{ change: bigint; changeAddress?: string }> {
        if (left <= 0n) return { change: 0n };

        const changeAddress = await this.wallet.getAddress();
        const changeScript = hex.encode(ArkAddress.decode(changeAddress).pkScript);
        const { change } = changeAfterOutputFee(left, (amount) =>
            BigInt(estimator.evalOffchainOutput({ amount, script: changeScript }).satoshis),
        );

        assertChangeSettleable(
            change,
            getDustAmount(this.wallet),
            await serverVtxoMaxAmount(this.wallet),
        );
        return { change, changeAddress };
    }
}
