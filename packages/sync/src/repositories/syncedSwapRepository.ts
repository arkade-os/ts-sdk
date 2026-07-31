import type { BoltzSwap, SwapRepository } from "@arkade-os/boltz-swap";
import { SWAP_PREFIX } from "../sync/sources";
import type { WalletSync } from "../sync/walletSync";

// `GetSwapsFilter` is declared in boltz-swap but not re-exported from its entry
// point; take the exact param type from the interface instead of deep-importing
// (mirrors how SyncedContractRepository derives ContractFilter).
type SwapsFilter = Parameters<SwapRepository["getAllSwaps"]>[0];

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * A drop-in {@link SwapRepository} that mirrors every write to the sync server
 * in the background, so a swap's preimage is backed up as soon as it exists
 * rather than at the next periodic sync.
 *
 * Writes complete against the local `base` repository first and return
 * immediately; the encrypted push is fire-and-forget, matching
 * {@link SyncedContractRepository} and keeping wallet operations off the
 * network's critical path. An optional backup server should never be able to
 * fail a swap.
 *
 * The trade-off that buys: a device lost in the gap between creating a swap and
 * completing its push has no remote copy of the preimage. The window is the
 * duration of one request, but it is not zero — pass `onError` if you want to
 * observe failed pushes, and note that the next `WalletSync.backup()`/`sync()`
 * reconciles anything that did not land.
 */
export class SyncedSwapRepository implements SwapRepository {
    readonly version = 1 as const;

    constructor(
        private readonly base: SwapRepository,
        private readonly sync: WalletSync,
        private readonly onError: (error: unknown) => void = () => {},
    ) {}

    async saveSwap<T extends BoltzSwap>(swap: T): Promise<void> {
        await this.base.saveSwap(swap);
        this.enqueue(SWAP_PREFIX + swap.id, enc(JSON.stringify(swap)));
    }

    async deleteSwap(id: string): Promise<void> {
        await this.base.deleteSwap(id);
        this.enqueue(SWAP_PREFIX + id, null);
    }

    getAllSwaps<T extends BoltzSwap>(filter?: SwapsFilter): Promise<T[]> {
        return this.base.getAllSwaps<T>(filter);
    }

    clear(): Promise<void> {
        return this.base.clear();
    }

    [Symbol.asyncDispose](): PromiseLike<void> {
        return this.base[Symbol.asyncDispose]();
    }

    private enqueue(key: string, value: Uint8Array | null): void {
        // The local write already succeeded; sync in the background. WalletSync
        // serializes pushes internally, so overlapping writes stay consistent.
        this.sync.push(new Map([[key, value]])).catch(this.onError);
    }
}
