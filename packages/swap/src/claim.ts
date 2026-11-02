/**
 * The receive corridors' completion: the trader claims the solver-funded
 * lockup with its own preimage.
 *
 * On `lightning:BTC->arkade:BTC` and `onchain:BTC->arkade:BTC` the trader is the covenant's
 * `receiver` and generated `P`, so the collaborative claim leaf (preimage + receiver + server) is
 * spendable the moment the lockup lands, with no covclaimd. Mirror of `pushRefundWithoutReceiver`,
 * except:
 *
 * - The preimage rides the PSBT's `ConditionWitness`, attached AFTER signing on the ark tx and
 *   every checkpoint; attaching it first yields `INVALID_SIGNATURE` (`claimWithPreimageIdentity`
 *   owns that ordering).
 * - The leaf is NOT covenant-pinned, so one aggregate output pays wherever the trader says; the
 *   destination is required, defaulting honestly to the swap's payout address.
 */
import {
    type Identity,
    type Network,
    type VHTLC,
    claimWithPreimageIdentity,
    signAndSubmitOffchainTx,
} from "@arkade-os/sdk";

import { assertPreimageMatches, gateError } from "./onchainHtlc";
import {
    assertNoneSwept,
    boundedLockupSpend,
    lockupAssetOutputs,
    lockupInputs,
    type LockupVtxo,
    operatorUnrollScript,
    type SwapOperator,
} from "./refund";

/**
 * The lockup is funded for less than the swap agreed.
 *
 * The attack: the solver funds the correctly derived script with dust, so local script derivation
 * proves nothing. Claiming anyway publishes `P`, letting the solver settle the payer's Lightning
 * HTLC in full.
 *
 * @deprecated The claim path is internal to the drive; watch it with `client.onUpdate()`. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export class LockupAmountMismatchError extends Error {
    readonly name = "LockupAmountMismatchError";
    readonly reason = "amount_mismatch";
    readonly expectedAmount: number;
    readonly lockedAmount: number;
    constructor(expectedAmount: number, lockedAmount: number) {
        super(
            `lockup holds ${lockedAmount} sats, below the agreed ${expectedAmount} — ` +
                "refusing to publish the preimage",
        );
        this.expectedAmount = expectedAmount;
        this.lockedAmount = lockedAmount;
    }
}

/**
 * Refuse an amount the value gate cannot compare against (`rfq.ts`'s `assertFinite` rule).
 *
 * `NaN` and `undefined` fail every comparison, so they delete the gate rather than fail it, and
 * `P` goes out for a dust lockup. Both are reachable: `expectedAmount` comes from a persisted
 * record (`undefined` = predates the field) and values are `Number()`d off indexer JSON.
 */
const assertFiniteAmount = (value: number, reason: string, label: string): void => {
    if (Number.isFinite(value)) return;
    throw gateError(reason, `${label} is not a finite number (${String(value)})`);
};

/**
 * Build, sign, and push the collaborative claim of a receive-corridor lockup, moving the live
 * outputs to the trader's destination and revealing `P` (the solver reads it off the claim).
 *
 * Preimage and funded VALUE are checked BEFORE signing: `P` reaches the operator at SUBMIT, so a
 * later check has already leaked it. Swept outputs are left out (one non-live input would sink
 * the aggregate tx). The server countersignature is verified per input, so "reported claimed,
 * nothing landed" fails immediately.
 *
 * One push spends at most `MAX_LOCKUP_SPEND_INPUTS` live outputs, the largest. `left` counts the
 * live outputs it did not take (swept ones never count: the receiver cannot spend them). Until it
 * is zero, call again with the outputs not in `spent` and `partiallyClaimed: true`.
 */
export async function pushClaim(
    operator: SwapOperator,
    input: {
        /** The receive-direction covenant (see `lightningReceiveContract`). */
        contract: InstanceType<typeof VHTLC.ScriptV2>;
        /** The trader's `receiver` signer, built from the swap's `secrets` with `contractSigner`. */
        receiver: Identity;
        /** `P`, 32 bytes — the trader generated it at request time. */
        preimage: Uint8Array;
        vtxos: readonly LockupVtxo[];
        /** Where the claimed sats land — the swap's payout address, decoded. */
        destinationPkScript: Uint8Array;
        /** What the lockup must carry: the quote's `to_amount`, captured at REQUEST time and
         * persisted. Required so the guard cannot be skipped. */
        expectedAmount: number;
        /** Set when this lockup already carries a claim of ours: `P` is public
         * by then, so the value gate protects nothing and would only strand
         * the remainder. */
        partiallyClaimed?: boolean;
        /** @see operatorUnrollScript */
        network?: Network;
    },
): Promise<{ txid: string; amount: number; left: number; spent: readonly LockupVtxo[] }> {
    if (input.vtxos.length === 0) throw new Error("nothing to claim: no funded outputs");

    // Only the sender's leaf recovers a swept output, so it is not the receiver's to wait on.
    const live = input.vtxos.filter((vtxo) => !vtxo.recoverable);
    if (live.length === 0) assertNoneSwept(input.vtxos, input.contract);

    // Summed across every live output: funding split over several is legitimate. What this
    // claim leaves stays ours until the solver's CLTV, and the next pass takes it.
    const funded = live.reduce((sum, vtxo) => sum + vtxo.value, 0);
    assertFiniteAmount(funded, "lockup_malformed", "the lockup's summed value");
    // Only on the comparing path: once `P` is public, refusing an old record would strand funds.
    if (!input.partiallyClaimed) {
        assertFiniteAmount(input.expectedAmount, "invalid_gate_input", "expectedAmount");
        if (funded < input.expectedAmount) {
            throw new LockupAmountMismatchError(input.expectedAmount, funded);
        }
    }
    const vtxos = boundedLockupSpend(live);
    const locked = vtxos.reduce((sum, vtxo) => sum + vtxo.value, 0);

    assertPreimageMatches(input.preimage, input.contract.options.preimageHash);

    const serverUnrollScript = await operatorUnrollScript(operator, input.network);

    const leaf = input.contract.claim();

    const txid = await signAndSubmitOffchainTx({
        identity: claimWithPreimageIdentity(input.receiver, input.preimage),
        provider: operator,
        inputs: lockupInputs(vtxos, input.contract, leaf),
        // One aggregate output: this leaf inspects nothing about the output set.
        outputs: [
            { script: input.destinationPkScript, amount: BigInt(locked) },
            ...lockupAssetOutputs(vtxos),
        ],
        serverUnrollScript,
        verifyServerSignatures: { serverPubkey: input.contract.options.server },
    });
    return { txid, amount: locked, left: live.length - vtxos.length, spent: vtxos };
}
