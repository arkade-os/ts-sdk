import {
    DescriptorProvider,
    DescriptorSigningRequest,
} from "../identity/descriptorProvider";
import { SeedIdentity } from "../identity/seedIdentity";
import {
    WalletRepository,
    WalletState,
} from "../repositories/walletRepository";
import { Transaction } from "../utils/transaction";
import { updateWalletState } from "../utils/syncCursors";

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
     * Active receive index. Monotonic — each `rotateReceive` bumps by one.
     * `undefined` means the wallet has never derived an address; the next
     * rotation will assign index 0.
     */
    lastIndexUsed?: number;
}

/** Settings key under {@link WalletState.settings} where HD state lives. */
const HD_SETTINGS_KEY = "hd";

/**
 * Materialized view of the current receive slot held in memory so that
 * `getSigningDescriptor()` can satisfy the synchronous
 * {@link DescriptorProvider} contract.
 */
interface CurrentReceive {
    index: number;
    descriptor: string;
}

/**
 * HD-wallet {@link DescriptorProvider} that owns a single monotonic receive
 * index and rotates the active receive descriptor on demand.
 *
 * State is persisted under `WalletRepository.getWalletState().settings.hd` so
 * that no storage-schema migration is required when switching a wallet from
 * single-key to HD. The provider is backed by a {@link SeedIdentity}, which
 * both carries the seed (for signing) and exposes the account descriptor
 * template (for derivation).
 *
 * Read-modify-write of the persisted index runs inside the shared per-repo
 * `updateWalletState` mutex, so two `rotateReceive` callers — including those
 * driving separate `HDDescriptorProvider` instances on the same repo — can
 * never observe the same index.
 *
 * @example
 * ```ts
 * const provider = await HDDescriptorProvider.create(identity, walletRepo);
 * const { index, descriptor } = await provider.rotateReceive();
 * // index 1, descriptor tr([fp/86'/0'/0']xpub/0/1)
 * ```
 */
export class HDDescriptorProvider implements DescriptorProvider {
    /**
     * Cached current receive slot. Populated by {@link HDDescriptorProvider.create}
     * and updated on every rotation.
     */
    private current: CurrentReceive | null = null;

    private constructor(
        private readonly identity: SeedIdentity,
        private readonly walletRepository: WalletRepository
    ) {}

    /**
     * Construct and initialize an HDDescriptorProvider.
     *
     * On first run for a fresh wallet, this assigns index 0 as the initial
     * receive descriptor and persists it. Subsequent runs reuse the stored
     * `lastIndexUsed`.
     *
     * @throws if persisted state was written by a different identity (template mismatch).
     */
    static async create(
        identity: SeedIdentity,
        walletRepository: WalletRepository
    ): Promise<HDDescriptorProvider> {
        const provider = new HDDescriptorProvider(identity, walletRepository);
        await provider.initialize();
        return provider;
    }

    /** Returns the currently-active receive descriptor. */
    getSigningDescriptor(): string {
        return this.requireCurrent().descriptor;
    }

    /** Returns the currently-active receive index. */
    getLastIndexUsed(): number {
        return this.requireCurrent().index;
    }

    /**
     * Rotate the active receive descriptor to the next index.
     *
     * Updates both the persisted state and the in-memory `current` so that
     * subsequent {@link getSigningDescriptor} calls observe the rotation.
     */
    async rotateReceive(): Promise<CurrentReceive> {
        const next = await this.mutate((settings) => {
            const index =
                settings.lastIndexUsed === undefined
                    ? 0
                    : settings.lastIndexUsed + 1;
            settings.lastIndexUsed = index;
            return { index, descriptor: this.materializeAt(index) };
        });
        this.current = next;
        return next;
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
    async signWithDescriptor(
        requests: DescriptorSigningRequest[]
    ): Promise<Transaction[]> {
        return this.identity.signWithDescriptor(requests);
    }

    /** Signs a message using the key derived from `descriptor`. */
    async signMessageWithDescriptor(
        descriptor: string,
        message: Uint8Array,
        signatureType: "schnorr" | "ecdsa" = "schnorr"
    ): Promise<Uint8Array> {
        return this.identity.signMessageWithDescriptor(
            descriptor,
            message,
            signatureType
        );
    }

    // ── internals ────────────────────────────────────────────────────

    private async initialize(): Promise<void> {
        this.current = await this.mutate((settings) => {
            if (settings.lastIndexUsed === undefined) {
                settings.lastIndexUsed = 0;
            }
            const index = settings.lastIndexUsed;
            return { index, descriptor: this.materializeAt(index) };
        });
    }

    /**
     * Substitute the wildcard in this provider's identity's account-descriptor
     * template with a concrete index. SeedIdentity exposes the template via
     * its `descriptor` field; the "current index" concept lives here in the
     * provider.
     */
    private materializeAt(index: number): string {
        return this.identity.descriptor.replace("/*)", `/${index})`);
    }

    private requireCurrent(): CurrentReceive {
        if (!this.current) {
            throw new Error(
                "HDDescriptorProvider not initialized; use HDDescriptorProvider.create(...)"
            );
        }
        return this.current;
    }

    /**
     * Run the read-modify-write of HD settings inside the shared per-repo
     * wallet-state mutex. The closure receives a freshly-validated settings
     * snapshot, mutates it, and returns the {@link CurrentReceive} the caller
     * wants to surface; the mutated settings are then persisted as part of
     * the same atomic update.
     *
     * Doing the read inside the lock is what prevents two providers (or two
     * concurrent callers on the same provider) from racing on a stale index.
     */
    private async mutate(
        fn: (settings: HDWalletSettings) => CurrentReceive
    ): Promise<CurrentReceive> {
        let result: CurrentReceive | undefined;
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
        return result!;
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
        const stored = state.settings?.[HD_SETTINGS_KEY] as
            | HDWalletSettings
            | undefined;
        const expected = this.identity.descriptor;
        if (!stored) {
            return { descriptor: expected };
        }
        if (stored.descriptor !== expected) {
            throw new Error(
                `HD descriptor mismatch: stored "${stored.descriptor}", expected "${expected}". ` +
                    `Refusing to reuse HD state from a different identity.`
            );
        }
        if (
            stored.lastIndexUsed !== undefined &&
            (typeof stored.lastIndexUsed !== "number" ||
                !Number.isInteger(stored.lastIndexUsed) ||
                stored.lastIndexUsed < 0)
        ) {
            throw new Error(
                `Corrupt HD settings: lastIndexUsed is not a non-negative integer (got ${String(stored.lastIndexUsed)}).`
            );
        }
        // Shallow clone so the closure may mutate without aliasing the repo's copy.
        return { ...stored };
    }
}
