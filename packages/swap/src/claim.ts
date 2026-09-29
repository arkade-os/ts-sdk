/**
 * The receive corridors' completion: the trader claims the solver-funded
 * lockup with its own preimage.
 *
 * On `lightning:BTC->arkade:BTC` and `onchain:BTC->arkade:BTC` the solver
 * funds the Arkade lockup and the trader is the covenant's `receiver` — it
 * generated `P`, and the collaborative claim leaf (`preimage-condition +
 * receiver + Arkade server`) is spendable by the trader the moment the
 * lockup lands, with no covclaimd in the loop. This module is that spend:
 * `pushRefundWithoutReceiver`'s mirror, with two differences worth stating:
 *
 * - The claim leaf carries a **preimage condition**, so the preimage rides
 *   the PSBT's `ConditionWitness` field — attached AFTER signing, on the ark
 *   transaction and every checkpoint (`claimWithPreimageIdentity` in core owns
 *   that ordering; the condition is not part of the signed payload, and
 *   attaching it first invalidates the signature the server then rejects as
 *   `INVALID_SIGNATURE`).
 * - The leaf is NOT covenant-pinned, so one aggregate output pays the whole
 *   balance wherever the trader says — the `nonInteractiveClaim` pin is the
 *   offline path's, not this one's. The destination is therefore a required
 *   parameter, and the honest default is the swap's own payout address.
 *
 * covclaimd stays useful (it claims for an offline trader via
 * `nonInteractiveClaim`), but with the receiver key derivable from the swap's
 * `secrets` (`contractSigner`), a trader that is online never
 * depends on it.
 */
