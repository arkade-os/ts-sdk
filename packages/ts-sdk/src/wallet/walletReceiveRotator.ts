import { equalBytes } from "@scure/btc-signer/utils.js";
import { hex } from "@scure/base";
import { deriveDescriptorLeafPubKey } from "../identity/descriptor";
import { DescriptorProvider } from "../identity/descriptorProvider";
import { isHDCapableIdentity } from "../identity/hdCapableIdentity";
import { ContractRepository } from "../repositories/contractRepository";
import { WalletRepository } from "../repositories/walletRepository";
import { CreateContractParams, IContractManager } from "../contracts/contractManager";
import type { Contract } from "../contracts/types";
import { WALLET_RECEIVE_SOURCE } from "../contracts/metadata";
import { DefaultVtxo } from "../script/default";
import { DelegateVtxo } from "../script/delegate";
import { timelockToSequence } from "../utils/timelock";
import { HDDescriptorProvider } from "./hdDescriptorProvider";
import type { WalletConfig, WalletMode } from ".";

/**
 * Inputs a {@link ReceiveRotatorFactory} gets at boot to find the current display contract or
 * allocate a fresh descriptor. Allocation only: `resolveBoot` rebuilds the tapscript afterwards.
 */
export interface ReceiveRotatorBootOpts {
    walletRepository: WalletRepository;
    contractRepository: ContractRepository;
    serverPubKey: Uint8Array;
    /** When set, only this contract family is considered for the current display contract. */
    expectedContractType?: "default" | "delegate";
    /**
     * The wallet's baseline (index-0) x-only receive pubkey, used by {@link
     * WalletReceiveRotator.defaultBoot} when no tagged receive row exists. Such a wallet never
     * rotated L2, and the raw watermark can't be used: boarding shares the HD index stream, so a
     * boarding-only allocation may have advanced it.
     */
    baselineReceivePubKey?: Uint8Array;
    /** Receives rotation-failure and backoff diagnostics. Defaults to `console`. */
    logger?: Logger;
}

/**
 * Output of {@link ReceiveRotatorFactory.createReceiveRotator}: the rotator plus the receive
 * pubkey resolved at boot (existing tagged display contract's, or freshly allocated).
 */
export interface ReceiveRotatorBoot {
    rotator: WalletReceiveRotator;
    receivePubkey: Uint8Array;
}

/**
 * What {@link WalletReceiveRotator.resolveBoot} returns: the rotator, the offchain tapscript to
 * use (rebuilt to the boot pubkey if it differs), and the provider, which the wallet keeps so
 * spends route per-input signing through {@link DescriptorProvider.signWithDescriptor}.
 */
export interface ReceiveRotatorBootResult {
    rotator: WalletReceiveRotator;
    offchainTapscript: DefaultVtxo.Script | DelegateVtxo.Script;
    provider: DescriptorProvider;
}

/**
 * Opt-in {@link DescriptorProvider} extension for providers driving HD receive rotation
 * (implemented by {@link HDDescriptorProvider}). Kept out of the core interface so
 * allocate-and-sign providers needn't know the receive lifecycle; without it the wallet uses
 * {@link WalletReceiveRotator.defaultBoot}.
 */
export interface ReceiveRotatorFactory {
    createReceiveRotator(opts: ReceiveRotatorBootOpts): Promise<ReceiveRotatorBoot | undefined>;
}

/** Type guard: does this provider implement {@link ReceiveRotatorFactory}? */
export function hasReceiveRotatorFactory(
    provider: DescriptorProvider,
): provider is DescriptorProvider & ReceiveRotatorFactory {
    return typeof (provider as Partial<ReceiveRotatorFactory>).createReceiveRotator === "function";
}

