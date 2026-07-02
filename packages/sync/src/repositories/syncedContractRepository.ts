import type { Contract, ContractRepository } from "@arkade-os/sdk";
import { CONTRACT_PREFIX } from "../sync/sources";
import type { WalletSync } from "../sync/walletSync";

// `ContractFilter` is not exported by the SDK; take the exact param type from the interface.
type ContractFilter = Parameters<ContractRepository["getContracts"]>[0];

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * A drop-in {@link ContractRepository} that mirrors every write to the sync
 * server in the background. Hand this to `Wallet.create({ storage: { contractRepository } })`
 * and the wallet's contracts (VHTLCs, swap contracts, the default receive
 * contract) back themselves up as they change.
 *
 * Writes complete against the local `base` repository first and return
 * immediately; the encrypted push is fire-and-forget so wallet operations never
 * block on the network. A push failure is surfaced via `onError` (default:
 * swallow) and the next `WalletSync.backup()`/`sync()` reconciles it.
 */
export class SyncedContractRepository implements ContractRepository {
    readonly version = 1 as const;

    constructor(
        private readonly base: ContractRepository,
        private readonly sync: WalletSync,
        private readonly onError: (error: unknown) => void = () => {},
    ) {}

    async saveContract(contract: Contract): Promise<void> {
        await this.base.saveContract(contract);
        this.enqueue(CONTRACT_PREFIX + contract.script, enc(JSON.stringify(contract)));
    }

    async deleteContract(script: string): Promise<void> {
        await this.base.deleteContract(script);
        this.enqueue(CONTRACT_PREFIX + script, null);
    }

    getContracts(filter?: ContractFilter): Promise<Contract[]> {
        return this.base.getContracts(filter);
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