import {
    type Identity,
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
 * The attack this names: the solver funds the correctly derived script with
 * dust. Deriving the script locally — what protects every other corridor —
 * proves nothing here, because the script was never the lie. Claiming anyway
 * publishes `P`, which is what lets the solver settle the payer's Lightning
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
 * Refuse an amount the gate below cannot compare against — `rfq.ts`'s
 * `assertFinite` rule, at the one threshold that lives outside that module.
 *
 * `NaN` and `undefined` both fail EVERY comparison, so neither one fails the
 * value gate: they delete it, and `P` goes out for a dust lockup. Both are
 * reachable despite the static types — `expectedAmount` arrives from the
 * caller's persisted record, and the values are `Number()`d off the indexer's
 * JSON. Unlike `assertFinite`, absence is refused here too: the field is
 * required, so `undefined` means the record predates it, which is exactly the
 * case that must not proceed.
 */
const assertFiniteAmount = (value: number, reason: string, label: string): void => {
    if (Number.isFinite(value)) return;
    throw gateError(reason, `${label} is not a finite number (${String(value)})`);
};

/**
 * Build, sign, and push the collaborative claim of a receive-corridor lockup:
 * move every funded output at the lockup to the trader's own destination,
 * revealing `P` in the witness — which is also what settles the trader's side
 * of the swap (the solver reads `P` off the public claim).
 *
 * The preimage is checked against the script's committed hash BEFORE anything
 * is signed: a wrong value can never open the leaf, and catching it here
 * beats learning it from the server's rejection.
 *
 * So is the funded VALUE, against `expectedAmount` — and for the same reason,
 * only more sharply: disclosure happens at SUBMIT, since `P` rides the PSBT to
 * the Arkade operator. A check that waits for the transaction to land has already
 * leaked the secret.
 *
 * Swept outputs are refused, not attempted, exactly as in
 * {@link pushRefundWithoutReceiver} — one aggregate transaction means a
 * single non-live input would take the live ones down with it. That refusal
 * comes first, which is what leaves the value gate a plain sum over live
 * outputs.
 *
 * The server's countersignature is verified before finalizing, per input and
 * against that input's own leaf. It does not protect `P` — that reached the
 * server at submit — but it turns "reported claimed, nothing landed, the
 * solver refunds hours later" into an immediate failure.
 *
 */
export async function pushClaim(
    operator: SwapOperator,
    input: {
        /** The receive-direction covenant (see `lightningReceiveContract`). */
        contract: InstanceType<typeof VHTLC.ScriptV2>;
        /** The trader's `receiver` signer. Build it from the swap's `secrets`
         * with `contractSigner` — on an HD wallet that resolves
         * from the seed, with no stored key bytes anywhere. */
        receiver: Identity;
        /** `P`, 32 bytes — the trader generated it at request time. */
        preimage: Uint8Array;
        vtxos: readonly LockupVtxo[];
        /** Where the claimed sats land — the swap's payout address, decoded. */
        destinationPkScript: Uint8Array;
        /** What the lockup must carry: the quote's `to_amount`, captured at
         * REQUEST time and persisted with the record. Required rather than
         * optional, so the guard cannot be skipped by the records that need
         * it most. */
        expectedAmount: number;
        /** Set when this lockup already carries a claim of ours: `P` is public
         * by then, so the value gate protects nothing and would only strand
         * the remainder. */
        partiallyClaimed?: boolean;
    },
): Promise<{ txid: string; amount: number }> {
    if (input.vtxos.length === 0) throw new Error("nothing to claim: no funded outputs");

    assertNoneSwept(input.vtxos, input.contract);

    // Summed across every live output: funding in several is legitimate, and a
    // first-output check would miss the dust exactly as a first-output claim
    // would leave sats behind.
    const locked = input.vtxos.reduce((sum, vtxo) => sum + vtxo.value, 0);
    assertFiniteAmount(locked, "lockup_malformed", "the lockup's summed value");
    // Ahead of the comparison, never inside it — and only on the path that
    // compares: once `P` is public, refusing a partial claim over a record
    // that predates `expectedAmount` would strand the remainder to protect
    // nothing.
    if (!input.partiallyClaimed) {
        assertFiniteAmount(input.expectedAmount, "invalid_gate_input", "expectedAmount");
        if (locked < input.expectedAmount) {
            throw new LockupAmountMismatchError(input.expectedAmount, locked);
        }
    }

    assertPreimageMatches(input.preimage, input.contract.options.preimageHash);

    const serverUnrollScript = await operatorUnrollScript(operator);

    const leaf = input.contract.claim();

    // The core primitive owns build → sign → submit → match → finalize; this
    // module supplies only what is swap-specific: the claim leaf, the preimage
    // signer, and the operator key to check the response against — the covenant
    // already carries it, so it is not a caller obligation.
    const txid = await signAndSubmitOffchainTx({
        identity: claimWithPreimageIdentity(input.receiver, input.preimage),
        provider: operator,
        inputs: lockupInputs(input.vtxos, input.contract, leaf),
        // One aggregate output: unlike the covenant refund, this leaf inspects
        // nothing about the output set.
        outputs: [{ script: input.destinationPkScript, amount: BigInt(locked) }],
        serverUnrollScript,
        verifyServerSignatures: { serverPubkey: input.contract.options.server },
    });
    return { txid, amount: locked };
}

/**
 * Wait for the solver-funded lockup to appear at the covenant script.
 *
 * Same conventions as `awaitRfqResolution`: a `pollMs` interval, an optional
 * unix-seconds `deadline`, and a thrown error carrying a stable `reason` when
 * the deadline passes.
 */
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
 * The one-call composition: wait for the solver's funding, then push the
 * claim. The polling deadline gates the WAIT only — once the lockup is
 * funded, the claim itself is gated by nothing but the solver's own refund
 * deadline (`refund_locktime` from the quote), which is the number the
 * caller's deadline should be measured against.
 *
 * The wait returns on the first output seen, so a funding the indexer
 * surfaces piecemeal reaches {@link pushClaim}'s value gate short and throws
 * {@link LockupAmountMismatchError}. Nothing was signed, so retrying once the
 * rest lands is safe — and that is also the answer to a genuinely underfunded
 * lockup, which never gets past the gate at all.
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
