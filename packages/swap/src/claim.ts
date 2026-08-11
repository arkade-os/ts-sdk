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
 *   transaction and every checkpoint (the condition is not part of the
 *   signed payload; attaching it first invalidates the signature the server
 *   then rejects as `INVALID_SIGNATURE`).
 * - The leaf is NOT covenant-pinned, so one aggregate output pays the whole
 *   balance wherever the trader says — the `nonInteractiveClaim` pin is the
 *   offline path's, not this one's. The destination is therefore a required
 *   parameter, and the honest default is the swap's own payout address.
 *
 * covclaimd stays useful (it claims for an offline trader via
 * `nonInteractiveClaim`), but with the receiver key derivable from the swap's
 * `secrets` (`senderIdentityForRfqSecrets`), a trader that is online never
 * depends on it.
 */
import { base64, hex } from "@scure/base";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
    CSVMultisigTapscript,
    ConditionWitness,
    type Identity,
    Transaction,
    type VHTLC,
    assertSubmittedArkTxid,
    buildOffchainTx,
    matchServerCheckpoints,
    setArkPsbtField,
} from "@arkade-os/sdk";

import {
    LockupNeedsRecoveryError,
    findLockupVtxos,
    type LockupVtxo,
    type RefundArkProvider,
    type RefundIndexer,
} from "./refund";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The Ark surface the claim push needs — the same seam the refund push uses. */
export type ClaimArkProvider = RefundArkProvider;

/**
 * A signer that reveals a preimage when spending a condition leaf.
 *
 * The ordering encoded here is the whole point: the condition witness is NOT
 * part of what is signed, so attaching it before signing leaves a signature
 * over a PSBT that no longer matches once the field is present. Decorate per
 * claim, never wallet-wide.
 */
const claimIdentity = (identity: Identity, preimage: Uint8Array): Identity => ({
    ...identity,
    sign: async (tx: Transaction, inputIndexes?: number[]): Promise<Transaction> => {
        // Clone-and-round-trip so the caller's transaction is never mutated
        // and the signed result is a fresh object we can add a field to.
        const signed = Transaction.fromPSBT(
            (await identity.sign(tx.clone(), inputIndexes)).toPSBT(),
        );
        const indexes = inputIndexes ?? Array.from({ length: signed.inputsLength }, (_, i) => i);
        for (const index of indexes) {
            setArkPsbtField(signed, index, ConditionWitness, [preimage]);
        }
        return signed;
    },
});

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
 * Swept outputs are refused, not attempted, exactly as in
 * {@link pushRefundWithoutReceiver} — one aggregate transaction means a
 * single non-live input would take the live ones down with it.
 */
