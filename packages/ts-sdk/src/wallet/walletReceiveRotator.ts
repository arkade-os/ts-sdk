import { expand, networks } from "@bitcoinerlab/descriptors-scure";
import { equalBytes } from "@scure/btc-signer/utils.js";
import { hex } from "@scure/base";

import { isMainnetDescriptor } from "../identity/descriptor";
import { DescriptorProvider } from "../identity/descriptorProvider";
import { isHDCapableIdentity } from "../identity/hdCapableIdentity";
import { ContractRepository } from "../repositories/contractRepository";
import { WalletRepository } from "../repositories/walletRepository";
import { IContractManager } from "../contracts/contractManager";
import { DefaultVtxo } from "../script/default";
import { DelegateVtxo } from "../script/delegate";
import { timelockToSequence } from "../utils/timelock";
import { HDDescriptorProvider } from "./hdDescriptorProvider";
import type { WalletConfig, WalletMode } from ".";

/**
 * Inputs the wallet hands to a {@link ReceiveRotatorFactory} when
 * asking it to construct the rotator at boot. The factory uses these
 * to look up the wallet's current display contract (or allocate a
 * fresh receive descriptor). Note: no `offchainTapscript` here — the
 * factory's job is allocation, not script construction. The wallet's
 * orchestrator (`WalletReceiveRotator.resolveBoot`) handles the
 * tapscript rebuild on top of the factory's result.
 */
export interface ReceiveRotatorBootOpts {
    walletRepository: WalletRepository;
    contractRepository: ContractRepository;
    serverPubKey: Uint8Array;
    /**
     * Expected contract family ("default" or "delegate"). When provided,
     * boot will only consider contracts of this type when looking up the
     * wallet's current display contract, preventing a default wallet from
     * accidentally picking up a delegate contract or vice versa.
     */
    expectedContractType?: "default" | "delegate";
    /**
     * Logger to receive rotation-failure + backoff diagnostics. Defaults
     * to `console` when omitted. Any object implementing
     * {@link Logger.error} works (winston, pino, Sentry breadcrumbs,
     * the runtime's own logger).
     */
    logger?: Logger;
}

/**
 * Output of {@link ReceiveRotatorFactory.createReceiveRotator}: the
 * constructed rotator paired with the receive pubkey it resolved at
 * boot (either the existing tagged display contract's pubkey, or a
 * freshly allocated one).
 */
export interface ReceiveRotatorBoot {
    rotator: WalletReceiveRotator;
    receivePubkey: Uint8Array;
}

/**
 * Result returned by {@link WalletReceiveRotator.resolveBoot} to the
 * wallet: the rotator plus the offchain tapscript the wallet should
 * actually use (rebuilt to the resolved boot pubkey when it differs
 * from the identity's static pubkey), plus the {@link DescriptorProvider}
 * the rotator was built around. The wallet retains the provider so
 * spending paths can route per-input signing through
 * {@link DescriptorProvider.signWithDescriptor} instead of the
 * identity's index-0 key.
 */
export interface ReceiveRotatorBootResult {
    rotator: WalletReceiveRotator;
    offchainTapscript: DefaultVtxo.Script | DelegateVtxo.Script;
    provider: DescriptorProvider;
}

/**
 * Opt-in extension to {@link DescriptorProvider} for providers that
 * drive HD receive rotation. Implemented by {@link HDDescriptorProvider}
 * out of the box; custom providers (HSMs, external signers, …) can also
 * implement it when they want to participate.
 *
 * Kept out of the core `DescriptorProvider` interface so providers that
 * only do allocation + signing don't have to know about the wallet's
 * receive lifecycle. The wallet detects support via
 * {@link hasReceiveRotatorFactory} (a duck-typed `instanceof`-style
 * check) and falls back to {@link WalletReceiveRotator.defaultBoot}
 * when the provider doesn't implement the extension.
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

/**
 * Type guard: does this provider expose a `getCurrentSigningDescriptor`
 * peek method? HD-style providers do (`HDDescriptorProvider`); static
 * providers don't because the concept of a "current index" is
 * meaningless for them.
 */
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