/** HD-style providers can peek the current index; static providers have none. */
interface PeekableDescriptorProvider {
    getCurrentSigningDescriptor(): Promise<string | undefined>;
}
function hasPeekableDescriptor(
    provider: DescriptorProvider,
): provider is DescriptorProvider & PeekableDescriptorProvider {
    return (
        typeof (provider as Partial<PeekableDescriptorProvider>).getCurrentSigningDescriptor ===
        "function"
    );
}

// Re-exported for existing import paths; declared in `contracts/metadata` to avoid a
// contracts→wallet dependency cycle.
export { WALLET_RECEIVE_SOURCE } from "../contracts/metadata";

// captures the trailing child index N from "...xpub.../0/N)"
const TRAILING_CHILD_INDEX = /\/(\d+)\)\s*$/;

/**
 * Parse the trailing HD child index from a materialized signing descriptor
 * (`tr(...xpub.../0/<index>)`). Returns 0 when absent or unparseable: restore registers the
 * index-0 baseline untagged, so a missing descriptor legitimately means 0.
 */
export function signingDescriptorIndex(descriptor: unknown): number {
    if (typeof descriptor !== "string") return 0;
    return strictSigningDescriptorIndex(descriptor) ?? 0;
}

/**
 * The newest {@link WALLET_RECEIVE_SOURCE}-tagged contract for this server:
 * latest `createdAt`, ties broken by highest signing-descriptor index.
 */
export function newestWalletReceiveContract(
    contracts: Contract[],
    serverPubKeyHex: string,
): Contract | undefined {
    return contracts
        .filter(
            (c) =>
                c.params.serverPubKey === serverPubKeyHex &&
                c.metadata?.source === WALLET_RECEIVE_SOURCE,
        )
        .sort((a, b) => {
            if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
            return (
                signingDescriptorIndex(b.metadata?.signingDescriptor) -
                signingDescriptorIndex(a.metadata?.signingDescriptor)
            );
        })[0];
}

/**
 * Strict {@link signingDescriptorIndex}: `undefined` instead of the 0 fallback, for callers
 * (e.g. watermark moves) where mapping "unparseable" to 0 would silently do nothing.
 */
export function strictSigningDescriptorIndex(descriptor: string): number | undefined {
    const m = descriptor.match(TRAILING_CHILD_INDEX);
    if (!m) return undefined;
    const n = Number(m[1]);
    // `isSafeInteger`: past 2^53 the parse is lossy (…993 reads back as …992), which would
    // move a watermark to an index the descriptor never named.
    return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Thrown when a descriptor expected to be rangeable cannot produce a leaf pubkey, so
 * `resolveBoot` can tell this incompatibility (silent fallback under `walletMode: 'auto'`) from
 * other failures.
 */
export class NonRangeableDescriptorError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "NonRangeableDescriptorError";
    }
}

/** Minimal logging surface the rotator needs; `console` or any structured logger satisfies it. */
export interface Logger {
    error(message: string, ...args: unknown[]): void;
}

/** Cap on the exponential backoff between repeated rotation failures. */
export const ROTATION_MAX_BACKOFF_MS = 60_000;

/**
 * The wallet surface the rotator needs at runtime. An interface to avoid a circular dependency on
 * `wallet.ts`; `Wallet` satisfies it structurally.
 */
export interface RotatableWallet {
    readonly defaultContractScript: string;
    readonly network: { hrp: string };
    readonly arkServerPublicKey: Uint8Array;
    readonly offchainTapscript: DefaultVtxo.Script | DelegateVtxo.Script;
    /**
     * @internal Sole sanctioned write path for `offchainTapscript` after construction; called
     * once per rotation after the new display contract is persisted.
     */
    setOffchainTapscriptForRotation(tapscript: DefaultVtxo.Script | DelegateVtxo.Script): void;
    getContractManager(): Promise<IContractManager>;
    getAddress(): Promise<string>;
}