export async function pushClaim(
    ark: ClaimArkProvider,
    input: {
        /** The receive-direction covenant (see `receiveVtxoScript`). */
        script: InstanceType<typeof VHTLC.ScriptV2>;
        /** The trader's `receiver` signer. Build it from the swap's `secrets`
         * with `senderIdentityForRfqSecrets` — on an HD wallet that resolves
         * from the seed, with no stored key bytes anywhere. */
        receiver: Identity;
        /** `P`, 32 bytes — the trader generated it at request time. */
        preimage: Uint8Array;
        vtxos: readonly LockupVtxo[];
        /** Where the claimed sats land — the swap's payout address, decoded. */
        destinationPkScript: Uint8Array;
    },
): Promise<{ arkTxid: string; amount: number }> {
    if (input.vtxos.length === 0) throw new Error("nothing to claim: no funded outputs");

    const swept = input.vtxos.filter((vtxo) => vtxo.recoverable);
    if (swept.length > 0) {
        throw new LockupNeedsRecoveryError(
            swept.map((vtxo) => `${vtxo.txid}:${vtxo.vout}`),
            input.script.options.refundLocktime,
        );
    }

    const committed = input.script.options.preimageHash;
    if (hex.encode(ripemd160(sha256(input.preimage))) !== hex.encode(committed)) {
        throw new Error("preimage does not match the covenant's payment hash");
    }

    const info = await ark.getInfo();
    let serverUnrollScript: CSVMultisigTapscript.Type;
    try {
        serverUnrollScript = CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript));
    } catch {
        throw new Error("invalid checkpointTapscript from the Arkade server");
    }

    const leaf = input.script.claim();
    const tapTree = input.script.encode();
    const amount = input.vtxos.reduce((sum, vtxo) => sum + vtxo.value, 0);
    const signer = claimIdentity(input.receiver, input.preimage);

    const { arkTx, checkpoints } = buildOffchainTx(
        input.vtxos.map((vtxo) => ({
            txid: vtxo.txid,
            vout: vtxo.vout,
            value: vtxo.value,
            tapLeafScript: leaf,
            tapTree,
        })),
        // One aggregate output: unlike the covenant refund, this leaf inspects
        // nothing about the output set.
        [{ script: input.destinationPkScript, amount: BigInt(amount) }],
        serverUnrollScript,
    );

    // No index list: every input spends the same claim leaf, so all are
    // signed — and the claim identity attaches `P` after signing.
    const signedArkTx = await signer.sign(arkTx);
    const submitted = await ark.submitTx(
        base64.encode(signedArkTx.toPSBT()),
        checkpoints.map((c) => base64.encode(c.toPSBT())),
    );
    assertSubmittedArkTxid(submitted, signedArkTx, "claim");

    // Only checkpoints we built ourselves get signed — the server's response
    // is matched against the local set first — and the preimage rides the
    // checkpoint signatures exactly as it rides the ark transaction's.
    const matched = matchServerCheckpoints(submitted.signedCheckpointTxs, checkpoints, "claim");
    const finalCheckpoints = await Promise.all(
        matched.map(async ({ server }) => base64.encode((await signer.sign(server, [0])).toPSBT())),
    );

    await ark.finalizeTx(submitted.arkTxid, finalCheckpoints);
    return { arkTxid: submitted.arkTxid, amount };
}

/**
 * Wait for the solver-funded lockup to appear at the covenant script.
 *
 * Same conventions as `awaitRfqResolution`: a `pollMs` interval, an optional
 * unix-seconds `deadline`, and a thrown error carrying a stable `reason` when
 * the deadline passes.
 */
export async function awaitLockupFunding(
    indexer: RefundIndexer,
    swapPkScript: Uint8Array,
    options: { pollMs?: number; deadline?: number } = {},
): Promise<readonly LockupVtxo[]> {
    const pollMs = options.pollMs ?? 5_000;
    for (;;) {
        const vtxos = await findLockupVtxos(indexer, swapPkScript);
        if (vtxos.length > 0) return vtxos;
        if (options.deadline !== undefined && Date.now() / 1000 >= options.deadline) {
            const error = new Error("the lockup never appeared at the covenant script") as Error & {
                reason: string;
            };
            error.reason = "lockup_timeout";
            throw error;
        }
        await sleep(pollMs);
    }
}

/**
 * The one-call composition: wait for the solver's funding, then push the
 * claim. The polling deadline gates the WAIT only — once the lockup is
 * funded, the claim itself is gated by nothing but the solver's own refund
 * deadline (`refund_locktime` from the quote), which is the number the
 * caller's deadline should be measured against.
 */
export async function claimReceiveLockup(
    indexer: RefundIndexer,
    ark: ClaimArkProvider,
    input: Parameters<typeof pushClaim>[1] & {
        /** The covenant's scriptPubKey, from the request flow's `swapPkScript`. */
        swapPkScript: Uint8Array;
        pollMs?: number;
        deadline?: number;
    },
): Promise<{ arkTxid: string; amount: number }> {
    const vtxos = await awaitLockupFunding(indexer, input.swapPkScript, {
        pollMs: input.pollMs,
        deadline: input.deadline,
    });
    return pushClaim(ark, {
        script: input.script,
        receiver: input.receiver,
        preimage: input.preimage,
        vtxos,
        destinationPkScript: input.destinationPkScript,
    });
}
