import type { Contract, ContractRepository, WalletRepository } from "@arkade-os/sdk";

// `WalletState` is not part of the SDK's public export surface; derive it from
// the repository interface so we stay in lockstep without a fragile deep import.
type WalletStateValue = NonNullable<Awaited<ReturnType<WalletRepository["getWalletState"]>>>;

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/**
 * A slice of local wallet state that can be mirrored to/from namespaced bucket
 * records. Each source owns a key prefix, can snapshot its current state for a
 * full backup, and can apply a pulled record back into local storage.
 */
export interface SyncSource {
    /** True if `key` belongs to this source's namespace. */
    owns(key: string): boolean;
    /** Current local state as `key → plaintext` (drives backup / full push). */
    snapshot(): Promise<Map<string, Uint8Array>>;
    /** Apply a pulled record to local storage. `plaintext === null` is a delete. */
    apply(key: string, plaintext: Uint8Array | null): Promise<void>;
}

export const CONTRACT_PREFIX = "contract:";

/**
 * Syncs the wallet's contracts (incl. VHTLCs and Boltz-swap contracts). Contracts
 * are keyed by `script` and are already JSON-safe (`params` is a string map), so
 * each maps cleanly to a per-key CAS entry `contract:{script}`.
 */
export class ContractSource implements SyncSource {
    constructor(private readonly repo: ContractRepository) {}

    owns(key: string): boolean {
        return key.startsWith(CONTRACT_PREFIX);
    }

    keyFor(script: string): string {
        return CONTRACT_PREFIX + script;
    }

    async snapshot(): Promise<Map<string, Uint8Array>> {
        const out = new Map<string, Uint8Array>();
        for (const c of await this.repo.getContracts()) {
            out.set(this.keyFor(c.script), enc(JSON.stringify(c)));
        }
        return out;
    }

    async apply(key: string, plaintext: Uint8Array | null): Promise<void> {
        const script = key.slice(CONTRACT_PREFIX.length);
        if (plaintext === null) await this.repo.deleteContract(script);
        else await this.repo.saveContract(JSON.parse(dec(plaintext)) as Contract);
    }
}

export const WALLET_STATE_KEY = "state:wallet";

/**
 * Syncs the portable part of the wallet state — its `settings`. The
 * `lastSyncTime` field is a **device-local** VTXO-indexer high-water mark
 * (per the SDK's own note), so it is deliberately NOT synced: applying another
 * device's cursor would corrupt this device's indexer progress. On apply we
 * merge incoming settings over the local ones and leave `lastSyncTime` intact.
 */
export class WalletStateSource implements SyncSource {
    constructor(private readonly repo: WalletRepository) {}

    owns(key: string): boolean {
        return key === WALLET_STATE_KEY;
    }

    async snapshot(): Promise<Map<string, Uint8Array>> {
        const out = new Map<string, Uint8Array>();
        const state = await this.repo.getWalletState();
        if (state?.settings)
            out.set(WALLET_STATE_KEY, enc(JSON.stringify({ settings: state.settings })));
        return out;
    }

    async apply(_key: string, plaintext: Uint8Array | null): Promise<void> {
        if (plaintext === null) return; // wallet state is not deleted
        const incoming = JSON.parse(dec(plaintext)) as WalletStateValue;
        const existing: WalletStateValue =
            (await this.repo.getWalletState()) ?? ({} as WalletStateValue);
        await this.repo.saveWalletState({
            ...existing, // preserves device-local lastSyncTime
            settings: { ...existing.settings, ...incoming.settings },
        });
    }
}