/**
 * Owns the wallet's HD receive-rotation lifecycle; exists only when `walletMode` resolves to a
 * {@link DescriptorProvider}.
 *
 * 1. `resolveBoot()` (before Wallet construction): reuse the display contract's pubkey or
 *    allocate the first descriptor.
 * 2. `install(wallet)`: subscribe to `vtxo_received` and rotate on matching events.
 * 3. `dispose()`: unsubscribe and drain any in-flight rotation.
 *
 * NArk parity: the provider is a pure allocator; the current address comes from the contract
 * repository, not the provider.
 */
export class WalletReceiveRotator {
    private unsubscribe?: () => void;
    private chain: Promise<void> = Promise.resolve();

    /**
     * Script of the latest tagged display contract, retired by the next `rotate()`. `undefined`
     * means the untagged index-0 baseline is displayed, which must NOT be deactivated.
     */
    private currentTaggedScript: string | undefined;

    /** Drives exponential backoff so a broken provider isn't hammered on every inbound VTXO. */
    private consecutiveFailures = 0;
    /** Unix ms before which `vtxo_received` events skip rotation; 0 = no backoff. */
    private nextRotationAllowedAt = 0;

    private readonly logger: Logger;

    private constructor(
        private readonly provider: DescriptorProvider,
        priorTaggedScript: string | undefined,
        logger?: Logger,
    ) {
        this.currentTaggedScript = priorTaggedScript;
        this.logger = logger ?? console;
    }

    /**
     * Resolve `walletMode` to a provider and build the rotator (via its
     * {@link ReceiveRotatorFactory}, else {@link defaultBoot}). Returns `undefined` for the
     * static path.
     *
     * Resolution errors propagate for `'hd'` and explicit providers (degrading would hide
     * misconfig); a {@link NonRangeableDescriptorError} is swallowed only under `'auto'`, for
     * back-compat with identities whose descriptor isn't rangeable.
     */
    static async resolveBoot(
        config: WalletConfig,
        setup: ReceiveRotatorBootOpts & {
            offchainTapscript: DefaultVtxo.Script | DelegateVtxo.Script;
        },
    ): Promise<ReceiveRotatorBootResult | undefined> {
        const provider = await resolveDescriptorProvider(config, setup.walletRepository);
        if (!provider) return undefined;

        const allowSilentFallback = (config.walletMode ?? "auto") === "auto";
        const expectedContractType: "default" | "delegate" =
            setup.offchainTapscript instanceof DelegateVtxo.Script ? "delegate" : "default";
        const factoryOpts: ReceiveRotatorBootOpts = {
            walletRepository: setup.walletRepository,
            contractRepository: setup.contractRepository,
            serverPubKey: setup.serverPubKey,
            expectedContractType,
            baselineReceivePubKey: setup.offchainTapscript.options.pubKey,
        };

        let boot: ReceiveRotatorBoot | undefined;
        try {
            boot = hasReceiveRotatorFactory(provider)
                ? await provider.createReceiveRotator(factoryOpts)
                : await WalletReceiveRotator.defaultBoot(provider, factoryOpts);
        } catch (e) {
            if (allowSilentFallback && e instanceof NonRangeableDescriptorError) {
                return undefined;
            }
            throw e;
        }
        if (!boot) return undefined;

        // Reuse the instance when pubkeys match, so callers holding the reference see no change.
        const offchainTapscript = equalBytes(
            boot.receivePubkey,
            setup.offchainTapscript.options.pubKey,
        )
            ? setup.offchainTapscript
            : rebuildTapscript(setup.offchainTapscript, boot.receivePubkey);

        return { rotator: boot.rotator, offchainTapscript, provider };
    }

