import { Bytes } from '@scure/btc-signer/utils.js';
import { B as BatchStartedEvent, s as TreeSigningStartedEvent, t as TxTree, u as TreeNoncesEvent, v as BatchFinalizationEvent, w as BatchFinalizedEvent, x as BatchFailedEvent, y as TreeTxEvent, z as TreeSignatureEvent, h as SettlementEvent, b as WalletConfig, W as WalletRepository, C as ContractRepository, D as DescriptorProvider, e as IContractManager, F as IReadonlyWallet, H as ReadonlyIdentity, N as Network, O as OnchainProvider, n as IndexerProvider, J as DelegateProvider, K as ReadonlyWalletConfig, o as RelativeTimelock, L as IReadonlyAssetManager, m as ArkProvider, M as NetworkName, P as ArkInfo, Q as ArkAddress, c as WalletBalance, G as GetVtxosFilter, E as ExtendedVirtualCoin, A as ArkTransaction, d as ExtendedCoin, U as Coin, X as ContractManager, I as IWallet, Y as CSVMultisigTapscript, a as Identity, Z as SettlementConfig, i as IAssetManager, _ as VtxoManager, f as IDelegateManager, S as SendBitcoinParams, g as SettleParams, R as Recipient, $ as SignerSession, a0 as SignedIntent, a1 as Intent } from './ark-loKbOrJY.cjs';
import { TransactionOutput } from '@scure/btc-signer/psbt.js';
import { D as DefaultVtxo, a as DelegateVtxo } from './delegate-CzW02oQB.cjs';

/**
 * Batch namespace provides utilities for joining and processing batch session.
 * The batch settlement process involves multiple events, this namespace provides abstractions and types to handle them.
 * @see https://docs.arkadeos.com/learn/pillars/batch-swaps
 * @example
 * ```typescript
 * // use wallet handler or create a custom one
 * const handler = wallet.createBatchHandler(intentId, inputs, expectedRecipients, musig2session);
 *
 * const abortController = new AbortController();
 * // Get event stream from the Arkade provider
 * const eventStream = arkProvider.getEventStream(
 *   abortController.signal,
 *   ['your-topic-1', 'your-topic-2']
 * );
 *
 * // Join the batch and process events
 * try {
 *   const commitmentTxid = await Batch.join(eventStream, handler);
 *   console.log('Batch completed with commitment:', commitmentTxid);
 * } catch (error) {
 *   console.error('Batch processing failed:', error);
 * } finally {
 *   abortController.abort();
 * }
 * ```
 */
declare namespace Batch {
    interface Handler {
        /**
         * Called on BatchStarted event.
         * @returns { skip: boolean } indicating whether the batch should be skipped or not.
         */
        onBatchStarted(event: BatchStartedEvent): Promise<{
            skip: boolean;
        }>;
        /**
         * Called when tree signing starts.
         * @param event The tree signing started event.
         * @param vtxoTree The unsigned virtual output tree, reconstructed from the TreeTxEvent events.
         * @returns Promise resolving to a boolean indicating whether to continue processing.
         */
        onTreeSigningStarted(event: TreeSigningStartedEvent, vtxoTree: TxTree): Promise<{
            skip: boolean;
        }>;
        /**
         * Called when tree nonces are received.
         * @param event The tree nonces event.
         * @returns Promise resolving to a boolean indicating whether signing is complete.
         */
        onTreeNonces(event: TreeNoncesEvent): Promise<{
            fullySigned: boolean;
        }>;
        /**
         * Called during batch finalization.
         * @param event The batch finalization event.
         * @param vtxoTree The signed virtual output tree, reconstructed from the TreeTxEvent events.
         * @param connectorTree The connector transaction tree, reconstructed from the TreeTxEvent events.
         */
        onBatchFinalization(event: BatchFinalizationEvent, vtxoTree?: TxTree, connectorTree?: TxTree): Promise<void>;
        /**
         * Called when batch finalization completes successfully.
         *
         * @param event - Batch finalized event
         */
        onBatchFinalized?(event: BatchFinalizedEvent): Promise<void>;
        /**
         * Called when batch processing fails.
         *
         * @param event - Batch failed event
         */
        onBatchFailed?(event: BatchFailedEvent): Promise<void>;
        /**
         * Called for each virtual output tree transaction chunk received during batch processing.
         *
         * @param event - Tree transaction event
         */
        onTreeTxEvent?(event: TreeTxEvent): Promise<void>;
        /**
         * Called for each tree signature event received during batch processing.
         *
         * @param event - Tree signature event
         */
        onTreeSignatureEvent?(event: TreeSignatureEvent): Promise<void>;
    }
    /**
     * Options for the join function.
     *
     * @property abortController - Abort controller used to cancel batch processing.
     * @property skipVtxoTreeSigning - Ignore events related to the virtual output tree musig2 signing session.
     * @property eventCallback - Callback invoked for each settlement event received while joining the batch.
     */
    type JoinOptions = Partial<{
        abortController: AbortController;
        skipVtxoTreeSigning: boolean;
        eventCallback: (event: SettlementEvent) => Promise<void>;
    }>;
    /**
     * Start the state machine that will process the batch events and join a batch.
     * @param eventIterator - The events stream to process.
     * @param handler - How to react to events.
     * @param options - Options.
     */
    function join(eventIterator: AsyncIterableIterator<SettlementEvent>, handler: Handler, options?: JoinOptions): Promise<string>;
}

