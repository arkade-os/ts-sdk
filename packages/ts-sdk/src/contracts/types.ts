import { Bytes } from "@scure/btc-signer/utils.js";
import { EncodedVtxoScript, TapLeafScript, VtxoScript } from "../script/base";
import { ExtendedVirtualCoin, VirtualCoin, TapLeaves } from "../wallet";
import type { NormalizedExtendedVirtualCoin } from "../wallet/vtxo";
import { ContractFilter } from "../repositories";
import type { RelativeTimelock } from "../script/tapscript";
import type { IndexerProvider } from "../providers/indexer";
import type { OnchainProvider } from "../providers/onchain";
import type { Network } from "../networks";

/**
 * Contract lifecycle state. Governs receive-address selection only: `inactive` does **not**
 * unsubscribe (a retired receive address can still be paid; coverage follows
 * {@link Contract.watch} alone). To stop watching but keep the row use `retained`
 * {@link ContractWatchState}; to drop both, {@link IContractManager.deleteContract}.
 */
export type ContractState = "active" | "inactive";

/**
 * Whether a contract is covered by background monitoring (subscription and failsafe/indexer
 * sweep, {@link ContractWatcher.getWatchedContracts}). Orthogonal to {@link ContractState}.
 *
 * NArk parity: `ContractActivityState`; renamed because `active`/`inactive` are taken by
 * {@link ContractState}.
 */
export type ContractWatchState =
    /** Subscribed and polled. */
    | "watched"
    /**
     * Watched until the first VTXO lands, then demoted to `retained` by the contract manager.
     * For one-shot destinations (refund address, swap lockup).
     */
    | "awaiting-funds"
    /**
     * Not subscribed or polled, but still resolves in `getContracts`, annotates its VTXOs and
     * feeds transaction history.
     */
    | "retained";

/** A contract's watch state; rows written before the field existed default to `watched`. */
export function watchStateOf(contract: Pick<Contract, "watch">): ContractWatchState {
    return contract.watch ?? "watched";
}

/** Whether a contract belongs in the subscription and sweep scope. */
export function isWatchedContract(contract: Pick<Contract, "watch">): boolean {
    return watchStateOf(contract) !== "retained";
}

/**
 * A contract that can receive and manage virtual outputs. Its type and parameters determine the
 * VtxoScript (spending paths); the wallet's default receiving address is a `"default"` contract,
 * and external services (swaps, etc.) register their own types.
 *
 * @example
 * ```typescript
 * const vhtlcContract: Contract = {
 *   type: "vhtlc",
 *   params: {
 *     sender: "ab12...",
 *     receiver: "cd34...",
 *     server: "ef56...",
 *     hash: "1234...",
 *     refundLocktime: "800000",
 *     // ... timelocks
 *   },
 *   script: "5120...",
 *   address: "ark1q...",
 *   state: "active",
 *   createdAt: 1704067200000,
 * };
 * ```
 */
export interface Contract {
    /** Human-readable label for display purposes. */
    label?: string;

    /** Contract type identifier (e.g. "default", "vhtlc"); custom types add a ContractHandler. */
    type: string;

    /**
     * Type-specific VtxoScript parameters, serialized as strings (hex for bytes, string for
     * bigint) and interpreted by the type's ContractHandler.
     */
    params: Record<string, string>;

    /** The pkScript hex, used as the unique identifier and primary key for contracts. */
    script: string;

    /** Address derived from the contract script. */
    address: string;

    /** Current state of the contract. */
    state: ContractState;

    /**
     * Background-monitoring scope. Absent means `watched`.
     * @see ContractWatchState
     */
    watch?: ContractWatchState;

    /** Unix timestamp in milliseconds when this contract was created. */
    createdAt: number;

    /** Optional metadata for external integrations. */
    metadata?: Record<string, unknown>;
}

/** A virtual output associated with a specific contract. */
export type ContractVtxo = VirtualCoin &
    Partial<TapLeaves & EncodedVtxoScript> & {
        extraWitness?: Bytes[];
        contractScript: string;
    };

/**
 * A {@link ContractVtxo} with all taproot annotation fields required (mirrors the
 * {@link ExtendedVirtualCoin} / {@link VirtualCoin} split). Use it wherever the compiler should
 * enforce that `annotateVtxos` has run, e.g. `saveVtxos` and forfeit construction.
 */