    /**
     * Default boot any {@link ReceiveRotatorFactory.createReceiveRotator} can delegate to: take
     * the current display contract from the repository, else allocate/derive the receive pubkey.
     * Tapscript construction is deliberately left to `resolveBoot`.
     */
    static async defaultBoot(
        provider: DescriptorProvider,
        opts: ReceiveRotatorBootOpts,
    ): Promise<ReceiveRotatorBoot> {
        const existing = await pickActiveReceive(
            opts.contractRepository,
            opts.serverPubKey,
            opts.expectedContractType,
        );
        if (existing) {
            return {
                rotator: new WalletReceiveRotator(provider, existing.script, opts.logger),
                receivePubkey: existing.pubKey,
            };
        }

        // No tagged display contract. Fresh repo: allocate index 0 to establish the watermark, so
        // the first rotation advances past the baseline. Watermark set but untagged: L2 never
        // rotated, so use the BASELINE key, not the watermark (boarding shares the index stream
        // and may have advanced it). A repo that lost its tag self-heals on the next restore().
        const current = hasPeekableDescriptor(provider)
            ? await provider.getCurrentSigningDescriptor()
            : undefined;
        if (current === undefined) {
            const descriptor = await provider.getNextSigningDescriptor();
            return {
                rotator: new WalletReceiveRotator(provider, undefined, opts.logger),
                receivePubkey: deriveLeafPubkey(descriptor),
            };
        }
        return {
            rotator: new WalletReceiveRotator(provider, undefined, opts.logger),
            receivePubkey: opts.baselineReceivePubKey ?? deriveLeafPubkey(current),
        };
    }

    /**
     * Subscribe to `vtxo_received` and rotate whenever the current display contract receives
     * funds. Old display contracts stay watched, so earlier shared addresses keep crediting.
     */
    async install(wallet: RotatableWallet): Promise<void> {
        const manager = await wallet.getContractManager();
        this.unsubscribe = manager.onContractEvent((event) => {
            if (event.type !== "vtxo_received") return;
            if (event.contractScript !== wallet.defaultContractScript) return;
            // Serialized but deliberately NOT deduped: one receive ⇒ one fresh address, so two
            // rapid events burn two indices.
            this.chain = this.chain
                .catch(() => undefined)
                .then(() => this.runRotateWithBackoff(wallet));
        });
    }

    /**
     * One rotation attempt with exponential backoff. Errors are logged, not rethrown, so `chain`
     * never rejects and the next `vtxo_received` still runs.
     */
    private async runRotateWithBackoff(wallet: RotatableWallet): Promise<void> {
        const now = Date.now();
        if (now < this.nextRotationAllowedAt) {
            this.logger.error("WalletReceiveRotator: skipping rotation (in backoff)", {
                consecutiveFailures: this.consecutiveFailures,
                retryInMs: this.nextRotationAllowedAt - now,
            });
            return;
        }
        try {
            await this.rotate(wallet);
            this.consecutiveFailures = 0;
            this.nextRotationAllowedAt = 0;
        } catch (err) {
            this.consecutiveFailures += 1;
            // Exponent capped so long failure streaks can't overflow `2 **`.
            const exponent = Math.min(this.consecutiveFailures, 16);
            const backoffMs = Math.min(2 ** exponent * 1_000, ROTATION_MAX_BACKOFF_MS);
            this.nextRotationAllowedAt = Date.now() + backoffMs;
            this.logger.error("WalletReceiveRotator: rotation failed", err, {
                consecutiveFailures: this.consecutiveFailures,
                nextAttemptInMs: backoffMs,
            });
        }
    }

    /** Wait for any in-flight rotation to complete (mainly for tests). */
    async drain(): Promise<void> {
        await this.chain.catch(() => undefined);
    }

    /**
     * Run `fn` on the rotation chain. {@link Wallet.rotateServerSigner} uses it because both it
     * and `rotate()` swap `offchainTapscript`; interleaving could tear the visible receive state.
     * The chain advances even if `fn` rejects (the caller still sees the rejection).
     */
    runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.chain.catch(() => undefined).then(fn);
        this.chain = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    /**
     * Unsubscribe first so no late event queues work, then drain so an in-flight
     * `createContract` finishes before the contract manager disposes.
     */
    async dispose(): Promise<void> {
        if (this.unsubscribe) {
            try {
                this.unsubscribe();
            } catch {
                // best-effort teardown
            } finally {
                this.unsubscribe = undefined;
            }
        }
        await this.chain.catch(() => undefined);
    }