/**
 * Sentinel value stored in `contract.metadata.source` to identify the
 * wallet's current display contract. Borrowed from btcpay-arkade's
 * source-tagging pattern: every contract records "where and why it was
 * generated", and the wallet only cares about the ones it generated for
 * its own receive address.
 *
 * Tagging makes the boot lookup unambiguous — the rotator filters on
 * `metadata.source === WALLET_RECEIVE_SOURCE` rather than on "any active
 * default contract", so a contract repo that also holds default contracts
 * created for other reasons (legacy timelock variants, external
 * integrations) doesn't confuse the wallet's display state.
 */
export const WALLET_RECEIVE_SOURCE = "wallet-receive";

/**
 * Thrown when a descriptor expected to be rangeable (have a wildcard
 * leaf) cannot produce a leaf pubkey. Surfaces from the rotator's
 * `defaultBoot` path so `resolveBoot` can distinguish a legitimate
 * incompatibility (silent fallback under `walletMode: 'auto'`) from
 * any other runtime failure.
 */
export class NonRangeableDescriptorError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "NonRangeableDescriptorError";
    }
}

/**
 * Minimal logging surface the rotator needs. `console` satisfies it
 * out of the box; SDK consumers can pass a structured logger
 * (winston / pino / Sentry adapter) via {@link ReceiveRotatorBootOpts}
 * to capture rotation failures + backoff diagnostics through their
 * own pipeline.
 */
export interface Logger {
    error(message: string, ...args: unknown[]): void;
}

/**
 * Cap on the exponential backoff applied to repeated rotation
 * failures. After this delay, every fresh `vtxo_received` event
 * re-attempts a rotation at this rate until one succeeds (which
 * resets the counter) or the wallet is disposed.
 */
export const ROTATION_MAX_BACKOFF_MS = 60_000;

/**
 * Narrow surface the rotator needs from the wallet at runtime: the
 * mutable display tapscript, the display contract's script hex, the
 * contract manager (for subscribing + registering rotated contracts),
 * and the display address (for the contract's `address` field).
 *
 * Kept as an interface so the rotator module avoids a circular
 * dependency on `wallet.ts`. `Wallet` implements this surface
 * structurally — no `implements` clause is required.
 */
export interface RotatableWallet {
    readonly defaultContractScript: string;
    readonly network: { hrp: string };
    readonly arkServerPublicKey: Uint8Array;
    readonly offchainTapscript: DefaultVtxo.Script | DelegateVtxo.Script;
    /**
     * @internal Sole sanctioned write path for `offchainTapscript`
     * after construction. The rotator calls this once per rotation
     * after persisting the new display contract.
     */
    setOffchainTapscriptForRotation(tapscript: DefaultVtxo.Script | DelegateVtxo.Script): void;
    getContractManager(): Promise<IContractManager>;
    getAddress(): Promise<string>;
}

/**
 * Owns the wallet's HD receive-rotation lifecycle.
 *
 * The rotator is constructed only when the wallet's `walletMode`
 * resolves to a {@link DescriptorProvider}; static wallets and
 * non-HD-capable wallets under `'auto'` never see one.
 *
 * Lifecycle:
 * 1. `resolveBoot()` — pre-Wallet-construction. Resolves the provider
 *    from `walletMode`, then either reuses the existing display
 *    contract's pubkey (if any) or allocates the first descriptor.
 *    Returns the rotator paired with the boot pubkey.
 * 2. `install(wallet)` — post-`getVtxoManager()`. Subscribes to
 *    `vtxo_received` on the contract manager and routes matching events
 *    through the rotation chain.
 * 3. `dispose()` — tears down the subscription and drains any in-flight
 *    rotation so the contract manager can be disposed cleanly.
 *
 * This class follows the dotnet-sdk's split of responsibilities: the
 * provider is a pure rotating allocator; "what address am I currently
 * bound to?" is answered by querying the contract repository, not by
 * asking the provider.
 */
export class WalletReceiveRotator {
    private unsubscribe?: () => void;
    private chain: Promise<void> = Promise.resolve();

    /**
     * Script of the most-recent tagged display contract — populated
     * either from the boot-time repo lookup or from the previous
     * `rotate()` call within this session. The next `rotate()` marks
     * this contract `inactive` once the new tagged contract is in
     * place. `undefined` means the wallet's current display is the
     * untagged index-0 baseline (no rotation has happened yet on this
     * repo), and the baseline must NOT be deactivated.
     */
    private currentTaggedScript: string | undefined;

