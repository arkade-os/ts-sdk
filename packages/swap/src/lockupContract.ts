/**
 * The contract row an RFQ lockup registers as — one definition, two writers.
 *
 * `requestLightningSend` / `requestOnchainSend` write it before handing back an
 * address to fund, and `RfqSwapManager`'s `ensureRegistered` writes it
 * again for records made before that existed. `createContract` is
 * first-writer-wins, so the second write is a no-op rather than a conflict —
 * which is only true while both write the SAME row, hence this module.
 */
import { hex } from "@scure/base";
import {
    ArkAddress,
    VHTLCV2ContractHandler,
    type IContractManager,
    type VHTLC,
} from "@arkade-os/sdk";

/** The contract type a swap lockup registers under. `@arkade-os/sdk`'s handler
 * for `VHTLC.ScriptV2` — the covenant script this corridor builds. */
export const SWAP_LOCKUP_CONTRACT_TYPE = "vhtlc-v2";

export const SWAP_LOCKUP_CONTRACT_LABEL = "Arkade RFQ swap lockup";
export const SWAP_LOCKUP_CONTRACT_KIND = "rfq-swap-lockup";

/** The write seam registration needs, narrowed to the one method — the same
 * injection style as `SwapContractRegistry`, and satisfied by a real
 * `ContractManager` (`await wallet.getContractManager()`). */
export type LockupContractWriter = Pick<IContractManager, "createContract">;

/** The read seam {@link lockupContractParams} needs. Same narrowing, same
 * `ContractManager` satisfies it. */
export type LockupContractReader = Pick<IContractManager, "getContracts">;

/**
 * No row for a lockup a record claims was funded.
 *
 * Separate from a rebuild failure on purpose: the record is fine and its money
 * may well be at the address — what is missing is the wallet's copy of the
 * covenant, which registration writes before the address can be funded. So this
 * means the contract store was cleared or was never the one that registered
 * this swap, and the remedy is a store, not a re-quote.
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
 * The lockup could not be written locally.
 *
 * Deliberately NOT a {@link SwapRefusal} or an {@link AddressMismatch}: those
 * say "the quote is bad, never fund it", while this says "the quote is fine and
 * your own store failed".
 *
 * The throw is the safe point: nothing is funded, and on the receive legs the
 * invoice never left the function, so the abandoned quote is inert and simply
 * retrying the request is the recovery. `script` travels beside `address` so a
 * caller that still holds the swap — `RfqSwapManager`'s `ensureRegistered`, or
 * one resuming from its own record — can retry `registerLockupContract` alone
 * instead of re-quoting. It is NOT enough to resume a request that threw here:
 * that caller never received the invoice or `secrets`.
 */
export class LockupRegistrationFailed extends Error {
    /** The lockup address that was never registered — never fund it: nothing
     * is watching it. */
    readonly address: string;
    /** The covenant the row would have been written from — the other half of
     * `registerLockupContract`, so the write is retryable without a quote. */
    readonly script: InstanceType<typeof VHTLC.ScriptV2>;
    constructor(script: InstanceType<typeof VHTLC.ScriptV2>, address: string, cause: unknown) {
        super(`failed to register the lockup contract for ${address}`, { cause });
        this.name = "LockupRegistrationFailed";
        this.address = address;
        this.script = script;
    }
}

/**
 * Register a lockup covenant so its VTXOs are watched, annotatable and — via
 * `vhtlc-v2`'s own handler, which is never generically spendable — kept out of
 * ordinary coin selection.
 *
 * The row carries script-level facts only. Per-swap identity and key material
 * stay in the swap record: rows are keyed by script and first-writer-wins, so
 * anything per-swap written here is stale from the second swap onward.
 *
 * Takes the derived script rather than a script hex plus params, so the row
 * cannot describe a script other than the one it is keyed by.
 *
 * Throws {@link LockupRegistrationFailed}, so a caller can tell a local
 * storage problem from a reason to walk away from the quote.
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
 * The stored covenant parameters of a funded lockup — the other half of
 * `rebuildRfqSwap`.
 *
 * The row is the wallet's own copy of the tree, written from the covenant
 * before the address could be funded and keyed by the script it derives, which
 * `createContract` refuses to write unless the params reproduce it. That is why
 * an RFQ swap record stores no tree parameters of its own.
 *
 * Looked up by script rather than address: the script is the row's key, and
 * decoding it here means a record whose address does not decode fails as a bad
 * address instead of as a missing row.
 *
 * Throws {@link LockupContractMissing} when there is no row.
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