    /**
     * Allocate the next descriptor, register it as the new tagged display contract (same
     * default/delegate shape), swap it in, and mark the previous tagged one `inactive` (still
     * watched; it just stops being advertised). The untagged index-0 baseline is never retired.
     */
    private async rotate(wallet: RotatableWallet): Promise<void> {
        // Built locally so visible state only changes after registration succeeds: no window
        // where the displayed address is unwatched.
        const descriptor = await this.provider.getNextSigningDescriptor();
        const { tapscript: newTapscript, params } = buildReceiveContract(
            wallet.offchainTapscript,
            descriptor,
            wallet.network.hrp,
            true,
        );
        const newScript = params.script;

        const manager = await wallet.getContractManager();
        await manager.createContract(params);

        wallet.setOffchainTapscriptForRotation(newTapscript);

        // Deactivate BEFORE updating `currentTaggedScript`, so a throw here makes the next
        // rotation retry the same contract instead of orphaning it.
        const previousTagged = this.currentTaggedScript;
        if (previousTagged !== undefined && previousTagged !== newScript) {
            await manager.setContractState(previousTagged, "inactive");
        }
        this.currentTaggedScript = newScript;

        // Slide the look-ahead band. Last and best-effort: the rotation has committed, so a
        // failure must not make `runRotateWithBackoff` retry and burn another index.
        try {
            await manager.refillLookAhead();
        } catch (err) {
            this.logger.error("WalletReceiveRotator: look-ahead refill failed", err);
        }
    }
}

/** {@link deriveDescriptorLeafPubKey}, re-throwing as {@link NonRangeableDescriptorError}. */
function deriveLeafPubkey(descriptor: string): Uint8Array {
    try {
        return deriveDescriptorLeafPubKey(descriptor);
    } catch (e) {
        throw new NonRangeableDescriptorError(
            "Cannot derive leaf pubkey: descriptor is not a materialized, parsable tr(...) shape.",
            { cause: e },
        );
    }
}

/**
 * Build the receive contract owned by `descriptor`'s leaf pubkey, keeping every other option of
 * `current`. Returns the tapscript separately so the caller commits it only after persistence.
 * Shared by `rotate` and the look-ahead `materialize` so they cannot drift.
 *
 * @param tagSource - Tag the row {@link WALLET_RECEIVE_SOURCE}. Only for addresses the wallet
 * generated for itself: the next boot adopts a tagged row as the display address, which must
 * never happen for a speculative index an external party may have issued.
 */
export function buildReceiveContract(
    current: DefaultVtxo.Script | DelegateVtxo.Script,
    descriptor: string,
    hrp: string,
    tagSource: boolean,
): { tapscript: DefaultVtxo.Script | DelegateVtxo.Script; params: CreateContractParams } {
    const pubKey = deriveLeafPubkey(descriptor);
    const tapscript = rebuildTapscript(current, pubKey);
    const serverPubKey = tapscript.options.serverPubKey;
    const csvTimelock = timelockToSequence(tapscript.options.csvTimelock).toString();

    const base = {
        script: hex.encode(tapscript.pkScript),
        address: tapscript.address(hrp, serverPubKey).encode(),
        state: "active" as const,
        // Read at sign time to route rotated-pubkey inputs through `signWithDescriptor`; without
        // it spends are rejected with `INVALID_PSBT_INPUT (5): missing tapscript spend sig`.
        metadata: {
            ...(tagSource && { source: WALLET_RECEIVE_SOURCE }),
            signingDescriptor: descriptor,
        },
    };

    const params: CreateContractParams =
        tapscript instanceof DelegateVtxo.Script
            ? {
                  ...base,
                  type: "delegate",
                  params: {
                      pubKey: hex.encode(pubKey),
                      serverPubKey: hex.encode(serverPubKey),
                      delegatePubKey: hex.encode(tapscript.options.delegatePubKey),
                      csvTimelock,
                  },
              }
            : {
                  ...base,
                  type: "default",
                  params: {
                      pubKey: hex.encode(pubKey),
                      serverPubKey: hex.encode(serverPubKey),
                      csvTimelock,
                  },
              };

    return { tapscript, params };
}

