import type { ActivityResolver, ArkTransaction, GroupMembership } from "@arkade-os/sdk";
import type { SwapRepository } from "./repositories/swap-repository";
import type { BoltzSwap } from "./types";

const SWAP_LABEL: Record<BoltzSwap["type"], string> = {
    reverse: "Lightning swap",
    submarine: "Lightning swap",
    chain: "Chain swap",
};

/**
 * Activity resolver (for {@link https://github.com/arkade-os/ts-sdk | the SDK's}
 * `wallet.getActivityHistory()`) that labels a wallet transaction as the Boltz
 * swap it settled. Correlates `ArkTransaction.key.arkTxid` against each swap's
 * persisted {@link BoltzSwap.claimTxid}; `prepare()` re-indexes the repository
 * once per `getActivityHistory()` call (pure, synchronous `resolve()`).
 *
 * Register it on the wallet:
 * ```ts
 * wallet.activity.use(swapActivityResolver(swapRepository));
 * ```
 *
 * NOTE: only swaps whose `claimTxid` has been persisted at completion are
 * correlated. The manual monitor paths persist it for reverse, submarine, and chain
 * swaps; when the SwapManager drives completion, the reverse (`claimVHTLC`) and
 * chain-BTC (`claimBtc`) claim callbacks do not yet persist it, so those combinations
 * are not correlated.
 */
export function swapActivityResolver(swapRepo: SwapRepository): ActivityResolver {
    let byTxid = new Map<string, BoltzSwap>();
    return {
        id: "boltz:swap",
        async prepare(): Promise<void> {
            const swaps = await swapRepo.getAllSwaps<BoltzSwap>();
            byTxid = new Map(
                swaps
                    .filter((s): s is BoltzSwap & { claimTxid: string } => !!s.claimTxid)
                    .map((s) => [s.claimTxid, s]),
            );
        },
        resolve(tx: ArkTransaction): GroupMembership[] | undefined {
            const key = tx.key.arkTxid || tx.key.commitmentTxid || tx.key.boardingTxid;
            const swap = byTxid.get(key);
            if (!swap) return undefined;
            return [
                {
                    groupId: `boltz:swap:${swap.id}`,
                    label: SWAP_LABEL[swap.type],
                    kind: "swap",
                    metadata: { swapType: swap.type, swapId: swap.id, status: swap.status },
                },
            ];
        },
    };
}