export type ExtendedContractVtxo = NormalizedExtendedVirtualCoin & {
    contractScript: string;
};

/** Result of path selection: the tapleaf to use and any extra witness data. */
export interface PathSelection {
    /** Tapleaf script to use for spending. */
    leaf: TapLeafScript;

    /** Additional witness elements, for example a preimage for HTLC-like paths. */
    extraWitness?: Bytes[];

    /**
     * nSequence for the spending input, BIP-68 encoded when the leaf
     * uses CSV. Decode with `sequenceToTimelock`; do NOT use as an
     * absolute `Transaction.lockTime`.
     */
    sequence?: number;
}

/** Context for path selection decisions. */
export interface PathContext {
    /** Whether collaborative spending is available through server cooperation. */
    collaborative: boolean;

    /** Current time in milliseconds. */
    currentTime: number;

    /** Current block height, when known. */
    blockHeight?: number;

    /**
     * Wallet's signing descriptor: `tr(pubkey)` for static keys,
     * `tr([fingerprint/path']xpub/0/{index})` for HD. Handlers use it to find the wallet's role.
     */
    walletDescriptor?: string;

    /**
     * Explicit role override for multi-party contracts such as VHTLC. If absent, handlers may
     * match {@link walletDescriptor} against the contract's sender/receiver params.
     */
    role?: string;

    /**
     * Chain tip timestamp in SECONDS, when known. Seconds-typed timelock checks should prefer it
     * over {@link currentTime}: the server matures absolute locktimes against median-time-past,
     * which trails wall clock, and host clock drift would skew the decision.
     */
    chainTime?: number;

    /** The specific virtual output being evaluated. */
    vtxo?: VirtualCoin;
}

/**
 * Handler for a specific contract type.
 *
 * Each contract type (`default`, `vhtlc`, etc.) has a handler that knows how to:
 * 1. Create the VtxoScript from parameters
 * 2. Serialize/deserialize parameters for storage
 * 3. Select the appropriate spending path based on context
 *
 * @example
 * ```typescript
 * const vhtlcHandler: ContractHandler = {
 *   type: "vhtlc",
 *   createScript(params) {
 *     return new VHTLC.Script(this.deserializeParams(params));
 *   },
 *   selectPath(script, contract, context) {
 *     const vhtlc = script as VHTLC.Script;
 *     const preimage = contract.data?.preimage;
 *     if (context.collaborative && preimage) {
 *       return { leaf: vhtlc.claim(), extraWitness: [hex.decode(preimage)] };
 *     }
 *     // ... other paths
 *   },
 *   // ...
 * };
 * ```
 */
export interface ContractHandler<P = Record<string, unknown>, S extends VtxoScript = VtxoScript> {
    /** Contract type managed by this handler. */
    readonly type: string;

    /** Create the VtxoScript from serialized parameters. */
    createScript(params: Record<string, string>): S;

    /** Serialize typed parameters to string key-value pairs. */
    serializeParams(params: P): Record<string, string>;

    /** Deserialize string key-value pairs to typed parameters. */
    deserializeParams(params: Record<string, string>): P;

    /**
     * Select the preferred spending path (e.g. collaborative over unilateral).
     *
     * @returns PathSelection if a viable path exists, null otherwise
     */
    selectPath(script: S, contract: Contract, context: PathContext): PathSelection | null;

    /** All possible spending paths for the context, regardless of current spendability. */
    getAllSpendingPaths(script: S, contract: Contract, context: PathContext): PathSelection[];

    /** All currently spendable paths (empty if none). */
    getSpendablePaths(script: S, contract: Contract, context: PathContext): PathSelection[];

    /**
     * Whether this contract's VTXOs may be picked by *generic* wallet spending (send, settle,
     * renewal, asset operations, offboard, `available` balance). Explicit-input APIs
     * (`settle({ inputs })`, `send({ selectedVtxos })`) stay open regardless.
     *
     * Pure, synchronous and offline (runs in the service worker). Absent or `false` ⇒ NOT
     * spendable, so an unknown type can't leak by omission. No `script` param: deriving a taproot
     * tree per contract on a read path is costly (#521); use `createScript` if needed.
     */
    isGenericallySpendable?(contract: Contract): boolean;

