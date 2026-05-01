import { expand, networks } from "@bitcoinerlab/descriptors-scure";
import { isMainnetDescriptor } from "../identity/descriptor";
import {
    DescriptorProvider,
    DescriptorSigningRequest,
} from "../identity/descriptorProvider";
import { HDCapableIdentity } from "../identity/hdCapableIdentity";
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
     * The most recently rotated-to receive index. `undefined` means no
     * rotation has occurred yet — the wallet is still on the implicit
     * default index 0.
     */
    lastIndexUsed?: number;
}

/** Settings key under {@link WalletState.settings} where HD state lives. */
const HD_SETTINGS_KEY = "hd";

/**
 * HD-wallet {@link DescriptorProvider} that owns a single monotonic receive
 * index and rotates the active receive descriptor on demand.
 *
 * State is persisted under `WalletRepository.getWalletState().settings.hd` so
 * that no storage-schema migration is required when switching a wallet from
 * single-key to HD. The provider is backed by an {@link HDCapableIdentity},
 * which carries the wildcard account descriptor template (for derivation)
 * and the signing primitives.
 *
 * Both `getSigningDescriptor` and `getNextSigningDescriptor` go through the
 * shared per-repo `updateWalletState` flow — the index is never cached
 * in-memory, so a concurrent rotation by another `HDDescriptorProvider`
 * instance on the same repo can never be missed. Read-modify-write of the
 * persisted index runs inside the same shared mutex, so two
 * `getNextSigningDescriptor` callers can never observe the same index.
 *
 * @example
 * ```ts
 * const provider = await HDDescriptorProvider.create(identity, walletRepo);
 * const descriptor = await provider.getNextSigningDescriptor();
 * // descriptor: tr([fp/86'/0'/0']xpub/0/1)
 * ```
 */
export class HDDescriptorProvider implements DescriptorProvider {
    private constructor(
        private readonly identity: HDCapableIdentity,
        private readonly walletRepository: WalletRepository
    ) {}

    /**
     * Construct an HDDescriptorProvider. No I/O is performed at this point;
     * persisted state is read on first call to `getSigningDescriptor` or
     * `getNextSigningDescriptor`. State is validated lazily so a
     * descriptor-mismatch error surfaces on first use rather than at boot.
     */
    static async create(
        identity: HDCapableIdentity,
        walletRepository: WalletRepository
    ): Promise<HDDescriptorProvider> {
        return new HDDescriptorProvider(identity, walletRepository);
    }

    /**
     * Returns the current signing descriptor. Always reads fresh state from
     * the wallet repository so that rotations performed by another provider
     * instance (or by another tab) are reflected immediately.
     */
    async getSigningDescriptor(): Promise<string> {
        const state = (await this.walletRepository.getWalletState()) ?? {};
        const settings = this.parseSettings(state);
        return this.materializeAt(settings.lastIndexUsed ?? 0);
    }

    /**
     * Rotate to a new receive descriptor and return it. The first call on a
     * fresh wallet returns descriptor at index 1 — index 0 is the implicit
     * default surfaced by `getSigningDescriptor`, so rotating past it gives
     * the consumer a genuinely new address rather than a no-op.
     */
    async getNextSigningDescriptor(): Promise<string> {
        return this.mutate((settings) => {
            const next =
                settings.lastIndexUsed === undefined
                    ? 1
                    : settings.lastIndexUsed + 1;
            settings.lastIndexUsed = next;
            return this.materializeAt(next);
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

    /**
     * Substitute the wildcard in the identity's account-descriptor template
     * with a concrete index, going through the descriptors-scure parser
     * rather than ad-hoc string substitution. The parser's `expand({ index })`
     * call validates that the input is a ranged template AND produces a
     * canonical materialized key expression at the given index.
     */
    private materializeAt(index: number): string {
        const descriptor = this.identity.descriptor;
        const network = isMainnetDescriptor(descriptor)
            ? networks.bitcoin
            : networks.testnet;
        const expansion = expand({ descriptor, network, index });
        const keyInfo = expansion.expansionMap?.["@0"];
        if (!keyInfo?.keyExpression) {
            throw new Error(
                `HDDescriptorProvider: cannot materialize descriptor at index ${index}`
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
