import { ExtendedVirtualCoin, IWallet, isRecoverable, isSubdust } from ".";
import { SettlementEvent } from "../providers/ark";

/**
 * Filter VTXOs that are recoverable (swept and still spendable)
 *
 * @param vtxos - Array of virtual coins to check
 * @returns Array of recoverable VTXOs
 */
function getRecoverableVtxos(
    vtxos: ExtendedVirtualCoin[]
): ExtendedVirtualCoin[] {
    return vtxos.filter(isRecoverable);
}

/**
 * Get recoverable VTXOs including subdust coins if the total value exceeds dust threshold.
 *
 * Decision is based on the combined total of ALL recoverable VTXOs (regular + subdust),
 * not just the subdust portion alone.
 *
 * @param vtxos - Array of virtual coins to check
 * @param dustAmount - Dust threshold amount in satoshis
 * @returns Object containing recoverable VTXOs and whether subdust should be included
 */
function getRecoverableWithSubdust(
    vtxos: ExtendedVirtualCoin[],
    dustAmount: bigint
): {
    vtxosToRecover: ExtendedVirtualCoin[];
    includesSubdust: boolean;
    totalAmount: bigint;
} {
    const recoverableVtxos = getRecoverableVtxos(vtxos);

    // Separate subdust from regular recoverable
    const subdust: ExtendedVirtualCoin[] = [];
    const regular: ExtendedVirtualCoin[] = [];

    for (const vtxo of recoverableVtxos) {
        if (isSubdust(vtxo, dustAmount)) {
            subdust.push(vtxo);
        } else {
            regular.push(vtxo);
        }
    }

    // Calculate totals
    const regularTotal = regular.reduce(
        (sum, vtxo) => sum + BigInt(vtxo.value),
        0n
    );
    const subdustTotal = subdust.reduce(
        (sum, vtxo) => sum + BigInt(vtxo.value),
        0n
    );
    const combinedTotal = regularTotal + subdustTotal;

    // Include subdust only if the combined total exceeds dust threshold
    const shouldIncludeSubdust = combinedTotal >= dustAmount;
    const vtxosToRecover = shouldIncludeSubdust ? recoverableVtxos : regular;

    const totalAmount = vtxosToRecover.reduce(
        (sum, vtxo) => sum + BigInt(vtxo.value),
        0n
    );

    return {
        vtxosToRecover,
        includesSubdust: shouldIncludeSubdust,
        totalAmount,
    };
}

/**
 * Recovery is a class wrapping IWallet.settle method to provide a convenient interface
 * for recovering swept or expired VTXOs back to the wallet.
 *
 * VTXOs become recoverable when:
 * - The Ark server sweeps them (virtualStatus.state === "swept")
 * - They remain spendable (not yet claimed by the server)
 *
 * The Recovery class automatically handles:
 * - Filtering recoverable VTXOs
 * - Including subdust VTXOs when the total value (regular + subdust) exceeds the dust threshold
 * - Settling all recoverable funds back to the wallet's Ark address
 *
 * @example
 * ```typescript
 * const recovery = new Recovery(wallet);
 *
 * // Check what's recoverable
 * const balance = await recovery.getRecoverableBalance();
 * console.log(`Recoverable: ${balance.recoverable} sats`);
 * console.log(`Subdust: ${balance.subdust} sats (${balance.includesSubdust ? 'included' : 'excluded'})`);
 *
 * // Recover all swept VTXOs
 * const txid = await recovery.recoverVtxos();
 * console.log(`Recovery transaction: ${txid}`);
 * ```
 */
export class Recovery {
    constructor(readonly wallet: IWallet) {}

    /**
     * Recover swept/expired VTXOs by settling them back to the wallet's Ark address.
     *
     * This method:
     * 1. Fetches all VTXOs (including recoverable ones)
     * 2. Filters for swept but still spendable VTXOs
     * 3. Includes subdust VTXOs if the total value >= dust threshold
     * 4. Settles everything back to the wallet's Ark address
     *
     * @param eventCallback - Optional callback to receive settlement events
     * @returns Settlement transaction ID
     * @throws Error if no recoverable VTXOs found
     *
     * @example
     * ```typescript
     * const recovery = new Recovery(wallet);
     *
     * // Simple recovery
     * const txid = await recovery.recoverVtxos();
     *
     * // With event callback
     * const txid = await recovery.recoverVtxos((event) => {
     *   console.log('Settlement event:', event.type);
     * });
     * ```
     */
    async recoverVtxos(
        eventCallback?: (event: SettlementEvent) => void
    ): Promise<string> {
        // Get all VTXOs including recoverable ones
        const allVtxos = await this.wallet.getVtxos({
            withRecoverable: true,
            withUnrolled: false,
        });

        // Get dust amount from wallet
        const dustAmount =
            "dustAmount" in this.wallet
                ? (this.wallet.dustAmount as bigint)
                : 1000n;

        // Filter recoverable VTXOs and handle subdust logic
        const { vtxosToRecover, includesSubdust, totalAmount } =
            getRecoverableWithSubdust(allVtxos, dustAmount);

        if (vtxosToRecover.length === 0) {
            throw new Error("No recoverable VTXOs found");
        }

        const arkAddress = await this.wallet.getAddress();

        // Settle all recoverable VTXOs back to the wallet
        return this.wallet.settle(
            {
                inputs: vtxosToRecover,
                outputs: [
                    {
                        address: arkAddress,
                        amount: totalAmount,
                    },
                ],
            },
            eventCallback
        );
    }

    /**
     * Get information about recoverable balance without executing recovery.
     *
     * Useful for displaying to users before they decide to recover funds.
     *
     * @returns Object containing recoverable amounts and subdust information
     *
     * @example
     * ```typescript
     * const recovery = new Recovery(wallet);
     * const balance = await recovery.getRecoverableBalance();
     *
     * if (balance.recoverable > 0n) {
     *   console.log(`You can recover ${balance.recoverable} sats`);
     *   if (balance.includesSubdust) {
     *     console.log(`This includes ${balance.subdust} sats from subdust VTXOs`);
     *   }
     * }
     * ```
     */
    async getRecoverableBalance(): Promise<{
        recoverable: bigint;
        subdust: bigint;
        includesSubdust: boolean;
        vtxoCount: number;
    }> {
        const allVtxos = await this.wallet.getVtxos({
            withRecoverable: true,
            withUnrolled: false,
        });

        const dustAmount =
            "dustAmount" in this.wallet
                ? (this.wallet.dustAmount as bigint)
                : 1000n;

        const { vtxosToRecover, includesSubdust, totalAmount } =
            getRecoverableWithSubdust(allVtxos, dustAmount);

        // Calculate subdust amount separately for reporting
        const subdustAmount = vtxosToRecover
            .filter((v) => BigInt(v.value) < dustAmount)
            .reduce((sum, v) => sum + BigInt(v.value), 0n);

        return {
            recoverable: totalAmount,
            subdust: subdustAmount,
            includesSubdust,
            vtxoCount: vtxosToRecover.length,
        };
    }
}