/** Rebuild the offchain tapscript with a different owner pubkey, preserving shape and options. */
export function rebuildTapscript(
    current: DefaultVtxo.Script | DelegateVtxo.Script,
    pubKey: Uint8Array,
): DefaultVtxo.Script | DelegateVtxo.Script {
    if (current instanceof DelegateVtxo.Script) {
        return new DelegateVtxo.Script({ ...current.options, pubKey });
    }
    return new DefaultVtxo.Script({ ...current.options, pubKey });
}

/**
 * The newest active display contract this wallet generated for itself, or `undefined` (fresh or
 * static-only repo). Filtered by `serverPubKey` so another server's rows aren't resurrected, and
 * by the `metadata.source` tag so untagged baseline and third-party rows aren't mistaken for it.
 */
async function pickActiveReceive(
    contractRepository: ContractRepository,
    serverPubKey: Uint8Array,
    expectedType?: "default" | "delegate",
): Promise<{ pubKey: Uint8Array; script: string } | undefined> {
    const candidates = await contractRepository.getContracts({
        type: expectedType ? [expectedType] : ["default", "delegate"],
        state: "active",
    });
    const newest = newestWalletReceiveContract(candidates, hex.encode(serverPubKey));
    if (!newest?.params.pubKey) return undefined;
    try {
        return {
            pubKey: hex.decode(newest.params.pubKey),
            script: newest.script,
        };
    } catch {
        return undefined;
    }
}

/**
 * Resolve `walletMode` to a {@link DescriptorProvider}, or `undefined` for the static path.
 * `'auto'` currently behaves like `'static'` (see TODO); `'hd'` throws rather than falling back
 * if the identity isn't HD-capable or its descriptor isn't rangeable.
 */
async function resolveDescriptorProvider(
    config: WalletConfig,
    walletRepository: WalletRepository,
): Promise<DescriptorProvider | undefined> {
    const mode: WalletMode = config.walletMode ?? "auto";

    // TODO(hd-maturation): TEMPORARY — `'auto'` collapses into `'static'` until HD rotation has
    // soaked. Flip back to identity-probing once: (1) a consumer (btcpay-arkade, arkade-os/wallet,
    // Fulmine) has run `walletMode: 'hd'` on mainnet for ≥ 1 month with no fund-loss or
    // address-drift reports; (2) the `default ('auto') currently behaves like 'static'` test in
    // `test/walletHdRotation.test.ts` is flipped in the same commit; (3) the `WalletMode` doc in
    // `src/wallet/index.ts` drops its "behaves like 'static' for now" notice.
    if (mode === "static" || mode === "auto") return undefined;

    if (typeof mode !== "string") {
        // Caller supplied a DescriptorProvider directly.
        return mode;
    }

    // mode === 'hd'
    if (!isHDCapableIdentity(config.identity)) {
        throw new Error(
            "walletMode 'hd' requires an HD-capable identity " +
                "(SeedIdentity / MnemonicIdentity with a rangeable BIP-32 " +
                "descriptor) or an explicit DescriptorProvider.",
        );
    }
    try {
        return await HDDescriptorProvider.create(config.identity, walletRepository);
    } catch (e) {
        throw new Error(
            "walletMode 'hd' failed to initialize: " + (e instanceof Error ? e.message : String(e)),
            { cause: e },
        );
    }
}