    /**
     * Refuse, before signing, an explicitly named input this contract definitively cannot spend
     * now (e.g. an immature timelock), with an actionable reason instead of an opaque server
     * rejection. Counterpart to {@link isGenericallySpendable}, which leaves explicit inputs open.
     *
     * **Throw only on a definite no**; absent or unsure means the spend proceeds. An empty
     * `getSpendablePaths` is not a no (`arkade`'s skips covenant leaves), nor is an unreadable
     * timelock (height-typed with no chain tip) — @see cltvMaturity. May return a promise for
     * I/O, but prefer synchronous: it sits on the spend path.
     *
     * @throws Error when the contract provably cannot be spent at `context`
     */
    assertSpendableNow?(script: S, contract: Contract, context: PathContext): void | Promise<void>;
}

/**
 * What {@link Discoverable.discoverAt} returns: exactly what `ContractManager.createContract`
 * accepts (script-keyed, idempotent on re-register).
 */
export interface DiscoveredContract {
    type: string;
    params: Record<string, string>;
    script: string;
    address: string;
    metadata?: Record<string, unknown>;
    label?: string;
}

/**
 * Read-only context the scanner injects into every `discoverAt` call. Never carries an external
 * service client; a handler needing one closes over it at registration.
 */
export interface DiscoveryDeps {
    indexerProvider: IndexerProvider;
    onchainProvider: OnchainProvider;
    /** Ark-address network data; `{ hrp }` is all L2 (`default`/`delegate`) discovery needs. */
    network: { hrp: string };
    /**
     * Full Bitcoin network for on-chain (P2TR) addresses, needed by boarding discovery (`{ hrp }`
     * lacks the `bech32` data). When absent, boarding `discoverAt` no-ops.
     */
    onchainNetwork?: Network;
    /**
     * The server's **current** signer key (x-only, 32 bytes) from a fresh server-info snapshot at
     * restore time; L2 discovery probes it first.
     */
    serverPubKey: Uint8Array;
    /**
     * The server's **deprecated** signer keys (x-only, 32 bytes) from the same snapshot. L2
     * discovery scans them too so signer rotation doesn't strand funds; boarding discovery
     * ignores them (current UTXO set only).
     */
    deprecatedSignerPubKeys?: Uint8Array[];
    /** Relative timelocks the wallet treats as its baseline matrix. */
    csvTimelocks: RelativeTimelock[];
    /**
     * Boarding-exit CSV timelock (the server's boarding-exit delay), distinct from the
     * unilateral-exit {@link DiscoveryDeps.csvTimelocks}. When absent, boarding `discoverAt`
     * no-ops.
     */
    boardingTimelock?: RelativeTimelock;
    /** Present only for delegate wallets. */
    delegatePubKey?: Uint8Array;
}

/**
 * The I/O-free subset of {@link DiscoveryDeps}: the axes a receive script can
 * be anchored to. `DiscoveryDeps` satisfies it structurally, so one
 * {@link Discoverable.candidatesAt} serves the scan and the look-ahead band.
 */
export type CandidateDeps = Pick<DiscoveryDeps, "network" | "serverPubKey" | "csvTimelocks"> &
    Pick<Partial<DiscoveryDeps>, "deprecatedSignerPubKeys" | "delegatePubKey">;

/**
 * Optional {@link ContractHandler} capability for `wallet.restore()`'s gap-limit scan. The scanner
 * owns the index loop and gap counter; the handler answers "do I own a contract at this index?"
 * from its own source, and may batch/cache across calls.
 */
export interface Discoverable {
    discoverAt(
        index: number,
        descriptor: string,
        deps: DiscoveryDeps,
    ): Promise<DiscoveredContract[]>;

    /**
     * Optional: answer a whole scan window in one batched round-trip; preferred over per-index
     * `discoverAt` when present. Per-address sources (e.g. boarding on Esplora) omit it.
     *
     * **All-or-nothing per call.** Resolve with a map covering *every* requested index (empty
     * array = confirmed miss) or reject; a missing index would read as "no funds" and close the
     * gap window on a failed request. The scanner treats an incomplete map as a rejection (hits
     * still persisted, scan truncated at the range's first index); unrequested indices are ignored.
     */
    discoverRange?(
        entries: readonly { index: number; descriptor: string }[],
        deps: DiscoveryDeps,
    ): Promise<Map<number, DiscoveredContract[]>>;

    /**
     * Optional: every unverified contract this handler could own at one HD index (pure
     * derivation, no I/O). `discoverRange` probes these and the look-ahead band subscribes to
     * them, so the two cover the same set. `boarding` omits it (deposits have their own channel).
     */
    candidatesAt?(index: number, descriptor: string, deps: CandidateDeps): DiscoveredContract[];
}

