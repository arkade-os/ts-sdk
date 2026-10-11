/**
 * The contract row an RFQ lockup registers as — one definition, two writers (`request*Send` and
 * `RfqSwapManager.ensureRegistered`). `createContract` is first-writer-wins, so the second write
 * is a no-op only while both write the SAME row, hence this module.
 */
import { hex } from "@scure/base";
import {
    ArkAddress,
    VHTLCV2ContractHandler,
    type IContractManager,
    type VHTLC,
} from "@arkade-os/sdk";

/** The contract type a swap lockup registers under: the SDK's handler for `VHTLC.ScriptV2`.
 *
 * @deprecated Lockup registration is internal to `accept()`; no replacement. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export const SWAP_LOCKUP_CONTRACT_TYPE = "vhtlc-v2";

/** @deprecated Lockup registration is internal to `accept()`; no replacement. Moved off the package root to `@arkade-os/swap/protocol`. */
export const SWAP_LOCKUP_CONTRACT_LABEL = "Arkade RFQ swap lockup";
/** @deprecated Lockup registration is internal to `accept()`; no replacement. Moved off the package root to `@arkade-os/swap/protocol`. */
export const SWAP_LOCKUP_CONTRACT_KIND = "rfq-swap-lockup";

/** The write seam registration needs; a real `ContractManager` satisfies it.
 *
 * @deprecated Lockup registration is internal to `accept()`; no replacement. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export type LockupContractWriter = Pick<IContractManager, "createContract">;

/** The read seam {@link lockupContractParams} needs.
 *
 * @deprecated Lockup registration is internal to `accept()`; no replacement. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export type LockupContractReader = Pick<IContractManager, "getContracts">;

/**
 * No row for a lockup a record claims was funded. The record is fine and its money may be at the
 * address; the wallet's copy of the covenant is missing (store cleared, or a different store
 * registered it). The remedy is a store, not a re-quote.
 *
 * @deprecated Lockup registration is internal to `accept()`; no replacement. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export class LockupContractMissing extends Error {
    /** The lockup whose row is absent. */
    readonly address: string;
    /** Its pkScript hex — the key the row would have been under. */
    readonly script: string;
    constructor(address: string, script: string) {
        super(
            `no contract row for lockup ${address} (script ${script}); its covenant cannot be ` +
                `rebuilt from this wallet's contract store`,
        );
        this.name = "LockupContractMissing";
        this.address = address;
        this.script = script;
    }
}

/**
 * The lockup could not be written locally: "the quote is fine and your own store failed", unlike
 * {@link SwapRefusal} / {@link AddressMismatch} ("never fund it"). Thrown by `client.accept()`.
 *
 * Nothing is funded yet and on receive legs the invoice never left, so retrying the request is
 * the recovery. `script` lets a caller still holding the swap retry `registerLockupContract`
 * alone; it is NOT enough to resume a request that threw here (no invoice or `secrets`).
 */
export class LockupRegistrationFailed extends Error {
    /** The lockup address that was never registered — never fund it: nothing
     * is watching it. */
    readonly address: string;
    /** The covenant the row would have been written from, so the write is retryable without a
     * quote. */
    readonly script: InstanceType<typeof VHTLC.ScriptV2>;
    constructor(script: InstanceType<typeof VHTLC.ScriptV2>, address: string, cause: unknown) {
        super(`failed to register the lockup contract for ${address}`, { cause });
        this.name = "LockupRegistrationFailed";
        this.address = address;
        this.script = script;
    }
}

/**
 * Register a lockup covenant so its VTXOs are watched and — via `vhtlc-v2`'s handler, never
 * generically spendable — kept out of ordinary coin selection.
 *
 * The row carries script-level facts only: rows are keyed by script and first-writer-wins, so
 * anything per-swap written here is stale from the second swap onward. Taking the derived script
 * means the row cannot describe a script other than its key.
 *
 * @throws {LockupRegistrationFailed} so a caller can tell local storage trouble from a bad quote.
 *
 * @deprecated Lockup registration is internal to `accept()`; no replacement. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export async function registerLockupContract(
    contracts: LockupContractWriter,
    script: InstanceType<typeof VHTLC.ScriptV2>,
    address: string,
): Promise<void> {
    try {
        await contracts.createContract({
            type: SWAP_LOCKUP_CONTRACT_TYPE,
            params: VHTLCV2ContractHandler.serializeParams(script.options),
            script: hex.encode(script.pkScript),
            address,
            label: SWAP_LOCKUP_CONTRACT_LABEL,
            metadata: { genericallySpendable: false, kind: SWAP_LOCKUP_CONTRACT_KIND },
        });
    } catch (error) {
        throw new LockupRegistrationFailed(script, address, error);
    }
}

/**
 * The stored covenant parameters of a funded lockup — the other half of `rebuildRfqSwap`. The row
 * is the wallet's own copy of the tree (`createContract` refuses params that do not reproduce the
 * script), which is why an RFQ swap record stores no tree parameters.
 *
 * Looked up by script, decoded from the address here, so a bad address fails as such rather than
 * as a missing row.
 *
 * @throws {LockupContractMissing} when there is no row.
 *
 * @deprecated Lockup registration is internal to `accept()`; no replacement. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export async function lockupContractParams(
    contracts: LockupContractReader,
    lockupAddress: string,
): Promise<Record<string, string>> {
    const script = hex.encode(ArkAddress.decode(lockupAddress).pkScript);
    const [row] = await contracts.getContracts({ script });
    if (!row) throw new LockupContractMissing(lockupAddress, script);
    return row.params;
}
