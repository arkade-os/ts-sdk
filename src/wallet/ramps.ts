import { ExtendedCoin, IWallet } from ".";
import { FeeInfo, SettlementEvent } from "../providers/ark";
import { Estimator } from "../arkfee";
import { Address, OutScript } from "@scure/btc-signer";
import { hex } from "@scure/base";
import { networks, NetworkName } from "../networks";

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
     * @param boardingUtxos - The boarding utxos to onboard. If not provided, all boarding utxos will be used.
     * @param amount - The amount to onboard. If not provided, the total amount of boarding utxos will be onboarded.
     * @param eventCallback - The callback to receive settlement events. optional.
     */
    async onboard(
        boardingUtxos?: ExtendedCoin[],
        amount?: bigint,
        eventCallback?: (event: SettlementEvent) => void
    ): ReturnType<IWallet["settle"]> {
        boardingUtxos = boardingUtxos ?? (await this.wallet.getBoardingUtxos());

        const totalAmount = boardingUtxos.reduce(
            (acc, coin) => acc + BigInt(coin.value),
            0n
        );
        let change = 0n;
        if (amount) {
            if (amount > totalAmount) {
                throw new Error(
                    "Amount is greater than total amount of boarding utxos"
                );
            }
            change = totalAmount - amount;
        }

        amount = amount ?? totalAmount;

        const offchainAddress = await this.wallet.getAddress();

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
                inputs: boardingUtxos,
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

        const totalAmount = vtxos.reduce(
            (acc, coin) => acc + BigInt(coin.value),
            0n
        );
        let change = 0n;
        if (amount) {
            if (amount > totalAmount) {
                throw new Error("Amount is greater than total amount of vtxos");
            }
            change = totalAmount - amount;
        }

        amount = amount ?? totalAmount;

        // Calculate onchain output fee using Estimator
        const estimator = new Estimator(feeInfo.intentFee);

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

        if (outputFee.value > amount) {
            throw new Error(
                `can't deduct fees from offboard amount (${outputFee.value} > ${amount})`
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
                inputs: vtxos,
                outputs,
            },
            eventCallback
        );
    }
}
