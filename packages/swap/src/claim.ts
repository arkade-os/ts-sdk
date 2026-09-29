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

import { assertPreimageMatches, gateError, pollUntil } from "./onchainHtlc";
import {
    assertNoneSwept,
    type LockupContractSource,
    findLockupVtxos,
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
 * Build, sign, and push the collaborative claim of a receive-corridor lockup, moving every funded
 * output to the trader's destination and revealing `P` (the solver reads it off the claim).
 *
 * Preimage and funded VALUE are checked BEFORE signing: `P` reaches the operator at SUBMIT, so a
 * later check has already leaked it. Swept outputs are refused first (one non-live input would sink
 * the aggregate tx). The server countersignature is verified per input, so "reported claimed,
 * nothing landed" fails immediately.
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
): Promise<{ txid: string; amount: number }> {
    if (input.vtxos.length === 0) throw new Error("nothing to claim: no funded outputs");

    assertNoneSwept(input.vtxos, input.contract);

    // Summed across every live output: funding split over several is legitimate.
    const locked = input.vtxos.reduce((sum, vtxo) => sum + vtxo.value, 0);
    assertFiniteAmount(locked, "lockup_malformed", "the lockup's summed value");
    // Only on the comparing path: once `P` is public, refusing an old record would strand funds.
    if (!input.partiallyClaimed) {
        assertFiniteAmount(input.expectedAmount, "invalid_gate_input", "expectedAmount");
        if (locked < input.expectedAmount) {
            throw new LockupAmountMismatchError(input.expectedAmount, locked);
        }
    }

    assertPreimageMatches(input.preimage, input.contract.options.preimageHash);

    const serverUnrollScript = await operatorUnrollScript(operator, input.network);

    const leaf = input.contract.claim();

    const txid = await signAndSubmitOffchainTx({
        identity: claimWithPreimageIdentity(input.receiver, input.preimage),
        provider: operator,
        inputs: lockupInputs(input.vtxos, input.contract, leaf),
        // One aggregate output: this leaf inspects nothing about the output set.
        outputs: [{ script: input.destinationPkScript, amount: BigInt(locked) }],
        serverUnrollScript,
        verifyServerSignatures: { serverPubkey: input.contract.options.server },
    });
    return { txid, amount: locked };
}

/** Wait for the solver-funded lockup to appear at the covenant script; past the unix-seconds
 * `deadline`, throws with reason `lockup_timeout`. */
export async function awaitLockupFunding(
    contracts: LockupContractSource,
    swapPkScript: Uint8Array,
    options: { pollMs?: number; deadline?: number } = {},
): Promise<readonly LockupVtxo[]> {
    return pollUntil(
        async () => {
            const vtxos = await findLockupVtxos(contracts, swapPkScript);
            return vtxos.length > 0 ? vtxos : undefined;
        },
        options,
        "lockup_timeout",
        "the lockup never appeared at the covenant script",
    );
}

/**
 * The one-call composition: wait for the solver's funding, then push the claim. The deadline gates
 * the WAIT only; once funded, the claim is bounded by the quote's `refund_locktime`.
 *
 * The wait returns on the first output seen, so piecemeal funding can throw
 * {@link LockupAmountMismatchError}. Nothing was signed, so retrying once the rest lands is safe.
 */
export async function claimReceiveLockup(
    contracts: LockupContractSource,
    operator: SwapOperator,
    input: Parameters<typeof pushClaim>[1] & {
        /** The covenant's scriptPubKey, from the request flow's `swapPkScript`. */
        swapPkScript: Uint8Array;
        pollMs?: number;
        deadline?: number;
    },
): Promise<{ txid: string; amount: number }> {
    const { swapPkScript, pollMs, deadline, ...claim } = input;
    const vtxos = await awaitLockupFunding(contracts, swapPkScript, { pollMs, deadline });
    return pushClaim(operator, { ...claim, vtxos });
}