/** Duck-typed guard for the pure candidate surface. @see Discoverable.candidatesAt */
export function hasCandidates(
    handler: ContractHandler<unknown> | undefined,
): handler is ContractHandler<unknown> & Required<Pick<Discoverable, "candidatesAt">> {
    return !!handler && typeof (handler as Partial<Discoverable>).candidatesAt === "function";
}

/** Duck-typed guard (mirrors `hasReceiveRotatorFactory`). */
export function isDiscoverable(
    handler: ContractHandler<unknown> | undefined,
): handler is ContractHandler<unknown> & Discoverable {
    return !!handler && typeof (handler as Partial<Discoverable>).discoverAt === "function";
}

/**
 * The per-contract tapscript annotation stamped onto every VTXO locked to a
 * contract (see `extendVirtualCoinForContract`): the leaf used to co-sign
 * forfeits, the leaf committed in intent proofs, and the encoded taproot tree.
 */
export interface DerivedContractTapscripts {
    forfeitTapLeafScript: TapLeafScript;
    intentTapLeafScript: TapLeafScript;
    tapTree: Bytes;
}

/**
 * Optional {@link ContractHandler} capability providing the forfeit/intent tapscripts for VTXO
 * annotation, for scripts without the legacy `forfeit()` (e.g. program-compiled arkade contracts).
 * Must be pure in `(contract.type, contract.script, contract.params)`: `ContractManager` memoizes
 * the result for its lifetime.
 */
export interface TapscriptDeriving<S extends VtxoScript = VtxoScript> {
    deriveTapscripts(script: S, contract: Contract): DerivedContractTapscripts;
}

/** Duck-typed guard (mirrors {@link isDiscoverable}). */
export function isTapscriptDeriving(
    handler: ContractHandler<unknown> | undefined,
): handler is ContractHandler<unknown> & TapscriptDeriving {
    return (
        !!handler && typeof (handler as Partial<TapscriptDeriving>).deriveTapscripts === "function"
    );
}

/** A script the watcher reports on without the wallet owning it. */
export interface WatchedScript {
    script: string;

    /** Free-form tag echoed back by `getWatchedScripts`; never sent anywhere. */
    label?: string;
}

/**
 * Event emitted when contract-related changes occur. Watch-only scripts report the same
 * `vtxo_received` / `vtxo_spent` types without a `contract`; that absence is the ownership
 * boundary, so `event.contract` only compiles after {@link isContractVtxoEvent}.
 */
export type ContractEvent =
    | {
          type: "vtxo_received";
          contractScript: string;
          vtxos: ContractVtxo[];
          contract: Contract;
          timestamp: number;
      }
    | {
          type: "vtxo_spent";
          contractScript: string;
          vtxos: ContractVtxo[];
          contract: Contract;
          timestamp: number;
      }
    | {
          type: "vtxo_received";
          contractScript: string;
          vtxos: VirtualCoin[];
          timestamp: number;
      }
    | {
          type: "vtxo_spent";
          contractScript: string;
          vtxos: VirtualCoin[];
          timestamp: number;
      }
    | { type: "connection_reset"; timestamp: number };

export type ContractVtxoEvent = Extract<ContractEvent, { contract: Contract }>;

/**
 * Gate every wallet-side effect on this: a watch-only event has no contract.
 * @example `if (!isContractVtxoEvent(event)) return;` inside `onContractEvent`,
 * before reading `event.contract` — which does not compile without it.
 */
export function isContractVtxoEvent(event: ContractEvent): event is ContractVtxoEvent {
    return "contract" in event && event.contract !== undefined;
}

/** Callback for contract events. */
export type ContractEventCallback = (event: ContractEvent) => void;

/** Options for retrieving contracts from the Contract Manager (currently the repository filter). */
export type GetContractsFilter = ContractFilter;

/** Contract with its virtual outputs included. */
export type ContractWithVtxos = {
    contract: Contract;
    vtxos: ExtendedContractVtxo[];
};

/** Summary of a contract's balance. */
export interface ContractBalance {
    /** Total balance (settled + pending) in satoshis */
    total: number;

    /** Spendable balance in satoshis */
    spendable: number;

    /** Number of virtual outputs in this contract */
    vtxoCount: number;
}