    /**
     * Consecutive rotation failures since the last successful rotate.
     * Drives an exponential backoff (capped at
     * {@link ROTATION_MAX_BACKOFF_MS}) so a broken provider can't make
     * the rotator hammer `getNextSigningDescriptor` + `createContract`
     * on every inbound VTXO. Reset to zero on a successful rotate.
     */
    private consecutiveFailures = 0;
    /**
     * Unix-ms timestamp before which incoming `vtxo_received` events
     * skip the rotation attempt entirely. Zero means "no backoff
     * active" — the next event can rotate immediately.
     */
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
     * Phase 1 — pre-Wallet-construction. Resolves `walletMode` to a
     * {@link DescriptorProvider}, then asks that provider to construct
     * the rotator (delegated through
     * {@link DescriptorProvider.createReceiveRotator}, which falls back
     * to {@link defaultBoot} when the provider doesn't override it).
     *
     * Returns the rotator paired with the offchain tapscript the wallet
     * should actually install (rebuilt to the resolved receive pubkey
     * when it differs from the identity's static pubkey), or
     * `undefined` when the wallet should stay on the static path.
     *
     * Errors during pubkey resolution propagate when:
     * - `walletMode === 'hd'` (caller asked for HD; loud failure expected).
     * - `walletMode` is a {@link DescriptorProvider} (caller supplied an
     *   explicit allocator; silently degrading would hide misconfig).
     *
     * Errors are silently swallowed (returning `undefined`) only under
     * `walletMode: 'auto'` with the built-in HD provider, to preserve
     * backwards compatibility with wallets whose identity descriptor
     * isn't actually rangeable.
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
        };

        let boot: ReceiveRotatorBoot | undefined;
        try {
            boot = hasReceiveRotatorFactory(provider)
                ? await provider.createReceiveRotator(factoryOpts)
                : await WalletReceiveRotator.defaultBoot(provider, factoryOpts);
        } catch (e) {
            // Only swallow non-rangeable-descriptor errors, and only
            // under `walletMode: 'auto'`. Explicit HD/`DescriptorProvider`
            // callers always see the failure.
            if (allowSilentFallback && e instanceof NonRangeableDescriptorError) {
                return undefined;
            }
            throw e;
        }
        if (!boot) return undefined;

        // Rebuild the offchain tapscript with the resolved receive
        // pubkey. Skipping the rebuild when pubkeys already match keeps
        // the tapscript instance stable for static / first-boot paths
        // (no allocation churn, no observable change for callers
        // that retain the reference across `Wallet.create`).
        const offchainTapscript = equalBytes(
            boot.receivePubkey,
            setup.offchainTapscript.options.pubKey,
        )
            ? setup.offchainTapscript
            : rebuildTapscript(setup.offchainTapscript, boot.receivePubkey);

        return { rotator: boot.rotator, offchainTapscript, provider };
    }

