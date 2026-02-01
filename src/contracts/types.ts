import { Bytes } from "@scure/btc-signer/utils.js";
import { TapLeafScript, VtxoScript } from "../script/base";
import { VirtualCoin, ExtendedVirtualCoin } from "../wallet";
import { ContractFilter } from "../repositories";
import type { DescriptorProvider } from "../identity";

/**
 * Contract state indicating whether it should be actively monitored.
 */
export type ContractState = "active" | "inactive";

/**
 * Represents a contract that can receive and manage VTXOs.
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
 *   address: "tark1...",
 *   state: "active",
 *   createdAt: 1704067200000,
 * };
 * ```
 */
export interface Contract {
    /** Human-readable label for display purposes */
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

    /** The pkScript hex - unique identifier and primary key for contracts */
    script: string;

    /** The address derived from the script */
    address: string;

    /** Current state of the contract */
    state: ContractState;

    /** Unix timestamp (ms) when this contract was created */
    createdAt: number;

    /** Unix timestamp (ms) when this contract expires (optional) */
    expiresAt?: number;

    /**
     * Optional metadata for external integrations.
     */
    metadata?: Record<string, unknown>;
}

/**
 * A VTXO that has been associated with a specific contract.
 */
export interface ContractVtxo extends ExtendedVirtualCoin {
    /** The contract script this VTXO belongs to */
    contractScript: string;
}

/**
 * Result of path selection - which tapleaf to use and extra witness data.
 */
export interface PathSelection {
    /** The tapleaf script to use for spending */
    leaf: TapLeafScript;

    /** Additional witness elements (e.g., preimage for HTLC) */
    extraWitness?: Bytes[];

    /** Sequence number override (for CSV timelocks) */
    sequence?: number;

    /** Descriptor to use for signing this path */
    descriptor?: string;
}

/**
 * A wallet's descriptor associated with specific spending paths.
 */
export interface WalletDescriptorInfo {
    /** The descriptor for signing */
    descriptor: string;

    /** Role in the contract (for multi-party contracts) */
    role?: string;

    /** Which paths this descriptor is used for */
    pathNames: string[]; // e.g., ["claim", "refund"] or ["forfeit", "exit"]
}

/**
 * Context for path selection decisions.
 */
export interface PathContext {
    /** Is collaborative spending available (server cooperation)? */
    collaborative: boolean;

    /** Current time in milliseconds */
    currentTime: number;

    /** Current block height (optional) */
    blockHeight?: number;

    /**
     * Wallet's descriptor for signing.
     * Format: tr(pubkey) for static keys, tr([fingerprint/path']xpub/0/{index}) for HD.
     * Used by handlers to determine wallet's role in multi-party contracts.
     */
    walletDescriptor?: string;

    /**
     * Wallet's public key (x-only, 32 bytes hex).
     * @deprecated Use walletDescriptor instead. This field is provided for
     * backwards compatibility and will be removed in a future version.
     */
    walletPubKey?: string;

    /**
     * Explicit role override (for multi-party contracts like VHTLC).
     * If not provided, handler may derive role from walletPubKey.
     */
    role?: string;

    /** The specific VTXO being evaluated */
    vtxo?: VirtualCoin;
}

/**
 * Handler for a specific contract type.
 *
 * Each contract type (default, vhtlc, etc.) has a handler that knows how to:
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
/**
 * Indicates where the contract's coins exist.
 * - "onchain": Bitcoin UTXOs (watched via esplora/onchain provider)
 * - "offchain": Ark VTXOs (watched via indexer)
 * - "both": Can exist in either form (e.g., during transitions)
 */
export type ScriptType = "onchain" | "offchain" | "both";

export interface ContractHandler<
    P = Record<string, unknown>,
    S extends VtxoScript = VtxoScript,
> {
    /** The contract type this handler manages */
    readonly type: string;

    /**
     * Where the contract's coins exist.
     * - "onchain": Bitcoin UTXOs (boarding, unilateral exits)
     * - "offchain": Ark VTXOs (default, vhtlc)
     * - "both": Can exist in either form
     */
    readonly scriptType: ScriptType;

    /**
     * Create the VtxoScript from serialized parameters.
     */
    createScript(params: Record<string, string>): S;

    /**
     * Serialize typed parameters to string key-value pairs.
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
    selectPath(
        script: S,
        contract: Contract,
        context: PathContext
    ): PathSelection | null;

    /**
     * Get all possible spending paths for the current context.
     * Returns empty array if no paths are available.
     *
     * Useful for showing users which spending options exist regardless of
     * current spendability.
     */
    getAllSpendingPaths(
        script: S,
        contract: Contract,
        context: PathContext
    ): PathSelection[];

    /**
     * Get all currently spendable paths.
     * Returns empty array if no paths are available.
     */
    getSpendablePaths(
        script: S,
        contract: Contract,
        context: PathContext
    ): PathSelection[];

    /**
     * Get all wallet descriptors from contract params.
     * Returns all descriptors that belong to the wallet, along with
     * which paths they're used for.
     *
     * @param contract - The contract
     * @param identity - DescriptorProvider to check ownership
     * @returns Array of wallet's descriptors with path info
     */
    getWalletDescriptors(
        contract: Contract,
        identity: DescriptorProvider
    ): WalletDescriptorInfo[];
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
    | {
          type: "contract_expired";
          contractScript: string;
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
 * Contract with its VTXOs included.
 */
export type ContractWithVtxos = {
    contract: Contract;
    vtxos: ContractVtxo[];
};

/**
 * Summary of a contract's balance.
 */
export interface ContractBalance {
    /** Total balance (settled + pending) in satoshis */
    total: number;

    /** Spendable balance in satoshis */
    spendable: number;

    /** Number of VTXOs in this contract */
    vtxoCount: number;
}
