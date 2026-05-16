import { Bytes } from "@scure/btc-signer/utils.js";
import { EncodedVtxoScript, TapLeafScript, VtxoScript } from "../script/base";
import { ExtendedVirtualCoin, VirtualCoin, TapLeaves } from "../wallet";
import { ContractFilter } from "../repositories";
import type { RelativeTimelock } from "../script/tapscript";
import type { IndexerProvider } from "../providers/indexer";
import type { OnchainProvider } from "../providers/onchain";

/**
 * Contract state indicating whether it should be actively monitored.
 */
export type ContractState = "active" | "inactive";

/**
 * Represents a contract that can receive and manage virtual outputs.
 *
 * A contract is defined by its type and parameters, which together
 * determine the VtxoScript (spending paths). The wallet's default
 * receiving address is itself a contract of type "default".
 *
 * External services (Boltz swaps, atomic swaps, etc.) create additional
 * contracts with their own types and parameters.
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

    /**
     * Contract type identifier.
     * Built-in types: "default", "vhtlc"
     * Custom types can be registered via ContractHandler.
     */
    type: string;

    /**
     * Type-specific parameters for constructing the VtxoScript.
     * All values are serialized as strings (hex for bytes, string for bigint).
     * The ContractHandler for this type knows how to interpret these.
     */
    params: Record<string, string>;

    /** The pkScript hex, used as the unique identifier and primary key for contracts. */
    script: string;

    /** Address derived from the contract script. */
    address: string;

    /** Current state of the contract. */
    state: ContractState;

    /** Unix timestamp in milliseconds when this contract was created. */
    createdAt: number;

    /**
     * Optional metadata for external integrations.
     */
    metadata?: Record<string, unknown>;
}

/**
 * A virtual output that has been associated with a specific contract.
 */
export type ContractVtxo = VirtualCoin &
    Partial<TapLeaves & EncodedVtxoScript> & {
        extraWitness?: Bytes[];
        contractScript: string;
    };

/**
 * A {@link ContractVtxo} with all taproot annotation fields required.
 *
 * Mirrors the {@link ExtendedVirtualCoin} / {@link VirtualCoin} split:
 * - {@link ContractVtxo} carries `TapLeaves` and `EncodedVtxoScript` as
 *   `Partial<>` because VTXOs fetched raw from the indexer do not yet have
 *   taproot data.
 * - `ExtendedContractVtxo` narrows those fields to required, guaranteeing
 *   that `annotateVtxos` has run and the taproot leaves are present.
 *
 * Use this type (instead of {@link ContractVtxo}) wherever the compiler
 * should enforce that annotation has happened — e.g. `saveVtxos` and
 * forfeit transaction construction.
 */
export type ExtendedContractVtxo = ExtendedVirtualCoin & {
    contractScript: string;
};

/**
 * Result of path selection, including the tapleaf to use and any extra witness data.
 */
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

/**
 * Context for path selection decisions.
 */
export interface PathContext {
    /** Whether collaborative spending is available through server cooperation. */
    collaborative: boolean;

    /** Current time in milliseconds. */
    currentTime: number;

    /** Current block height, when known. */
    blockHeight?: number;

    /**
     * Wallet's descriptor for signing.
     * Format: tr(pubkey) for static keys, tr([fingerprint/path']xpub/0/{index}) for HD.
     * Used by handlers to determine wallet's role in multi-party contracts.
     */
    walletDescriptor?: string;

    /**
     * Wallet's public key (x-only, 32 bytes hex).
     * @deprecated Use walletDescriptor instead.
     */
    walletPubKey?: string;

    /**
     * Explicit role override for multi-party contracts such as VHTLC.
     * If not provided, the handler may derive the role by matching
     * {@link walletDescriptor} (preferred) — or {@link walletPubKey} as a
     * fallback — against the contract's sender/receiver params.
     */
    role?: string;

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

    /**
     * Create the VtxoScript from serialized parameters.
     *
     * @param params - Serialized contract parameters
     * @returns Contract script instance
     */
    createScript(params: Record<string, string>): S;

    /**
     * Serialize typed parameters to string key-value pairs.
     *
     * @param params - Typed contract parameters
     * @returns Serialized key-value representation
     */
    serializeParams(params: P): Record<string, string>;

    /**
     * Deserialize string key-value pairs to typed parameters.
     */
    deserializeParams(params: Record<string, string>): P;

    /**
     * Select the preferred spending path based on contract state and context.
     * Returns the best available path (e.g., collaborative over unilateral).
     *
     * @returns PathSelection if a viable path exists, null otherwise
     */
    selectPath(script: S, contract: Contract, context: PathContext): PathSelection | null;

    /**
     * Get all possible spending paths for the current context.
     * Returns empty array if no paths are available.
     *
     * Useful for showing users which spending options exist regardless of
     * current spendability.
     */
    getAllSpendingPaths(script: S, contract: Contract, context: PathContext): PathSelection[];

    /**
     * Get all currently spendable paths.
     * Returns empty array if no paths are available.
     */
    getSpendablePaths(script: S, contract: Contract, context: PathContext): PathSelection[];
}

/**
 * What a {@link Discoverable.discoverAt} call returns — exactly the
 * shape `ContractManager.createContract` accepts (script-keyed,
 * idempotent on re-register).
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
 * Read-only context the scanner injects into every `discoverAt` call.
 * The boltz/swap handler does NOT receive its Boltz client here — it
 * closes over its own client at registration time.
 */
export interface DiscoveryDeps {
    indexerProvider: IndexerProvider;
    onchainProvider: OnchainProvider;
    network: { hrp: string };
    serverPubKey: Uint8Array;
    /** Relative timelocks the wallet treats as its baseline matrix. */
    csvTimelocks: RelativeTimelock[];
    /** Present only for delegate wallets. */
    delegatePubKey?: Uint8Array;
}

/**
 * Optional capability a {@link ContractHandler} implements to participate
 * in `wallet.restore()`'s gap-limit scan. The scanner owns the index
 * loop and the gap counter; the handler answers "do I own a contract
 * anchored to the pubkey/descriptor at this index?" — checked against
 * the indexer / explorer / (for swaps) the handler's own source. The
 * handler MAY batch/cache internally across calls.
 */
export interface Discoverable {
    discoverAt(
        index: number,
        descriptor: string,
        deps: DiscoveryDeps
    ): Promise<DiscoveredContract[]>;
}

/** Duck-typed guard (mirrors `hasReceiveRotatorFactory`). */
export function isDiscoverable(
    handler: ContractHandler<unknown> | undefined
): handler is ContractHandler<unknown> & Discoverable {
    return (
        !!handler &&
        typeof (handler as Partial<Discoverable>).discoverAt === "function"
    );
}

/**
 * Event emitted when contract-related changes occur.
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
    | { type: "connection_reset"; timestamp: number };

/**
 * Callback for contract events.
 */
export type ContractEventCallback = (event: ContractEvent) => void;

/**
 * Options for retrieving contracts from the Contract Manager.
 * Currently an alias of the repository's filter type but can be extended in the future.
 */
export type GetContractsFilter = ContractFilter;

/**
 * Contract with its virtual outputs included.
 */
export type ContractWithVtxos = {
    contract: Contract;
    vtxos: ExtendedContractVtxo[];
};

/**
 * Summary of a contract's balance.
 */
export interface ContractBalance {
    /** Total balance (settled + pending) in satoshis */
    total: number;

    /** Spendable balance in satoshis */
    spendable: number;

    /** Number of virtual outputs in this contract */
    vtxoCount: number;
}
