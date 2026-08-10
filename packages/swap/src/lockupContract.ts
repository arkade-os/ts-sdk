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
import { VHTLCV2ContractHandler, type IContractManager, type VHTLC } from "@arkade-os/sdk";

/** The contract type a swap lockup registers under. `@arkade-os/sdk`'s handler
 * for `VHTLC.ScriptV2` — the covenant script this corridor builds. */
export const SWAP_LOCKUP_CONTRACT_TYPE = "vhtlc-v2";

export const SWAP_LOCKUP_CONTRACT_LABEL = "Arkade RFQ swap lockup";
export const SWAP_LOCKUP_CONTRACT_KIND = "rfq-swap-lockup";

/** The write seam registration needs, narrowed to the one method — the same
 * injection style as `SwapContractRegistry`, and satisfied by a real
 * `ContractManager` (`await wallet.getContractManager()`). */
export type LockupContractWriter = Pick<IContractManager, "createContract">;

/**
 * The lockup could not be written locally.
 *
 * Deliberately NOT a {@link SwapRefusal} or an {@link AddressMismatch}: those
 * say "the quote is bad, never fund it", while this says "the quote is fine and
 * your own store failed". A caller that retries the same quote after fixing its
 * storage is doing the right thing; one that retries past a refusal is not.
 */
export class LockupRegistrationFailed extends Error {
    /** The lockup address that was never registered — never fund it: nothing
     * is watching it. */
    readonly address: string;
    constructor(address: string, cause: unknown) {
        super(`failed to register the lockup contract for ${address}`, { cause });
        this.name = "LockupRegistrationFailed";
        this.address = address;
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
        throw new LockupRegistrationFailed(address, error);
    }
}
