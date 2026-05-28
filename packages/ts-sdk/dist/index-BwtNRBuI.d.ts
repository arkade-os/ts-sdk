import { o as RelativeTimelock, V as VtxoScript, p as TapLeafScript, aM as ContractHandler, aV as Discoverable } from './ark-loKbOrJY.js';
import { D as DefaultVtxo, a as DelegateVtxo } from './delegate-ga-aZ53T.js';
import { Bytes } from '@scure/btc-signer/utils.js';

/** Virtual Hash Time Lock Contract (VHTLC) namespace. */
declare namespace VHTLC {
    interface Options {
        sender: Bytes;
        receiver: Bytes;
        server: Bytes;
        preimageHash: Bytes;
        refundLocktime: bigint;
        unilateralClaimDelay: RelativeTimelock;
        unilateralRefundDelay: RelativeTimelock;
        unilateralRefundWithoutReceiverDelay: RelativeTimelock;
    }
    /**
     * Virtual Hash Time Lock Contract (VHTLC) script implementation.
     *
     * VHTLC enables atomic swaps and conditional payments in the Arkade protocol.
     * It provides multiple spending paths:
     *
     * - **claim**: Receiver can claim funds by revealing the preimage
     * - **refund**: Sender and receiver can collaboratively refund
     * - **refundWithoutReceiver**: Sender can refund after locktime expires
     * - **unilateralClaim**: Receiver can claim unilaterally after delay
     * - **unilateralRefund**: Sender and receiver can refund unilaterally after delay
     * - **unilateralRefundWithoutReceiver**: Sender can refund unilaterally after delay
     *
     * @example
     * ```typescript
     * const vhtlc = new VHTLC.Script({
     *   sender: alicePubKey,
     *   receiver: bobPubKey,
     *   server: serverPubKey,
     *   preimageHash: hash160(secret),
     *   refundLocktime: BigInt(chainTip + 10),
     *   unilateralClaimDelay: { type: 'blocks', value: 100n },
     *   unilateralRefundDelay: { type: 'blocks', value: 102n },
     *   unilateralRefundWithoutReceiverDelay: { type: 'blocks', value: 103n }
     * });
     * ```
     */
    class Script extends VtxoScript {
        readonly options: Options;
        readonly claimScript: string;
        readonly refundScript: string;
        readonly refundWithoutReceiverScript: string;
        readonly unilateralClaimScript: string;
        readonly unilateralRefundScript: string;
        readonly unilateralRefundWithoutReceiverScript: string;
        /** Create a VHTLC script from the supplied participant keys, hash, and timelocks. */
        constructor(options: Options);
        /** Return the collaborative claim tapleaf script. */
        claim(): TapLeafScript;
        /** Return the collaborative refund tapleaf script. */
        refund(): TapLeafScript;
        /** Return the refund-without-receiver tapleaf script. */
        refundWithoutReceiver(): TapLeafScript;
        /** Return the unilateral claim tapleaf script. */
        unilateralClaim(): TapLeafScript;
        /** Return the unilateral refund tapleaf script. */
        unilateralRefund(): TapLeafScript;
        /** Return the unilateral refund-without-receiver tapleaf script. */
        unilateralRefundWithoutReceiver(): TapLeafScript;
    }
}

/**
 * Registry for contract handlers.
 *
 * Each contract type ("default", "vhtlc", etc.) has a handler that knows
 * how to create VtxoScripts, serialize params, and select spending paths.
 *
 * @example
 * ```typescript
 * // Register a custom handler
 * contractHandlers.register(myCustomHandler);
 *
 * // Get handler for a type
 * const handler = contractHandlers.get("vhtlc");
 * const script = handler.createScript(contract.params);
 * ```
 */
declare class ContractHandlerRegistry {
    private handlers;
    /**
     * Register a contract handler.
     *
     * @param handler - The handler to register
     * @throws If a handler for this type is already registered
     */
    register(handler: ContractHandler<unknown>): void;
    /**
     * Get a handler by type.
     *
     * @param type - The contract type
     * @returns The handler, or undefined if not found
     */
    get(type: string): ContractHandler<unknown> | undefined;
    /**
     * Get a handler by type, throwing if not found.
     *
     * @param type - The contract type
     * @returns The handler
     * @throws If no handler is registered for this type
     */
    getOrThrow(type: string): ContractHandler<unknown>;
    /**
     * Check if a handler is registered.
     *
     * @param type - The contract type
     */
    has(type: string): boolean;
    /**
     * Get all registered types.
     */
    getRegisteredTypes(): string[];
    /**
     * Unregister a handler (mainly for testing).
     */
    unregister(type: string): boolean;
    /**
     * Clear all handlers (mainly for testing).
     */
    clear(): void;
}
/**
 * Global registry of contract handlers.
 */
declare const contractHandlers: ContractHandlerRegistry;

/**
 * Typed parameters for DefaultVtxo contracts.
 */
interface DefaultContractParams {
    pubKey: Uint8Array;
    serverPubKey: Uint8Array;
    csvTimelock: RelativeTimelock;
}
/**
 * Handler for default wallet VTXOs.
 *
 * Default contracts use the standard forfeit + exit tapscript:
 * - forfeit: (Alice + Server) multisig for collaborative spending
 * - exit: (Alice) + CSV timelock for unilateral exit
 */
declare const DefaultContractHandler: ContractHandler<DefaultContractParams, DefaultVtxo.Script> & Discoverable;

/**
 * Typed parameters for DelegateVtxo contracts.
 */
interface DelegateContractParams {
    pubKey: Uint8Array;
    serverPubKey: Uint8Array;
    delegatePubKey: Uint8Array;
    csvTimelock: RelativeTimelock;
}
/**
 * Handler for delegate wallet virtual outputs.
 *
 * Delegate contracts extend the default tapscript with an additional delegate path:
 * - forfeit: (Alice + Server) multisig for collaborative spending
 * - exit: (Alice) + CSV timelock for unilateral exit
 * - delegate: (Alice + Delegate + Server) multisig for delegated renewal
 */
declare const DelegateContractHandler: ContractHandler<DelegateContractParams, DelegateVtxo.Script> & Discoverable;

/**
 * Typed parameters for VHTLC contracts.
 */
interface VHTLCContractParams {
    sender: Uint8Array;
    receiver: Uint8Array;
    server: Uint8Array;
    preimageHash: Uint8Array;
    refundLocktime: bigint;
    unilateralClaimDelay: RelativeTimelock;
    unilateralRefundDelay: RelativeTimelock;
    unilateralRefundWithoutReceiverDelay: RelativeTimelock;
}
/**
 * Handler for Virtual Hash Time Lock Contract (VHTLC).
 *
 * VHTLC supports multiple spending paths:
 *
 * Collaborative paths (with server):
 * - claim: Receiver + Server with preimage
 * - refund: Sender + Receiver + Server
 * - refundWithoutReceiver: Sender + Server after CLTV locktime
 *
 * Unilateral paths (without server):
 * - unilateralClaim: Receiver with preimage after CSV delay
 * - unilateralRefund: Sender + Receiver after CSV delay
 * - unilateralRefundWithoutReceiver: Sender after CSV delay
 */
declare const VHTLCContractHandler: ContractHandler<VHTLCContractParams, VHTLC.Script>;

export { DefaultContractHandler as D, VHTLC as V, type DefaultContractParams as a, DelegateContractHandler as b, type DelegateContractParams as c, VHTLCContractHandler as d, type VHTLCContractParams as e, contractHandlers as f };
