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
    /** Account descriptor (ends in `/*)`); identity guard against a repo from a different seed. */
    descriptor: string;

    /** Most recently allocated index; `undefined` means the next allocation is index 0. */
    lastIndexUsed?: number;
}

/** Settings key under {@link WalletState.settings} where HD state lives. */
const HD_SETTINGS_KEY = "hd";

/** First hardened BIP32 index (2^31); xpub-derivable (non-hardened) indices stay below it. */
const HARDENED_INDEX_OFFSET = 0x80000000;

/**
 * HD-wallet {@link DescriptorProvider} that allocates a fresh signing descriptor on every call.
 * A pure rotating allocator: which descriptor the wallet is bound to is answered by the contract
 * repository, not this provider.
 *
 * State lives in `settings.hd` of the wallet state, so switching single-key → HD needs no schema
 * migration. Allocation runs inside the shared per-repo `updateWalletState` mutex, so callers
 * (even on separate instances over one repo) never observe the same index.
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
     * Construct an HDDescriptorProvider. No I/O: state is read lazily, so a descriptor-mismatch
     * error surfaces on first use rather than here.
     */
    static async create(
        identity: HDCapableIdentity,
        walletRepository: WalletRepository,
    ): Promise<HDDescriptorProvider> {
        return new HDDescriptorProvider(identity, walletRepository);
    }

    /** Allocate and return the next descriptor (index 0, 1, 2, …), atomically per repo. */
    async getNextSigningDescriptor(): Promise<string> {
        return this.mutate((settings) => {
            const next = settings.lastIndexUsed === undefined ? 0 : settings.lastIndexUsed + 1;
            settings.lastIndexUsed = next;
            return this.materializeDescriptorAt(next);
        });
    }

    /**
     * Re-derive the descriptor `getNextSigningDescriptor` last returned, WITHOUT advancing;
     * `undefined` if none was ever allocated. Lets boot keep the display address stable across
     * restarts when no tagged display contract exists, instead of burning a new index.
     */
    async getCurrentSigningDescriptor(): Promise<string | undefined> {
        const state = await this.walletRepository.getWalletState();
        const settings = this.parseSettings(state ?? ({} as WalletState));
        if (settings.lastIndexUsed === undefined) return undefined;
        return this.materializeDescriptorAt(settings.lastIndexUsed);
    }

    /** Read-only peek at the allocation watermark; `undefined` if nothing was ever allocated. */
    async getLastIndexUsed(): Promise<number | undefined> {
        const state = await this.walletRepository.getWalletState();
        return this.parseSettings(state ?? ({} as WalletState)).lastIndexUsed;
    }

    /**
     * Monotonically advance the watermark past indices found by a restore scan; never rewinds.
     * An invalid `index` (non-integer, negative, or >= 2^31) is ignored: persisting it would make
     * `parseSettings()` throw, and a watermark at the hardened ceiling would fail every later
     * allocation for the life of the repo.
     */
    async advanceLastIndexUsed(index: number): Promise<void> {
        if (!Number.isInteger(index) || index < 0 || index >= HARDENED_INDEX_OFFSET) return;
        await this.mutate((settings) => {
            if (settings.lastIndexUsed === undefined || index > settings.lastIndexUsed) {
                settings.lastIndexUsed = index;
            }
        });
    }

    /** Whether `descriptor` (HD or simple `tr(pubkey)`) is derivable from this wallet's seed. */
    isOurs(descriptor: string): boolean {
        return this.identity.ownsDescriptor(descriptor);
    }

    /** Signs each request with its descriptor's derived key (the identity holds the seed). */
    async signWithDescriptor(requests: DescriptorSigningRequest[]): Promise<Transaction[]> {
        return this.identity.signDescriptorTransactions(requests);
    }

    /** Signs a message using the key derived from `descriptor`. */
    async signMessageWithDescriptor(
        descriptor: string,
        message: Uint8Array,
        signatureType: "schnorr" | "ecdsa" = "schnorr",
    ): Promise<Uint8Array> {
        return this.identity.signDescriptorMessage(descriptor, message, signatureType);
    }

    /** HD providers take part in receive rotation via {@link WalletReceiveRotator.defaultBoot}. */
    async createReceiveRotator(
        opts: ReceiveRotatorBootOpts,
    ): Promise<ReceiveRotatorBoot | undefined> {
        return WalletReceiveRotator.defaultBoot(this, opts);
    }

    // ── internals ────────────────────────────────────────────────────

    /**
     * Materialize the account template at `index` via the descriptors-scure parser (validates the
     * ranged template and yields a canonical key expression) rather than string substitution.
     * Pure: does NOT advance the watermark, so restore's gap-scan can peek arbitrary indices.
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
     * Read-modify-write HD settings inside the shared per-repo wallet-state mutex; `fn` mutates a
     * validated snapshot that is persisted atomically. Reading inside the lock prevents races on a
     * stale index.
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
     * Validate persisted HD settings (or init a fresh record) and return a mutable clone. Fails
     * loud: a corrupt repo would otherwise derive `NaN` descriptors.
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
