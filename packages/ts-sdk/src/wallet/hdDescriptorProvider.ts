import { expand, networks } from "@bitcoinerlab/descriptors-scure";
import { isMainnetDescriptor } from "../identity/descriptor";
import { DescriptorProvider, DescriptorSigningRequest } from "../identity/descriptorProvider";
import { HDCapableIdentity } from "../identity/hdCapableIdentity";
import { WalletRepository, WalletState } from "../repositories/walletRepository";
import { Transaction } from "../utils/transaction";
import { updateWalletState } from "../utils/syncCursors";
import {
    ReceiveRotatorBoot,
    ReceiveRotatorBootOpts,
    ReceiveRotatorFactory,
    WalletReceiveRotator,
} from "./walletReceiveRotator";

/**
 * Persisted HD wallet state stored under {@link WalletState.settings}`.hd`.
 * @internal
 */
interface HDWalletSettings {
    /**
     * Account descriptor (ends in `/*)`). Used as a strong identity guard:
     * a repo populated by a different seed will have a different descriptor
     * and must not be reused.
     */
    descriptor: string;

    /**
     * The most recently allocated descriptor index. `undefined` means no
     * descriptor has ever been allocated; the next allocation will return
     * index 0.
     */
    lastIndexUsed?: number;
}

/** Settings key under {@link WalletState.settings} where HD state lives. */
const HD_SETTINGS_KEY = "hd";

/**
 * HD-wallet {@link DescriptorProvider} that allocates a fresh signing
 * descriptor on every call. The provider holds no notion of "current" — it
 * is a pure rotating allocator. The question of "which descriptor is the
 * wallet currently bound to?" is answered by querying the contract
 * repository for active contracts, not by asking this provider.
 *
 * State is persisted under `WalletRepository.getWalletState().settings.hd` so
 * that no storage-schema migration is required when switching a wallet from
 * single-key to HD. The provider is backed by an {@link HDCapableIdentity},
 * which carries the wildcard account descriptor template (for derivation)
 * and the signing primitives.
 *
 * The read-modify-write of the persisted index runs inside the shared per-
 * repo `updateWalletState` mutex, so two `getNextSigningDescriptor` callers
 * — including those driving separate `HDDescriptorProvider` instances on
 * the same repo — can never observe the same index.
 *
 * @example
 * ```ts
 * const provider = await HDDescriptorProvider.create(identity, walletRepo);
 * const descriptor = await provider.getNextSigningDescriptor();
 * // descriptor: tr([fp/86'/0'/0']xpub/0/0)
 * const next = await provider.getNextSigningDescriptor();
 * // next: tr([fp/86'/0'/0']xpub/0/1)
 * ```
 */
export class HDDescriptorProvider implements DescriptorProvider, ReceiveRotatorFactory {
    private constructor(
        private readonly identity: HDCapableIdentity,
        private readonly walletRepository: WalletRepository,
    ) {}

    /**
     * Construct an HDDescriptorProvider. No I/O is performed here;
     * persisted state is read lazily on the first call to
     * `getNextSigningDescriptor`. A descriptor-mismatch error surfaces on
     * first use rather than at boot.
     */
    static async create(
        identity: HDCapableIdentity,
        walletRepository: WalletRepository,
    ): Promise<HDDescriptorProvider> {
        return new HDDescriptorProvider(identity, walletRepository);
    }

    /**
     * Allocate the next descriptor and return it. The first call on a fresh
     * wallet returns descriptor at index 0; subsequent calls return 1, 2, 3,
     * ... in order. Each call is atomic with respect to other rotations on
     * the same repo: two concurrent callers can never observe the same
     * index.
     */
    async getNextSigningDescriptor(): Promise<string> {
        return this.mutate((settings) => {
            const next = settings.lastIndexUsed === undefined ? 0 : settings.lastIndexUsed + 1;
            settings.lastIndexUsed = next;
            return this.materializeDescriptorAt(next);
        });
    }

    /**
     * Re-derive the descriptor at the most recently allocated index
     * WITHOUT advancing — i.e. read the same descriptor
     * `getNextSigningDescriptor` last returned. Returns `undefined`
     * when no descriptor has ever been allocated on this repo.
     *
     * Used by the boot path to keep the wallet's display address
     * stable across restarts: when no tagged display contract exists
     * (e.g. a fresh wallet that hasn't rotated yet, or a wallet whose
     * baseline-only repo carries no rotation history), the boot should
     * re-derive the existing index rather than burn a new one.
     */
    async getCurrentSigningDescriptor(): Promise<string | undefined> {
        const state = await this.walletRepository.getWalletState();
        const settings = this.parseSettings(state ?? ({} as WalletState));
        if (settings.lastIndexUsed === undefined) return undefined;
        return this.materializeDescriptorAt(settings.lastIndexUsed);
    }

