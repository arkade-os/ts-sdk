import {
    DescriptorProvider,
    DescriptorSigningRequest,
} from "../identity/descriptorProvider";
import { SeedIdentity } from "../identity/seedIdentity";
import { WalletRepository } from "../repositories/walletRepository";
import { Transaction } from "../utils/transaction";
import { updateWalletState } from "../utils/syncCursors";

/**
 * Upper bound for non-hardened derivation indices (BIP-32). An HD wallet that
 * hits this has either been bugged into monotonic advancement without spend
 * or has been in use for generations; either way we refuse to silently
 * wrap into the hardened range (which would throw deep inside the signing
 * primitives with an error message that wouldn't help diagnose the cause).
 */
const MAX_NON_HARDENED_INDEX = 0x80000000;

/**
 * Persisted HD wallet state stored under {@link WalletState.settings}`.hd`.
 * @internal
 */
interface HDWalletSettings {
    /**
     * Account descriptor template (ends in `/*)`). Used as a strong
     * identity guard: a repo populated by a different seed will have a
     * different template and must not be reused.
     */
    template: string;

    /**
     * Next unused child index. Monotonic — never rewound.
     * Follows the NArk pattern of a single global counter rather than
     * separate receive/change ranges.
     */
    nextIndex: number;

    /**
     * Currently-active receive index. Rotated on `vtxo_received` by the
     * wallet; the provider exposes it via {@link HDDescriptorProvider.getSigningDescriptor}.
     */
    currentReceiveIndex?: number;
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
 * HD-wallet {@link DescriptorProvider} that owns a single global derivation
 * counter and rotates receive addresses on demand.
 *
 * State is persisted under `WalletRepository.getWalletState().settings.hd` so
 * that no storage-schema migration is required when switching a wallet from
 * single-key to HD. The provider is backed by a {@link SeedIdentity}, which
 * both carries the seed (for signing) and exposes the account descriptor
 * template (for derivation).
 *
 * Concurrent calls to `consumeNextIndex` / `rotateReceive` are serialised
 * through an internal promise-chain mutex so that two callers can never
 * receive the same index.
 *
 * @example
 * ```ts
 * const provider = await HDDescriptorProvider.create(identity, walletRepo);
 * const { index, descriptor } = await provider.consumeNextIndex();
 * // index 0, descriptor tr([fp/86'/0'/0']xpub/0/0)
 * ```
 */
export class HDDescriptorProvider implements DescriptorProvider {
    /** Chain that serialises critical-section mutations. */
    private chain: Promise<unknown> = Promise.resolve();

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
     * On first run for a fresh wallet, this consumes index 0 as the initial
     * receive descriptor and persists it. Subsequent runs reuse the stored
     * `currentReceiveIndex`.
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
    getCurrentReceiveIndex(): number {
        return this.requireCurrent().index;
    }

    /**
     * Reads `nextIndex` without consuming it. Advisory only — the value may
     * change between calls if another consumer races this read.
     */
    async peekNextIndex(): Promise<number> {
        const settings = await this.loadOrInit();
        return settings.nextIndex;
    }

    /**
     * Atomically consume the next index, persist the bump, and return the
     * materialized descriptor. Does not change the active receive descriptor.
     *
     * Use this when you need a fresh address for a non-receive purpose
     * (e.g. internal change, boarding, self-spend) without touching the
     * user-visible receive slot.
     */
    async consumeNextIndex(): Promise<CurrentReceive> {
        return this.mutate(async (settings) => {
            const index = this.takeNextIndex(settings);
            await this.saveSettings(settings);
            return {
                index,
                descriptor: this.identity.deriveSigningDescriptor(index),
            };
        });
    }