    /**
     * Default factory-shaped boot any
     * {@link ReceiveRotatorFactory.createReceiveRotator} implementation
     * can delegate to. Pulls the wallet's current display contract from
     * the contract repository (or allocates a fresh receive descriptor
     * via the provider when no tagged display contract exists), and
     * returns the rotator paired with the resolved receive pubkey.
     *
     * Used internally by `resolveBoot` when the provider doesn't
     * implement {@link ReceiveRotatorFactory}. Exported so providers
     * that *do* override can still invoke the default work for the
     * parts of the boot path they don't want to customise. Tapscript
     * construction is intentionally NOT in here — that's the
     * orchestrator's job.
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

        // No tagged display contract on this repo. Avoid burning a
        // fresh HD index per restart: re-derive the descriptor at the
        // most recently allocated index when the provider supports it
        // (HD-style allocators do; static / one-shot providers don't
        // and fall through to a regular allocation, which is a no-op
        // for them anyway).
        let descriptor: string | undefined;
        if (hasPeekableDescriptor(provider)) {
            descriptor = await provider.getCurrentSigningDescriptor();
        }
        descriptor ??= await provider.getNextSigningDescriptor();

        return {
            rotator: new WalletReceiveRotator(provider, undefined, opts.logger),
            receivePubkey: deriveLeafPubkey(descriptor),
        };
    }

    /**
     * Phase 2 — post-`getVtxoManager()`. Subscribe to `vtxo_received`
     * and trigger a rotation whenever the currently-active display
     * contract receives funds. Old display contracts remain `active`
     * in the repo so earlier shared addresses keep crediting this
     * wallet.
     */
    async install(wallet: RotatableWallet): Promise<void> {
        const manager = await wallet.getContractManager();
        this.unsubscribe = manager.onContractEvent((event) => {
            if (event.type !== "vtxo_received") return;
            if (event.contractScript !== wallet.defaultContractScript) return;
            // Serialise rotations: each `vtxo_received` event is its
            // own rotation trigger (BIP-44-style: one receive ⇒ one
            // fresh address), so two rapid events on the same script
            // are *expected* to burn two consecutive HD indices. The
            // chain here only prevents the rotate → rebuild →
            // createContract sequences from interleaving; it does not
            // — and intentionally does not — dedupe events on the same
            // script. `runRotateWithBackoff` owns the failure handling
            // — it logs, increments the consecutive-failure counter,
            // and gates future attempts behind exponential backoff so
            // a broken provider can't make the rotator hammer
            // `createContract` on every event.
            this.chain = this.chain
                .catch(() => undefined)
                .then(() => this.runRotateWithBackoff(wallet));
        });
    }

    /**
     * Run a single rotation attempt, applying exponential backoff on
     * failure. Public-shaped behavior:
     * - During a backoff window: log + skip (no `rotate()` call).
     * - On success: reset failure count and backoff.
     * - On failure: increment counter, schedule next attempt at
     *   `min(2^consecutiveFailures * 1s, ROTATION_MAX_BACKOFF_MS)`.
     *
     * Errors are deliberately swallowed (logged, not rethrown) so the
     * surrounding `chain` Promise never settles to rejected — the next
     * `vtxo_received` event must still get a chance to run.
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
            // 2^1=2s, 2^2=4s, … capped at ROTATION_MAX_BACKOFF_MS (60s).
            // `Math.min` on the exponent prevents `2 ** 1024` overflow
            // for pathologically long failure streaks.
            const exponent = Math.min(this.consecutiveFailures, 16);
            const backoffMs = Math.min(2 ** exponent * 1_000, ROTATION_MAX_BACKOFF_MS);
            this.nextRotationAllowedAt = Date.now() + backoffMs;
            this.logger.error("WalletReceiveRotator: rotation failed", err, {
                consecutiveFailures: this.consecutiveFailures,
                nextAttemptInMs: backoffMs,
            });
        }
    }

    /**
     * Wait for any in-flight rotation to complete. Useful in tests
     * that need to observe the post-rotation state after dispatching
     * a `vtxo_received` event synchronously; production code rarely
     * needs to call this directly.
     */
    async drain(): Promise<void> {
        await this.chain.catch(() => undefined);
    }