    /**
     * Monotonically advance the allocation watermark so the next
     * `getNextSigningDescriptor()` skips indices discovered by a restore
     * scan. Never rewinds: a lower or equal `index` is a no-op.
     *
     * An invalid `index` (non-integer / negative) is ignored (no-op):
     * persisting it would corrupt `lastIndexUsed` and make the next
     * `parseSettings()` throw, mirroring the validation parseSettings
     * already enforces.
     */
    async advanceLastIndexUsed(index: number): Promise<void> {
        if (!Number.isInteger(index) || index < 0) return;
        await this.mutate((settings) => {
            if (settings.lastIndexUsed === undefined || index > settings.lastIndexUsed) {
                settings.lastIndexUsed = index;
            }
        });
    }

    /**
     * Returns true when the given descriptor is derivable from this wallet's
     * seed. Delegates to the underlying identity, which handles both HD and
     * simple `tr(pubkey)` descriptors.
     */
    isOurs(descriptor: string): boolean {
        return this.identity.isOurs(descriptor);
    }

    /**
     * Signs each request with the key derived from its descriptor. Delegates
     * to the identity's signing primitives — the identity, not the provider,
     * holds the seed.
     */
    async signWithDescriptor(requests: DescriptorSigningRequest[]): Promise<Transaction[]> {
        return this.identity.signWithDescriptor(requests);
    }

    /** Signs a message using the key derived from `descriptor`. */
    async signMessageWithDescriptor(
        descriptor: string,
        message: Uint8Array,
        signatureType: "schnorr" | "ecdsa" = "schnorr",
    ): Promise<Uint8Array> {
        return this.identity.signMessageWithDescriptor(descriptor, message, signatureType);
    }

    /**
     * HD providers participate in receive rotation. The default
     * factory boot (contract-repo lookup → allocate fresh descriptor)
     * is exactly what we want, so this just delegates to
     * {@link WalletReceiveRotator.defaultBoot}.
     */
    async createReceiveRotator(
        opts: ReceiveRotatorBootOpts,
    ): Promise<ReceiveRotatorBoot | undefined> {
        return WalletReceiveRotator.defaultBoot(this, opts);
    }

    // ── internals ────────────────────────────────────────────────────

    /**
     * Substitute the wildcard in the identity's account-descriptor template
     * with a concrete index, going through the descriptors-scure parser
     * rather than ad-hoc string substitution. The parser's `expand({ index })`
     * call validates that the input is a ranged template AND produces a
     * canonical materialized key expression at the given index.
     *
     * This is a pure read: it does NOT advance the allocation watermark.
     * Used by restore's gap-scan to peek descriptors at arbitrary indices
     * without side-effects.
     */
    materializeDescriptorAt(index: number): string {
        const descriptor = this.identity.descriptor;
        const network = isMainnetDescriptor(descriptor) ? networks.bitcoin : networks.testnet;
        const expansion = expand({ descriptor, network, index });
        const keyInfo = expansion.expansionMap?.["@0"];
        if (!keyInfo?.keyExpression) {
            throw new Error(
                `HDDescriptorProvider: cannot materialize descriptor at index ${index}`,
            );
        }
        return `tr(${keyInfo.keyExpression})`;
    }

    /**
     * Run the read-modify-write of HD settings inside the shared per-repo
     * wallet-state mutex. The closure receives a freshly-validated settings
     * snapshot, mutates it, and returns whatever value the caller wants to
     * surface; the mutated settings are then persisted as part of the same
     * atomic update.
     *
     * Doing the read inside the lock is what prevents two providers (or two
     * concurrent callers on the same provider) from racing on a stale index.
     */
    private async mutate<T>(fn: (settings: HDWalletSettings) => T): Promise<T> {
        let result!: T;
        await updateWalletState(this.walletRepository, (state) => {
            const settings = this.parseSettings(state);
            result = fn(settings);
            return {
                ...state,
                settings: {
                    ...(state.settings ?? {}),
                    [HD_SETTINGS_KEY]: settings,
                },
            };
        });
        return result;
    }

    /**
     * Validate the persisted HD settings (or initialize a fresh record when
     * absent) and return a clone safe for the caller to mutate.
     *
     * The cast to `HDWalletSettings` trusts storage; a corrupted or
     * partially-migrated repo could otherwise produce `NaN` descriptors.
     * Fail loud rather than silently derive garbage.
     */
    private parseSettings(state: WalletState): HDWalletSettings {
        const stored = state.settings?.[HD_SETTINGS_KEY] as HDWalletSettings | undefined;
        const expected = this.identity.descriptor;
        if (!stored) {
            return { descriptor: expected };
        }
        if (stored.descriptor !== expected) {
            throw new Error(
                `HD descriptor mismatch: stored "${stored.descriptor}", expected "${expected}". ` +
                    `Refusing to reuse HD state from a different identity.`,
            );
        }
        if (
            stored.lastIndexUsed !== undefined &&
            (typeof stored.lastIndexUsed !== "number" ||
                !Number.isInteger(stored.lastIndexUsed) ||
                stored.lastIndexUsed < 0)
        ) {
            throw new Error(
                `Corrupt HD settings: lastIndexUsed is not a non-negative integer (got ${String(stored.lastIndexUsed)}).`,
            );
        }
        // Shallow clone so the closure may mutate without aliasing the repo's copy.
        return { ...stored };
    }
}