    /**
     * Rotate the active receive descriptor to the next unused index.
     *
     * Updates both the persisted state and the in-memory `current` so that
     * subsequent {@link getSigningDescriptor} calls observe the rotation.
     */
    async rotateReceive(): Promise<CurrentReceive> {
        return this.mutate(async (settings) => {
            const index = this.takeNextIndex(settings);
            settings.currentReceiveIndex = index;
            await this.saveSettings(settings);
            const next: CurrentReceive = {
                index,
                descriptor: this.identity.deriveSigningDescriptor(index),
            };
            this.current = next;
            return next;
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
        this.current = await this.mutate(async (settings) => {
            if (settings.currentReceiveIndex !== undefined) {
                return {
                    index: settings.currentReceiveIndex,
                    descriptor: this.identity.deriveSigningDescriptor(
                        settings.currentReceiveIndex
                    ),
                };
            }
            const index = this.takeNextIndex(settings);
            settings.currentReceiveIndex = index;
            await this.saveSettings(settings);
            return {
                index,
                descriptor: this.identity.deriveSigningDescriptor(index),
            };
        });
    }

    /**
     * Consume the next index from `settings`, bumping `nextIndex` and
     * returning the pre-bump value. Throws a descriptive error when the
     * wallet has exhausted the non-hardened derivation range rather than
     * silently bouncing off the signing primitive's opaque "index must be
     * in [0, 2^31)" error.
     */
    private takeNextIndex(settings: HDWalletSettings): number {
        if (settings.nextIndex >= MAX_NON_HARDENED_INDEX) {
            throw new Error(
                `HD wallet exhausted: nextIndex ${settings.nextIndex} reached the non-hardened derivation cap (${MAX_NON_HARDENED_INDEX}).`
            );
        }
        const index = settings.nextIndex;
        settings.nextIndex = index + 1;
        return index;
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
     * Serialise `fn` against other critical-section callers and hand it a
     * freshly-loaded settings snapshot to mutate.
     */
    private mutate<T>(
        fn: (settings: HDWalletSettings) => Promise<T>
    ): Promise<T> {
        const run = this.chain.then(
            () => this.loadOrInit().then(fn),
            () => this.loadOrInit().then(fn)
        );
        this.chain = run.catch(() => undefined);
        return run;
    }

    private async loadOrInit(): Promise<HDWalletSettings> {
        const state = await this.walletRepository.getWalletState();
        const stored = state?.settings?.[HD_SETTINGS_KEY] as
            | HDWalletSettings
            | undefined;
        const expectedTemplate = this.identity.getAccountDescriptor();
        if (!stored) {
            return { template: expectedTemplate, nextIndex: 0 };
        }
        if (stored.template !== expectedTemplate) {
            throw new Error(
                `HD template mismatch: stored "${stored.template}", expected "${expectedTemplate}". ` +
                    `Refusing to reuse HD state from a different identity.`
            );
        }
        // Validate the shape of persisted fields — the `as HDWalletSettings`
        // cast above trusts storage, and a corrupted or partially-migrated
        // repo could otherwise produce `NaN` descriptors or skip the index
        // guard entirely. Fail loud rather than silently derive garbage.
        if (
            typeof stored.nextIndex !== "number" ||
            !Number.isInteger(stored.nextIndex) ||
            stored.nextIndex < 0
        ) {
            throw new Error(
                `Corrupt HD settings: nextIndex is not a non-negative integer (got ${String(stored.nextIndex)}).`
            );
        }
        if (
            stored.currentReceiveIndex !== undefined &&
            (typeof stored.currentReceiveIndex !== "number" ||
                !Number.isInteger(stored.currentReceiveIndex) ||
                stored.currentReceiveIndex < 0)
        ) {
            throw new Error(
                `Corrupt HD settings: currentReceiveIndex is not a non-negative integer (got ${String(stored.currentReceiveIndex)}).`
            );
        }
        // Shallow clone so callers may mutate without aliasing the repo's copy.
        return { ...stored };
    }

    /**
     * Persist HD settings through the shared per-repo wallet-state mutex
     * so that a concurrent writer (e.g. VTXO sync cursor advance) cannot
     * silently clobber our update — and vice versa. Without this guard
     * an interleave like `sync reads state → HD reads state → HD writes
     * (drops sync's later field) → sync writes (drops HD's index bump)`
     * would lose the index rotation, causing the next wallet boot to
     * reuse an address that already has a VTXO credited to it.
     */
    private async saveSettings(hd: HDWalletSettings): Promise<void> {
        await updateWalletState(this.walletRepository, (state) => ({
            ...state,
            settings: {
                ...(state.settings ?? {}),
                [HD_SETTINGS_KEY]: hd,
            },
        }));
    }
}
