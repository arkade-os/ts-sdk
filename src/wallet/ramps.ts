import { ExtendedCoin, IWallet } from ".";
import { FeeInfo, SettlementEvent } from "../providers/ark";
import { Estimator } from "../arkfee";
import { Address, OutScript } from "@scure/btc-signer";
import { hex } from "@scure/base";
import { networks, NetworkName } from "../networks";
import { ArkAddress } from "../script/address";

/**
 * Ramps is a class wrapping IWallet.settle method to provide a more convenient interface for onboarding and offboarding operations.
 *
 * @example
 * ```typescript
 * const ramps = new Ramps(wallet);
 * await ramps.onboard(); // onboard all boarding utxos
 * await ramps.offboard(myOnchainAddress); // collaborative exit all vtxos to onchain address
 * ```
 */
export class Ramps {
    constructor(readonly wallet: IWallet) {}

    /**
     * Onboard boarding utxos.
     *
     * @param feeInfo - The fee info to deduct from the onboard amount.
     * @param boardingUtxos - The boarding utxos to onboard. If not provided, all boarding utxos will be used.
     * @param amount - The amount to onboard. If not provided, the total amount of boarding utxos will be onboarded.
     * @param eventCallback - The callback to receive settlement events. optional.
     */
    async onboard(
        feeInfo: FeeInfo,
        boardingUtxos?: ExtendedCoin[],
        amount?: bigint,
        eventCallback?: (event: SettlementEvent) => void
    ): ReturnType<IWallet["settle"]> {
        boardingUtxos = boardingUtxos ?? (await this.wallet.getBoardingUtxos());

        // Calculate input fees and filter out utxos where fee >= value
        const estimator = new Estimator(feeInfo?.intentFee ?? {});
        const filteredBoardingUtxos: ExtendedCoin[] = [];
        let totalAmount = 0n;

        for (const utxo of boardingUtxos) {
            const inputFee = estimator.evalOnchainInput({
                amount: BigInt(utxo.value),
            });
            if (inputFee.satoshis >= utxo.value) {
                // skip if fees are greater than or equal to the utxo value
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
                throw new Error(
                    "Amount is greater than total amount of boarding utxos after fees"
                );
            }
            change = totalAmount - amount;
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
                `can't deduct fees from onboard amount (${outputFee.satoshis} > ${amount})`
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
            const boardingAddress = await this.wallet.getBoardingAddress();
            outputs.push({
                address: boardingAddress,
                amount: change,
            });
        }

        return this.wallet.settle(
            {
                inputs: filteredBoardingUtxos,
                outputs,
            },
            eventCallback
        );
    }

    /**
     * Offboard vtxos, or "collaborative exit" vtxos to onchain address.
     *
     * @param destinationAddress - The destination address to offboard to.
     * @param feeInfo - The fee info to deduct from the offboard amount.
     * @param amount - The amount to offboard. If not provided, the total amount of vtxos will be offboarded.
     * @param eventCallback - The callback to receive settlement events. optional.
     */
    async offboard(
        destinationAddress: string,
        feeInfo: FeeInfo,
        amount?: bigint,
        eventCallback?: (event: SettlementEvent) => void
    ): ReturnType<IWallet["settle"]> {
        const vtxos = await this.wallet.getVtxos({
            withRecoverable: true,
            withUnrolled: false,
        });

        // Calculate input fees and filter out vtxos where fee >= value
        const estimator = new Estimator(feeInfo?.intentFee ?? {});
        const filteredVtxos: typeof vtxos = [];
        let totalAmount = 0n;

        for (const vtxo of vtxos) {
            const inputFee = estimator.evalOffchainInput({
                amount: BigInt(vtxo.value),
                type:
                    vtxo.virtualStatus.state === "swept"
                        ? "recoverable"
                        : "vtxo",
                weight: 0,
                birth: vtxo.createdAt,
                expiry: vtxo.virtualStatus.batchExpiry
                    ? new Date(vtxo.virtualStatus.batchExpiry * 1000)
                    : undefined,
            });
            if (inputFee.satoshis >= vtxo.value) {
                // skip if fees are greater than or equal to the vtxo value
                continue;
            }

            filteredVtxos.push(vtxo);
            totalAmount += BigInt(vtxo.value) - BigInt(inputFee.satoshis);
        }

        if (filteredVtxos.length === 0) {
            throw new Error("No vtxos available after deducting fees");
        }

        let change = 0n;
        if (amount) {
            if (amount > totalAmount) {
                throw new Error(
                    "Amount is greater than total amount of vtxos after fees"
                );
            }
            change = totalAmount - amount;
        }

        amount = amount ?? totalAmount;

        const networkNames: NetworkName[] = [
            "bitcoin",
            "regtest",
            "testnet",
            "signet",
            "mutinynet",
        ];
        let destinationScript: Uint8Array | undefined;

        for (const networkName of networkNames) {
            try {
                const network = networks[networkName];
                const addr = Address(network).decode(destinationAddress);
                destinationScript = OutScript.encode(addr);
                break;
            } catch {
                // Try next network
                continue;
            }
        }

        if (!destinationScript) {
            throw new Error(
                `Failed to decode destination address: ${destinationAddress}`
            );
        }

        const outputFee = estimator.evalOnchainOutput({
            amount,
            script: hex.encode(destinationScript),
        });

        if (BigInt(outputFee.satoshis) > amount) {
            throw new Error(
                `can't deduct fees from offboard amount (${outputFee.satoshis} > ${amount})`
            );
        }
        amount -= BigInt(outputFee.satoshis);

        const outputs = [
            {
                address: destinationAddress,
                amount,
            },
        ];

        if (change > 0n) {
            const offchainAddress = await this.wallet.getAddress();
            outputs.push({
                address: offchainAddress,
                amount: change,
            });
        }

        return this.wallet.settle(
            {
                inputs: filteredVtxos,
                outputs,
            },
            eventCallback
        );
    }
}