    /**
     * Tear down the subscription first so no late `vtxo_received` event
     * can queue work on a disposing wallet, then drain any in-flight
     * rotation so its `createContract` finishes before the contract
     * manager itself disposes.
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
     * Allocate the next descriptor, swap it into the wallet's active
     * offchain tapscript, register the new tagged contract, and retire
     * the previous tagged contract (if any) by setting its state to
     * `inactive`. The contract watcher keeps watching inactive
     * contracts until their VTXOs are spent, so funds in flight at the
     * old display address are not lost — only the address stops being
     * advertised.
     *
     * Contract type matches the wallet's tapscript shape: a default
     * wallet rotates to a new `default` contract, a delegate wallet to
     * a new `delegate` contract.
     *
     * The first rotation on a fresh wallet does NOT deactivate
     * anything: `currentTaggedScript` is `undefined` because the wallet
     * was displaying the untagged index-0 baseline, which must stay
     * active forever.
     */
    private async rotate(wallet: RotatableWallet): Promise<void> {
        // Build the new tapscript + derived strings entirely locally,
        // so the wallet's visible state (`offchainTapscript`,
        // `defaultContractScript`, `getAddress()`) doesn't change
        // until the contract registration has succeeded. If
        // `createContract` throws partway, the wallet is still
        // displaying the OLD (registered) address — no
        // unwatched-display-window.
        const descriptor = await this.provider.getNextSigningDescriptor();
        const pubKey = deriveLeafPubkey(descriptor);
        const newTapscript = rebuildTapscript(wallet.offchainTapscript, pubKey);
        const newScript = hex.encode(newTapscript.pkScript);
        const newAddress = newTapscript
            .address(wallet.network.hrp, wallet.arkServerPublicKey)
            .encode();

        const manager = await wallet.getContractManager();
        const csvTimelock = newTapscript.options.csvTimelock ?? DefaultVtxo.Script.DEFAULT_TIMELOCK;
        const csvTimelockStr = timelockToSequence(csvTimelock).toString();
        const serverPubKeyHex = hex.encode(newTapscript.options.serverPubKey);

        const baseParams = {
            script: newScript,
            address: newAddress,
            state: "active" as const,
            // Persist the materialized signing descriptor alongside the
            // source tag. The wallet's spending paths read this at sign
            // time to route inputs locked by a rotated pubkey through
            // `DescriptorProvider.signWithDescriptor` instead of the
            // identity's index-0 key. Without it, post-rotation sends
            // produce unsigned PSBTs that the server rejects with
            // `INVALID_PSBT_INPUT (5): missing tapscript spend sig`.
            metadata: {
                source: WALLET_RECEIVE_SOURCE,
                signingDescriptor: descriptor,
            },
        };

        if (newTapscript instanceof DelegateVtxo.Script) {
            await manager.createContract({
                ...baseParams,
                type: "delegate",
                params: {
                    pubKey: hex.encode(pubKey),
                    serverPubKey: serverPubKeyHex,
                    delegatePubKey: hex.encode(newTapscript.options.delegatePubKey),
                    csvTimelock: csvTimelockStr,
                },
            });
        } else {
            await manager.createContract({
                ...baseParams,
                type: "default",
                params: {
                    pubKey: hex.encode(pubKey),
                    serverPubKey: serverPubKeyHex,
                    csvTimelock: csvTimelockStr,
                },
            });
        }

        // Persistence succeeded — commit the new tapscript to the
        // wallet's visible state. From this point onward
        // `wallet.defaultContractScript` and `getAddress()` reflect
        // the rotated identity. `setOffchainTapscriptForRotation` is
        // the only write path; the field is read-only otherwise.
        wallet.setOffchainTapscriptForRotation(newTapscript);

        // Retire the previous tagged contract (if any). The order
        // matters: deactivate FIRST, then update `currentTaggedScript`,
        // so that if `setContractState` throws the next rotation will
        // retry deactivating the same orphaned contract instead of
        // racing forward and orphaning the new one.
        const previousTagged = this.currentTaggedScript;
        if (previousTagged !== undefined && previousTagged !== newScript) {
            await manager.setContractState(previousTagged, "inactive");
        }
        this.currentTaggedScript = newScript;
    }
}

/**
 * Extract the x-only (32-byte) pubkey from a materialized HD descriptor.
 *
 * `expand()` populates `@0.pubkey` for non-ranged descriptors (including
 * HD ones where a concrete child index has been substituted for the
 * wildcard). This sidesteps `extractPubKey`, which intentionally rejects
 * any descriptor carrying a `bip32` key because it was designed for
 * static `tr(pubkey)` inputs.
 */
function deriveLeafPubkey(descriptor: string): Uint8Array {
    const network = isMainnetDescriptor(descriptor) ? networks.bitcoin : networks.testnet;
    // `expand` raises when the descriptor still carries a wildcard or
    // is otherwise non-rangeable. Wrap so callers (most importantly
    // `resolveBoot`'s silent-fallback path) can branch on a typed
    // error class instead of grepping `err.message`.
    let expansion;
    try {
        expansion = expand({ descriptor, network });
    } catch (e) {
        throw new NonRangeableDescriptorError(
            `Cannot derive leaf pubkey from descriptor (length=${descriptor.length}): ` +
                `ensure the descriptor is materialized (no wildcard) and parsable.`,
            { cause: e },
        );
    }
    const key = expansion.expansionMap?.["@0"];
    if (!key?.pubkey) {
        // Avoid interpolating the descriptor itself: it normally
        // contains an xpub, but a misconfigured caller could pass an
        // xprv, and error messages surface in logs / crash reporters /
        // Sentry. The length is enough context for debugging.
        throw new NonRangeableDescriptorError(
            `Cannot derive leaf pubkey from descriptor (length=${descriptor.length}): ` +
                `descriptor parsed but no '@0' pubkey was found in the expansion map. ` +
                `The rotator expects a materialized tr(xpub/.../*) shape; ensure the ` +
                `descriptor has no wildcard and that its key resolves into the '@0' slot.`,
        );
    }
    return key.pubkey;
}