/**
 * Inputs the wallet hands to a {@link ReceiveRotatorFactory} when
 * asking it to construct the rotator at boot. The factory uses these
 * to look up the wallet's current display contract (or allocate a
 * fresh receive descriptor). Note: no `offchainTapscript` here — the
 * factory's job is allocation, not script construction. The wallet's
 * orchestrator (`WalletReceiveRotator.resolveBoot`) handles the
 * tapscript rebuild on top of the factory's result.
 */
interface ReceiveRotatorBootOpts {
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
interface ReceiveRotatorBoot {
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
interface ReceiveRotatorBootResult {
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
interface ReceiveRotatorFactory {
    createReceiveRotator(opts: ReceiveRotatorBootOpts): Promise<ReceiveRotatorBoot | undefined>;
}
/**
 * Minimal logging surface the rotator needs. `console` satisfies it
 * out of the box; SDK consumers can pass a structured logger
 * (winston / pino / Sentry adapter) via {@link ReceiveRotatorBootOpts}
 * to capture rotation failures + backoff diagnostics through their
 * own pipeline.
 */
interface Logger {
    error(message: string, ...args: unknown[]): void;
}
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
interface RotatableWallet {
    readonly defaultContractScript: string;
    readonly network: {
        hrp: string;
    };
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
declare class WalletReceiveRotator {
    private readonly provider;
    private unsubscribe?;
    private chain;
    /**
     * Script of the most-recent tagged display contract — populated
     * either from the boot-time repo lookup or from the previous
     * `rotate()` call within this session. The next `rotate()` marks
     * this contract `inactive` once the new tagged contract is in
     * place. `undefined` means the wallet's current display is the
     * untagged index-0 baseline (no rotation has happened yet on this
     * repo), and the baseline must NOT be deactivated.
     */
    private currentTaggedScript;
    /**
     * Consecutive rotation failures since the last successful rotate.
     * Drives an exponential backoff (capped at
     * {@link ROTATION_MAX_BACKOFF_MS}) so a broken provider can't make
     * the rotator hammer `getNextSigningDescriptor` + `createContract`
     * on every inbound VTXO. Reset to zero on a successful rotate.
     */
    private consecutiveFailures;
    /**
     * Unix-ms timestamp before which incoming `vtxo_received` events
     * skip the rotation attempt entirely. Zero means "no backoff
     * active" — the next event can rotate immediately.
     */
    private nextRotationAllowedAt;
    private readonly logger;
    private constructor();
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
    static resolveBoot(config: WalletConfig, setup: ReceiveRotatorBootOpts & {
        offchainTapscript: DefaultVtxo.Script | DelegateVtxo.Script;
    }): Promise<ReceiveRotatorBootResult | undefined>;
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
    static defaultBoot(provider: DescriptorProvider, opts: ReceiveRotatorBootOpts): Promise<ReceiveRotatorBoot>;
    /**
     * Phase 2 — post-`getVtxoManager()`. Subscribe to `vtxo_received`
     * and trigger a rotation whenever the currently-active display
     * contract receives funds. Old display contracts remain `active`
     * in the repo so earlier shared addresses keep crediting this
     * wallet.
     */
    install(wallet: RotatableWallet): Promise<void>;
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
    private runRotateWithBackoff;
    /**
     * Wait for any in-flight rotation to complete. Useful in tests
     * that need to observe the post-rotation state after dispatching
     * a `vtxo_received` event synchronously; production code rarely
     * needs to call this directly.
     */
    drain(): Promise<void>;
    /**
     * Tear down the subscription first so no late `vtxo_received` event
     * can queue work on a disposing wallet, then drain any in-flight
     * rotation so its `createContract` finishes before the contract
     * manager itself disposes.
     */
    dispose(): Promise<void>;
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
    private rotate;
}

type IncomingFunds = {
    type: "utxo";
    coins: Coin[];
} | {
    type: "vtxo";
    newVtxos: ExtendedVirtualCoin[];
    spentVtxos: ExtendedVirtualCoin[];
};

declare class ReadonlyWallet implements IReadonlyWallet {
    readonly identity: ReadonlyIdentity;
    readonly network: Network;
    readonly onchainProvider: OnchainProvider;
    readonly indexerProvider: IndexerProvider;
    readonly arkServerPublicKey: Bytes;
    readonly boardingTapscript: DefaultVtxo.Script;
    readonly dustAmount: bigint;
    readonly walletRepository: WalletRepository;
    readonly contractRepository: ContractRepository;
    readonly delegateProvider?: DelegateProvider | undefined;
    private _contractManager?;
    private _contractManagerInitializing?;
    protected readonly watcherConfig?: ReadonlyWalletConfig["watcherConfig"];
    private readonly _assetManager;
    private _syncVtxosInflight?;
    readonly walletContractTimelocks: RelativeTimelock[];
    protected _pendingSpendOutpoints: Set<string>;
    get assetManager(): IReadonlyAssetManager;
    /**
     * Backing field for the active receive tapscript. Read via the
     * public `offchainTapscript` getter; written only by
     * {@link Wallet.setOffchainTapscriptForRotation}, which
     * {@link WalletReceiveRotator.rotate} is the sole intended caller of.
     */
    protected _offchainTapscript: DefaultVtxo.Script | DelegateVtxo.Script;
    protected constructor(identity: ReadonlyIdentity, network: Network, onchainProvider: OnchainProvider, indexerProvider: IndexerProvider, arkServerPublicKey: Bytes, offchainTapscript: DefaultVtxo.Script | DelegateVtxo.Script, boardingTapscript: DefaultVtxo.Script, dustAmount: bigint, walletRepository: WalletRepository, contractRepository: ContractRepository, delegateProvider?: DelegateProvider | undefined, watcherConfig?: ReadonlyWalletConfig["watcherConfig"], walletContractTimelocks?: RelativeTimelock[]);
    /**
     * Currently-active receive tapscript. Read-only from the outside;
     * mutated only via {@link Wallet.setOffchainTapscriptForRotation}
     * by {@link WalletReceiveRotator.rotate}.
     */
    get offchainTapscript(): DefaultVtxo.Script | DelegateVtxo.Script;
    /**
     * Protected helper to set up shared wallet configuration.
     * Extracts common logic used by both ReadonlyWallet.create() and Wallet.create().
     */
    protected static setupWalletConfig(config: ReadonlyWalletConfig, pubKey: Uint8Array): Promise<{
        arkProvider: ArkProvider;
        indexerProvider: IndexerProvider;
        onchainProvider: OnchainProvider;
        network: Network;
        networkName: NetworkName;
        serverPubKey: Uint8Array<ArrayBuffer>;
        offchainTapscript: DefaultVtxo.Script | DelegateVtxo.Script;
        boardingTapscript: DefaultVtxo.Script;
        dustAmount: bigint;
        walletRepository: WalletRepository;
        contractRepository: ContractRepository;
        info: ArkInfo;
        delegateProvider: DelegateProvider | undefined;
        /** @deprecated alias for `delegateProvider` */
        delegatorProvider: DelegateProvider | undefined;
        walletContractTimelocks: RelativeTimelock[];
    }>;
    /**
     * Create a readonly wallet for querying balances, addresses, and history.
     *
     * @param config - Readonly wallet configuration
     * @returns A readonly wallet instance
     */
    static create(config: ReadonlyWalletConfig): Promise<ReadonlyWallet>;
    get arkAddress(): ArkAddress;
    /**
     * Get the pkScript hex for the wallet's primary offchain address.
     * For the full wallet-owned script set registered in ContractManager, use getWalletScripts().
     */
    get defaultContractScript(): string;
    /** Returns the wallet's Arkade address. */
    getAddress(): Promise<string>;
    /** Returns the onchain boarding address used to move funds into Arkade. */
    getBoardingAddress(): Promise<string>;
    /**
     * Return the wallet's combined onchain and offchain balances.
     */
    getBalance(): Promise<WalletBalance>;
    /**
     * Return virtual outputs tracked by the wallet.
     *
     * @param filter - Optional flags controlling whether recoverable or unrolled VTXOs are included
     */
    getVtxos(filter?: GetVtxosFilter): Promise<ExtendedVirtualCoin[]>;
    /**
     * Return wallet transaction history derived from Arkade state and boarding transactions.
     */
    getTransactionHistory(): Promise<ArkTransaction[]>;
    /**
     * Clear the global VTXO sync cursor, forcing a full re-bootstrap on next sync.
     * Useful for recovery after indexer reprocessing or debugging.
     */
    clearSyncCursor(): Promise<void>;
    /**
     * Build a transaction history view for the wallet's boarding address.
     */
    getBoardingTxs(): Promise<{
        boardingTxs: ArkTransaction[];
        commitmentsToIgnore: Set<string>;
    }>;
    /**
     * Fetch and cache onchain inputs (UTXOs) received at the boarding address.
     */
    getBoardingUtxos(): Promise<ExtendedCoin[]>;
    /**
     * Subscribe to onchain and offchain notifications for newly received funds.
     *
     * @param eventCallback - Callback invoked when matching funds are detected
     * @returns A function that stops the subscriptions
     */
    notifyIncomingFunds(eventCallback: (coins: IncomingFunds) => void): Promise<() => void>;
    /** Fetch Arkade transaction ids that are still pending final settlement. */
    fetchPendingTxs(): Promise<string[]>;
    /**
     * Get all pkScript hex strings for the wallet's own addresses
     * (both delegate and non-delegate, current and historical).
     */
    getWalletScripts(): Promise<string[]>;
    /**
     * Build a map of scriptHex → VtxoScript for all wallet contracts,
     * so virtual outputs can be extended with the correct tapscript per contract.
     */
    getScriptMap(): Promise<Map<string, DefaultVtxo.Script | DelegateVtxo.Script>>;
    /**
     * Get the ContractManager for managing contracts including the wallet's default address.
     *
     * The ContractManager handles:
     * - The wallet's default receiving address (as a "default" contract)
     * - External contracts (Boltz swaps, HTLCs, etc.)
     * - Multi-contract watching with resilient connections
     *
     * @example
     * ```typescript
     * const manager = await wallet.getContractManager();
     *
     * // Create a contract for a Boltz swap
     * const contract = await manager.createContract({
     *   label: "Boltz Swap",
     *   type: "vhtlc",
     *   params: { ... },
     *   script: swapScript,
     *   address: swapAddress,
     * });
     *
     * // Start watching for events (includes wallet's default address)
     * const stop = await manager.onContractEvent((event) => {
     *   console.log(`${event.type} on ${event.contractScript}`);
     * });
     * ```
     */
    getContractManager(): Promise<ContractManager>;
    private initializeContractManager;
    /** Dispose wallet-owned managers and release background resources. */
    dispose(): Promise<void>;
    /** Async-dispose hook that forwards to `dispose()`. */
    [Symbol.asyncDispose](): Promise<void>;
}
/**
 * Main wallet implementation for Bitcoin transactions with Arkade protocol support.
 * The wallet does not store any data locally and relies on Arkade and onchain
 * providers to fetch onchain and virtual outputs.
 *
 * @example
 * ```typescript
 * // Create a wallet with providers
 * const wallet = await Wallet.create({
 *   identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
 *   arkProvider: new RestArkProvider(),
 *   onchainProvider: new EsploraProvider()
 * });
 *
 * // Use custom providers and/or URLs (e.g., for Expo/React Native)
 * const wallet = await Wallet.create({
 *   identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
 *   arkProvider: new ExpoArkProvider('https://arkade.computer'),
 *   indexerProvider: new ExpoIndexerProvider('https://arkade.computer'),
 *   onchainProvider: new EsploraProvider('https://mempool.space/api')
 * });
 *
 * // Get addresses
 * const arkAddress = await wallet.getAddress();
 * const boardingAddress = await wallet.getBoardingAddress();
 *
 * // Send bitcoin
 * const txid = await wallet.send({
 *   address: 'ark1q...',
 *   amount: 50000,
 * });
 * ```
 */
declare class Wallet extends ReadonlyWallet implements IWallet {
    readonly arkProvider: ArkProvider;
    readonly serverUnrollScript: CSVMultisigTapscript.Type;
    readonly forfeitOutputScript: Bytes;
    readonly forfeitPubkey: Bytes;
    static MIN_FEE_RATE: number;
    readonly identity: Identity;
    private readonly _delegateManager?;
    private _vtxoManager?;
    private _vtxoManagerInitializing?;
    private _walletAssetManager?;
    /**
     * HD receive rotator. Owns the {@link DescriptorProvider}, the
     * `vtxo_received` subscription, and the rotate-and-register
     * lifecycle. Absent in `walletMode: 'static'` and for SingleKey
     * wallets under `'auto'`. Wired in via the constructor; the actual
     * subscription is installed lazily on first `getVtxoManager()` so
     * the contract manager is up first.
     */
    private _receiveRotator?;
    private _receiveRotatorInstalled;
    /**
     * Descriptor-aware signer used by {@link _signerRouter} to sign
     * inputs locked by rotated pubkeys. Same instance the rotator owns;
     * stashed here so the spending paths don't have to reach inside the
     * rotator. Undefined for static / non-HD-capable wallets — those
     * paths only ever take the identity-sign branch.
     */
    private readonly _descriptorProvider?;
    private readonly _signerRouter;
    /**
     * @internal Sole write path for `offchainTapscript` after construction.
     * Called by {@link WalletReceiveRotator.rotate} once the rotated
     * display contract has been persisted. External code must treat
     * `offchainTapscript` as read-only.
     */
    setOffchainTapscriptForRotation(tapscript: DefaultVtxo.Script | DelegateVtxo.Script): void;
    /**
     * Async mutex that serializes all operations submitting VTXOs to the Arkade
     * server (`settle`, `send`, `sendBitcoin`). This prevents VtxoManager's
     * background renewal from racing with user-initiated transactions for the
     * same VTXO inputs.
     */
    private _txLock;
    /**
     * In-flight guard for {@link restore}. A second `restore()` while one
     * is running returns the same promise so concurrent callers coalesce
     * into a single scan (spec §3.E). Cleared on settle so a later
     * explicit `restore()` re-runs.
     */
    private _restoreInFlight?;
    private _addPendingSpends;
    private _removePendingSpends;
    private _withTxLock;
    /**
     * Explicitly recover this wallet's contracts and balance on a fresh
     * repo. HD wallets run a gap-limit scan across the index range;
     * static / non-HD wallets restore based on the single default
     * pubkey. Never throws because of identity/mode (a static identity
     * is a valid, narrower restore); throws on operational failure (so a
     * truncated restore is loud, not silent — the gap window may have
     * closed early). Idempotent and safe to call concurrently (calls
     * coalesce into one scan).
     *
     * Ordering is deliberate (spec §3.B / §4): scan → advance the HD
     * watermark → inline VTXO pull → only THEN surface aggregated
     * handler errors, so safely-discovered funds are always recovered
     * even when one discovery handler failed.
     *
     * @param opts.gapLimit - Consecutive-unused-index window. Default
     * 20. A non-positive / non-integer value is a programmer error and
     * throws synchronously (distinct from operational failure).
     *
     * @note Concurrent calls coalesce: if a restore is already in flight,
     * subsequent callers receive the same promise and their `gapLimit` is
     * ignored — the first caller's value governs the running scan.
     */
    restore(opts?: {
        gapLimit?: number;
    }): Promise<void>;
    private _runRestore;
    /** @deprecated Use settlementConfig instead */
    readonly renewalConfig: Required<Omit<WalletConfig["renewalConfig"], "enabled">> & {
        enabled: boolean;
        thresholdMs: number;
    };
    readonly settlementConfig: SettlementConfig | false;
    protected constructor(identity: Identity, network: Network, onchainProvider: OnchainProvider, arkProvider: ArkProvider, indexerProvider: IndexerProvider, arkServerPublicKey: Bytes, offchainTapscript: DefaultVtxo.Script | DelegateVtxo.Script, boardingTapscript: DefaultVtxo.Script, serverUnrollScript: CSVMultisigTapscript.Type, forfeitOutputScript: Bytes, forfeitPubkey: Bytes, dustAmount: bigint, walletRepository: WalletRepository, contractRepository: ContractRepository, 
    /** @deprecated Use settlementConfig */
    renewalConfig?: WalletConfig["renewalConfig"], delegateProvider?: DelegateProvider, watcherConfig?: WalletConfig["watcherConfig"], settlementConfig?: WalletConfig["settlementConfig"], walletContractTimelocks?: RelativeTimelock[], receiveRotator?: WalletReceiveRotator, descriptorProvider?: DescriptorProvider);
    get assetManager(): IAssetManager;
    getVtxoManager(): Promise<VtxoManager>;
    dispose(): Promise<void>;
    /**
     * Create a full wallet and initialize its background managers.
     *
     * @param config - Wallet configuration
     * @returns A wallet ready to query balances and send transactions
     * @example
     * ```typescript
     * const wallet = await Wallet.create({
     *   identity,
     *   arkProvider: new RestArkProvider(),
     * });
     * ```
     */
    static create(config: WalletConfig): Promise<Wallet>;
    /**
     * Convert this wallet to a readonly wallet.
     *
     * @returns A readonly wallet with the same configuration but readonly identity
     * @example
     * ```typescript
     * const wallet = await Wallet.create({ identity: MnemonicIdentity.fromMnemonic('abandon abandon...'), ... });
     * const readonlyWallet = await wallet.toReadonly();
     *
     * // Can query balance and addresses
     * const balance = await readonlyWallet.getBalance();
     * const address = await readonlyWallet.getAddress();
     *
     * // But cannot send transactions (type error)
     * // readonlyWallet.send(...); // TypeScript error
     * ```
     */
    toReadonly(): Promise<ReadonlyWallet>;
    /** Returns the delegate manager when delegation support is configured. */
    getDelegateManager(): Promise<IDelegateManager | undefined>;
    /** @deprecated alias for @see Wallet.getDelegateManager */
    getDelegatorManager(): Promise<IDelegateManager | undefined>;
    /**
     * Send bitcoin to an Arkade address.
     *
     * @deprecated Use `send`.
     * @param params - Send parameters
     */
    sendBitcoin(params: SendBitcoinParams): Promise<string>;
    /**
     * Settle boarding inputs and/or virtual outputs into a finalized mainnet transaction.
     *
     * @param params - Optional settlement inputs and outputs. When omitted, the wallet settles all eligible funds.
     * @param eventCallback - Optional callback invoked for settlement stream events.
     * @returns The finalized Arkade transaction id
     */
    settle(params?: SettleParams, eventCallback?: (event: SettlementEvent) => void): Promise<string>;
    private _settleImpl;
    private handleSettlementFinalizationEvent;
    /**
     * Create a batch event handler for settlement flows.
     *
     * @param intentId - The intent ID.
     * @param inputs - Inputs used by the intent.
     * @param expectedRecipients - Expected recipients to validate in the virtual output tree.
     * @param session - Optional musig2 signing session. When omitted, signing steps are skipped.
     */
    createBatchHandler(intentId: string, inputs: ExtendedCoin[], expectedRecipients: Recipient[], session?: SignerSession): Batch.Handler;
    /**
     * Build {@link InputSigningJob}s for a tx whose signable inputs can be
     * resolved from their own `witnessUtxo.script`. Inputs without a
     * `witnessUtxo` are silently omitted, mirroring the wallet's
     * historical silent-skip behaviour for cosigner/connector inputs.
     */
    private inputSigningJobsFromWitnessUtxos;
    safeRegisterIntent(intent: SignedIntent<Intent.RegisterMessage>, inputs: ExtendedCoin[]): Promise<string>;
    makeRegisterIntentSignature(coins: ExtendedCoin[], outputs: TransactionOutput[], onchainOutputsIndexes: number[], cosignerPubKeys: string[], validAt?: number): Promise<SignedIntent<Intent.RegisterMessage>>;
    makeDeleteIntentSignature(coins: ExtendedCoin[]): Promise<SignedIntent<Intent.DeleteMessage>>;
    makeGetPendingTxIntentSignature(coins: ExtendedVirtualCoin[]): Promise<SignedIntent<Intent.GetPendingTxMessage>>;
    /**
     * Finalizes pending transactions by retrieving them from the server and finalizing each one.
     * Skips the server check entirely when no send was interrupted (no pending tx flag set).
     * @param vtxos - Optional list of virtual outputs to use instead of retrieving them from the server
     * @returns Array of transaction IDs that were finalized
     */
    finalizePendingTxs(vtxos?: ExtendedVirtualCoin[]): Promise<{
        finalized: string[];
        pending: string[];
    }>;
    private hasPendingTxFlag;
    private setPendingTxFlag;
    /**
     * Send BTC and/or assets to one or more recipients.
     *
     * @param args - Recipients with their addresses, BTC amounts, and assets
     * @returns Promise resolving to the Arkade transaction ID
     *
     * @example
     * ```typescript
     * const txid = await wallet.send({
     *     address: 'ark1q...',
     *     amount: 1000, // (optional, default to dust) btc amount to send to the output
     *     assets: [{ assetId: 'abc123...', amount: 50n }] // (optional) list of assets to send
     * });
     * ```
     */
    send(...args: [Recipient, ...Recipient[]]): Promise<string>;
    private _sendImpl;
    /**
     * Build an offchain transaction from the given inputs and outputs,
     * sign it, submit to the Arkade provider, and finalize.
     * @returns The Arkade transaction id and server-signed checkpoint PSBTs (for bookkeeping)
     */
    buildAndSubmitOffchainTx(inputs: ExtendedVirtualCoin[], outputs: TransactionOutput[]): Promise<{
        arkTxid: string;
        signedCheckpointTxs: string[];
    }>;
    private updateDbAfterOffchainTx;
    private updateDbAfterSettle;
}
/**
 * Select virtual outputs to reach a target amount, prioritizing those closer to expiry
 * @param coins List of virtual outputs to select from
 * @param targetAmount Target amount to reach in satoshis
 * @returns Selected virtual outputs and change amount
 */
declare function selectVirtualCoins(coins: ExtendedVirtualCoin[], targetAmount: number): {
    inputs: ExtendedVirtualCoin[];
    changeAmount: bigint;
};
/**
 * Wait for incoming funds to the wallet
 * @param wallet - The wallet to wait for incoming funds
 * @returns A promise that resolves the next new coins received by the wallet's address
 */
declare function waitForIncomingFunds(wallet: Wallet): Promise<IncomingFunds>;

export { Batch as B, type IncomingFunds as I, ReadonlyWallet as R, Wallet as W, type ReceiveRotatorFactory as a, type ReceiveRotatorBootOpts as b, type ReceiveRotatorBoot as c, selectVirtualCoins as s, waitForIncomingFunds as w };
