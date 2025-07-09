import { ExtendedCoin, IWallet } from ".";
import { SettlementEvent } from "../providers/ark";

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
     * @param amount - The amount to offboard. If not provided, the total amount of vtxos will be offboarded.
     * @param eventCallback - The callback to receive settlement events. optional.
     */
    async offboard(
        destinationAddress: string,
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