/**
 * Rebuild the given offchain tapscript with a different owner pubkey,
 * preserving its {@link DelegateVtxo.Script} vs {@link DefaultVtxo.Script}
 * shape and all other options.
 *
 * Exported because the wallet's boot path also needs to rebuild the
 * initial tapscript when the resolved boot pubkey differs from the
 * identity's default pubkey.
 */
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
 * Look up the most-recently-created active tagged display contract that
 * this wallet itself generated. Returns the contract's pubkey + script,
 * or `undefined` when no such contract exists — the caller should treat
 * that as "fresh wallet (or static-only history) on this repo" and
 * allocate a new descriptor.
 *
 * Filters by `serverPubKey` so a contract repo seeded against a different
 * server doesn't accidentally resurrect an unrelated pubkey, and by the
 * `metadata.source` sentinel so untagged baseline contracts (and
 * contracts created by other code paths — legacy timelock registrations,
 * external integrations) are not mistaken for the wallet's display
 * address.
 *
 * When `expectedType` is provided, only contracts of that type are considered,
 * preventing a "default" wallet from accidentally picking up a "delegate" contract
 * or vice versa.
 */
async function pickActiveReceive(
    contractRepository: ContractRepository,
    serverPubKey: Uint8Array,
    expectedType?: "default" | "delegate",
): Promise<{ pubKey: Uint8Array; script: string } | undefined> {
    // Both `default` and `delegate` contract types can be the wallet's
    // display address (delegate wallets use the delegate variant). The
    // `metadata.source` tag is the discriminator that says "this is the
    // one I generated for myself."
    const candidates = await contractRepository.getContracts({
        type: expectedType ? [expectedType] : ["default", "delegate"],
        state: "active",
    });
    const serverPubKeyHex = hex.encode(serverPubKey);
    const matching = candidates
        .filter(
            (c) =>
                c.params.serverPubKey === serverPubKeyHex &&
                c.metadata?.source === WALLET_RECEIVE_SOURCE,
        )
        .sort((a, b) => b.createdAt - a.createdAt);
    const newest = matching[0];
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
 * Resolve the polymorphic `walletMode` config field into a concrete
 * {@link DescriptorProvider} (or `undefined` for the static path).
 *
 * - `'auto'` *(default)*: **short-term**, behaves like `'static'` — no
 *   HD rotation. See the `TODO` below for the criteria to flip this
 *   back to the identity-probing behaviour.
 * - `'static'`: returns `undefined`.
 * - A {@link DescriptorProvider} instance: returns it as-is.
 * - `'hd'`: builds the built-in HD provider from the identity. Throws
 *   if the identity isn't HD-capable or the descriptor isn't rangeable —
 *   no silent fallback.
 */
async function resolveDescriptorProvider(
    config: WalletConfig,
    walletRepository: WalletRepository,
): Promise<DescriptorProvider | undefined> {
    const mode: WalletMode = config.walletMode ?? "auto";

    // TODO(hd-maturation): TEMPORARY — collapse `'auto'` into `'static'`
    // until the HD receive-rotation pipeline has soaked in the field.
    // Flip `'auto'` back to its identity-probing behaviour once:
    //   1. At least one consumer (btcpay-arkade, arkade-os/wallet,
    //      Fulmine) has been running with `walletMode: 'hd'` against
    //      mainnet for ≥ 1 month with no rotation-induced fund-loss
    //      or address-drift reports.
    //   2. The test `default ('auto') currently behaves like 'static'`
    //      in `test/walletHdRotation.test.ts` is flipped in the same
    //      commit (it's the explicit gate — flipping the default
    //      MUST flip the test).
    //   3. The `WalletMode` docstring in `src/wallet/index.ts` is
    //      updated to drop the "behaves like 'static' for now" notice.
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
