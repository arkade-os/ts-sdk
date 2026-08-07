/**
 * Tracking a funded RFQ swap to its end, and taking the lockup back when the
 * solver never resolves it.
 *
 * The corridor's operate side is complete (`requestLightningSend` /
 * `requestOnchainSend` quote, derive every leaf locally, and gate funding) and
 * so is the L1 claim side (`awaitOnchainFill` / `claimOnchainFill`). What was
 * missing is the other end of a swap that goes wrong: the trader has funded a
 * VHTLC the solver never claimed, and nothing in this package would build the
 * spend that gets those sats back.
 *
 * **There is no "please refund me" message in this protocol.** `RfqTransport`
 * carries `requestQuote`, `status`, and `close` — nothing else — so "ask the
 * solver first" cannot mean sending a new request type. What it means here is
 * to WATCH: a solver that decides a swap failed resolves it on its own, either
 * by co-signing the collaborative `refund` leaf or by pushing its own
 * `nonInteractiveRefund` escape hatch (server + solver + emulator, no timelock
 * — the reference solver's `refund-now`). Either way the money comes back to
 * the trader's pre-committed address and the RFQ reports `refunded`. So the
 * ask is `status()`, and the fallback is the trader doing it itself once the
 * quote's `refund_locktime` matures. See {@link refundIfUnresolved}.
 *
 * Which leaf the fallback uses, and why it is the only sensible one:
 *
 * | leaf                              | needs                        | timelock |
 * |-----------------------------------|------------------------------|----------|
 * | `refund`                          | trader + solver + server     | none     |
 * | `refundWithoutReceiver`           | trader + server              | CLTV     |
 * | `unilateralRefund`                | trader + solver              | CSV      |
 * | `unilateralRefundWithoutReceiver` | trader alone                 | CSV, longest |
 *
 * `refund` needs the solver's live signature, which is exactly what a trader
 * stuck in this situation does not have and has no way to request. The two CSV
 * leaves need no server, but a relative timelock only starts counting once the
 * VTXO is onchain — spending them means unrolling the commitment and checkpoint
 * transactions first (a real unilateral exit) and then waiting out a delay
 * strictly longer than the others. `refundWithoutReceiver` is the one that
 * needs neither the solver nor an exit: the trader's own `sender` key plus the
 * Arkade server, gated on the CLTV the quote already told the trader about.
 * That is what this module builds.
 */
import { base64, hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import {
    CSVMultisigTapscript,
    ConditionWitness,
    RestArkProvider,
    RestIndexerProvider,
    SingleKey,
    Transaction,
    VHTLC,
    assertSubmittedArkTxid,
    buildOffchainTx,
    getArkPsbtFields,
    matchServerCheckpoints,
} from "@arkade-os/sdk";

import { RFQ_TERMINAL_STATES, type RfqStatus, type RfqTransport } from "./rfq";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** True for the states after which the solver will report nothing further. */
export const isRfqTerminal = (state: string): boolean =>
    (RFQ_TERMINAL_STATES as readonly string[]).includes(state);

/**
 * The terminal states that mean the swap is OVER and the lockup is already
 * gone — the solver either claimed it (`settled`, revealing the preimage) or
 * returned it (`refunded`). A trader seeing one of these has nothing left to
 * do.
 *
 * Deliberately narrower than {@link RFQ_TERMINAL_STATES}: `refused`, `expired`
 * and `stuck` are terminal for the NEGOTIATION but say nothing about whether
 * the trader's sats are still sitting at the lockup. A trader that funded just
 * as the quote expired, or whose solver wedged mid-payment, is exactly the
 * trader who needs the refund most — so those states must not short-circuit
 * it. {@link refundIfUnresolved} treats them as "keep going", and lets the
 * on-chain VTXO lookup be the authority on whether anything is actually there.
 */
export const RFQ_RESOLVED_STATES = ["settled", "refunded"] as const;

const isResolved = (state: string): boolean =>
    (RFQ_RESOLVED_STATES as readonly string[]).includes(state);

/**
 * Poll a swap's status until it reaches a terminal state.
 *
 * Same shape and conventions as {@link awaitOnchainFill}: a `pollMs` interval,
 * an optional unix-seconds `deadline`, and a thrown error carrying a stable
 * `reason` when that deadline passes.
 *
 * A `null` status (the solver has no record of this `rfq_id`) is treated as
 * "not yet", not as an answer — a status route can legitimately 404 for a
 * moment after a quote is issued. The deadline is what bounds that wait.
 *
 * Transport errors are NOT swallowed; a failing `status()` call rejects this
 * function. Callers polling across a long refund window should expect to
 * restart it after a network blip — nothing is lost by doing so, since the
 * refund path this feeds is gated on an absolute timelock that does not
 * expire.
 */
export async function awaitRfqResolution(
    transport: RfqTransport,
    rfqId: string,
    options: { pollMs?: number; deadline?: number } = {},
): Promise<RfqStatus> {
    const pollMs = options.pollMs ?? 5_000;
    for (;;) {
        const status = await transport.status(rfqId);
        if (status && isRfqTerminal(status.state)) return status;
        if (options.deadline !== undefined && Date.now() / 1000 >= options.deadline) {
            const error = new Error(
                `rfq ${rfqId} did not reach a terminal state before the deadline`,
            ) as Error & { reason: string };
            error.reason = "status_timeout";
            throw error;
        }
        await sleep(pollMs);
    }
}

// ── The refundWithoutReceiver push ───────────────────────────────────────────

/** The Ark surface the refund push needs — narrower than a full provider, and
 * satisfied by {@link RestArkProvider}. Same seam style as `RestoreIndexer`. */
export type RefundArkProvider = Pick<RestArkProvider, "getInfo" | "submitTx" | "finalizeTx">;

/** The indexer surface the lockup lookup needs. */
export type RefundIndexer = Pick<RestIndexerProvider, "getVtxos">;

/** A still-refundable virtual output sitting at the swap lockup. */
export interface LockupVtxo {
    txid: string;
    vout: number;
    value: number;
    /**
     * The batch this output lived in expired and the operator swept it, so it
     * is no longer ordinarily spendable — only recoverable.
     *
     * It is still the trader's money and `refundWithoutReceiver` still takes
     * it back (that leaf needs the trader's own key plus the server, neither
     * of which a sweep removes). What a sweep does cost is every path that
     * needs a live counterparty signature.
     */
    recoverable: boolean;
}

/**
 * Every output at the lockup script that can still be refunded — spendable
 * AND swept-but-recoverable.
 *
 * All of them, not the first: a trader may fund a lockup in more than one
 * send, and refunding only `vtxos[0]` returns part of the money and strands
 * the rest at a script whose other refund paths are all longer.
 *
 * BOTH queries, because they are disjoint sets and `spendableOnly` alone goes
 * blind at exactly the wrong moment. A lockup whose batch expiry passed is
 * swept into the recoverable set, and this function exists to serve swaps that
 * sat unresolved — which are precisely the ones most likely to have got there.
 * Reading only the spendable set would report `nothing_to_refund` over money
 * that is still sitting at the script, which is worse than an error: it looks
 * like a resolved swap. `packages/boltz-swap` merges the same two queries for
 * the same reason (`arkade-swaps.ts`'s `refundableVtxos`).
 *
 * This read — not the RFQ's reported state — is the authority on whether
 * there is anything left to refund.
 */
export async function findLockupVtxos(
    indexer: RefundIndexer,
    swapPkScript: Uint8Array,
): Promise<LockupVtxo[]> {
    const scripts = [hex.encode(swapPkScript)];
    const [spendable, recoverable] = await Promise.all([
        indexer.getVtxos({ scripts, spendableOnly: true }),
        indexer.getVtxos({ scripts, recoverableOnly: true }),
    ]);
    const seen = new Set<string>();
    const out: LockupVtxo[] = [];
    for (const [vtxos, isRecoverable] of [
        [spendable.vtxos ?? [], false],
        [recoverable.vtxos ?? [], true],
    ] as const) {
        for (const vtxo of vtxos) {
            // Deduped by outpoint: the two filters are disjoint today, but an
            // output counted twice would be added twice to the refund's
            // aggregate output and make a transaction that cannot be built.
            const key = `${vtxo.txid}:${vtxo.vout}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                txid: vtxo.txid,
                vout: vtxo.vout,
                value: Number(vtxo.value),
                recoverable: isRecoverable,
            });
        }
    }
    return out;
}

// ── Reading the lockup's fate off chain ──────────────────────────────────────

/**
 * The indexer surface the lockup-spend read needs: the vtxo lookup, plus the
 * raw transactions those vtxos were spent by. Same narrow-seam style as
 * {@link RefundIndexer} and `restore.ts`'s `RestoreIndexer`, and satisfied by
 * {@link RestIndexerProvider}.
 */
export type LockupSpendIndexer = Pick<RestIndexerProvider, "getVtxos" | "getVirtualTxs">;

/**
 * What chain data says became of a swap lockup — the whole answer, with no
 * solver involvement and nothing taken on the solver's word.
 */
export type LockupFate =
    /** At least one output at the lockup is still unspent. Not over. */
    | { fate: "open" }
    /** Spent by a witness carrying a preimage that HASHES to the quote's
     * `payment_hash`. Only the claim leaf can reveal one, and the only
     * legitimate way the solver obtains it is by completing its side. */
    | { fate: "claimed"; preimage: Uint8Array }
    /** Fully spent, and nothing that spent it revealed a matching preimage —
     * so the money went back to the trader. See {@link readLockupFate}. */
    | { fate: "returned" }
    /** Nothing was learned: no outputs visible, an output spent by nothing the
     * indexer names, a spend it could not produce, or a blob that would not
     * decode. Never an answer. */
    | { fate: "unknown" };

/** `sha256(candidate)` against the quote's wire-form payment hash. This — not
 * a matching witness SHAPE — is the only thing that turns a witness item into
 * proof, the same discipline `claimOnchainFill` and `extractPreimage` already
 * apply to every other preimage this package consumes. */
const hashesTo = (candidate: Uint8Array, paymentHash: string): boolean =>
    hex.encode(sha256(candidate)) === paymentHash;

/**
 * Every witness item one input of a spend might be carrying the preimage in.
 *
 * Two sources, searched as one set. Ark's proprietary `ConditionWitness` PSBT
 * field is where a preimage is attached when the condition closure is
 * finalized (`setArkPsbtField(tx, i, ConditionWitness, [preimage])`), and it
 * survives a default `Transaction.fromPSBT` round trip — the SDK's decoder
 * already keeps unknown fields, so no options are needed here (the same thing
 * `restore.ts` relies on to read an offer packet back). `finalScriptWitness`
 * is the other place a preimage can sit once the raw witness stack is built.
 * Reading only one of them would miss a real settlement; reading both costs
 * nothing, because neither is trusted — see {@link readLockupFate}.
 */
const candidateWitnessItems = (tx: Transaction, inputIndex: number): Uint8Array[] => [
    ...getArkPsbtFields(tx, inputIndex, ConditionWitness).flat(),
    ...(tx.getInput(inputIndex).finalScriptWitness ?? []),
];

/**
 * Decide from chain data alone whether a swap lockup settled, came back, or is
 * still live.
 *
 * **Why this is decidable without asking anyone.** The lockup's claim leaf can
 * only be spent by revealing `P`, so a spend witness carrying a value that
 * hashes to the quote's `payment_hash` is proof the claim leaf was used — and
 * the only legitimate way the counterparty obtains `P` is by completing its
 * side of the swap. Every OTHER leaf is a refund: `nonInteractiveRefund` is
 * covenant-pinned to the trader's own address (`enforcePayTo(senderPkScript)`),
 * and `refund`, `refundWithoutReceiver`, `unilateralRefund` and
 * `unilateralRefundWithoutReceiver` all require the trader's own signature. So
 * "spent, but not by a hash-verified claim" means the money went back to the
 * trader, and nothing here has to trust a counterparty to say so.
 *
 * **A matching witness SHAPE is not proof.** Only a candidate that hashes to
 * `paymentHash` may be read as a claim; a 32-byte item that hashes to anything
 * else is just bytes, and is treated as a refund. Getting this wrong in the
 * permissive direction would report "settled" for a swap that actually
 * refunded, which is precisely the fact a trader is relying on.
 *
 * **`unknown` is not `returned`.** An empty vtxo set (indexer lag, or a lockup
 * not visible yet), a `spentBy` the indexer cannot produce a transaction for,
 * or a blob that will not decode all come back as `unknown`. `getVirtualTxs`
 * may legitimately return fewer transactions than were asked for, so the
 * observed set is counted rather than assumed complete. The caller's correct
 * response to `unknown` is the same as to `open`: keep watching, and let the
 * refund timelock — which no outage can move — be what ends the wait.
 *
 * Ask-the-indexer, don't-trust-local-state: read fresh on every poll, never
 * cached, the same posture {@link findLockupVtxos} already establishes.
 */
export async function readLockupFate(
    indexer: LockupSpendIndexer,
    input: {
        swapPkScript: Uint8Array;
        /** `sha256(P)`, hex — the quote's `payment_hash`. */
        paymentHash: string;
    },
): Promise<LockupFate> {
    const { vtxos } = await indexer.getVtxos({ scripts: [hex.encode(input.swapPkScript)] });
    const all = vtxos ?? [];
    if (all.length === 0) return { fate: "unknown" };

    const spentBy = new Set<string>();
    let everySpendNamed = true;
    for (const vtxo of all) {
        // Unions all three spend facts rather than trusting `spentBy` alone:
        // the wire contract permits `isSpent: true` with an EMPTY `spentBy`,
        // so a `spentBy`-only test would read an output that is gone as one
        // still sitting there. Same union — and the same reason — as the SDK's
        // own `hasTerminalSpend`.
        if (!vtxo.isSpent && !vtxo.spentBy && !vtxo.settledBy) return { fate: "open" };
        // `spentBy` is the EMPTY STRING, not absent, when there is nothing to
        // name, so this is a truthiness test and never a presence one. When it
        // IS set it names the CHECKPOINT transaction, which is exactly the one
        // carrying the spend leaf's witness: `buildOffchainTx` builds one
        // checkpoint per input, and that checkpoint's single input is the one
        // holding the lockup's `tapLeafScript`. The ark transaction spends the
        // checkpoint, not the lockup, so it is the wrong place to look.
        if (vtxo.spentBy) spentBy.add(vtxo.spentBy);
        // Spent, but by nothing this can go and read. No witness to verify, so
        // this output can never contribute proof either way.
        else everySpendNamed = false;
    }

    const { txs } = await indexer.getVirtualTxs([...spentBy]);
    const observed = new Set<string>();
    for (const raw of txs) {
        let tx: Transaction;
        try {
            tx = Transaction.fromPSBT(base64.decode(raw));
        } catch {
            continue; // undecodable blob: nothing learned from it
        }
        // Witness data cannot change a taproot-only txid, so binding the
        // response by the PSBT's own id — rather than by position — is what
        // says a spend was actually observed. Same binding `restore.ts` makes.
        if (spentBy.has(tx.id)) observed.add(tx.id);
        for (let i = 0; i < tx.inputsLength; i++) {
            const spent = tx.getInput(i);
            if (!spent.txid) continue;
            // Matched by outpoint: `hex.encode(input.txid)` is the same txid
            // convention the indexer hands back, which is how the SDK's own
            // `assertCheckpointsMatchInputs` compares the two.
            const txid = hex.encode(spent.txid);
            if (!all.some((vtxo) => vtxo.txid === txid && vtxo.vout === spent.index)) continue;
            for (const candidate of candidateWitnessItems(tx, i)) {
                if (hashesTo(candidate, input.paymentHash)) {
                    return { fate: "claimed", preimage: candidate };
                }
            }
        }
    }

    // Only a lockup whose every spend was actually seen can be called returned.
    return everySpendNamed && observed.size === spentBy.size
        ? { fate: "returned" }
        : { fate: "unknown" };
}

/**
 * Build, sign, and push the `refundWithoutReceiver` spend: return every funded
 * output at the lockup to the trader's refund address.
 *
 * The leaf is `CLTV(refundLocktime) + <sender> + <server>` — the trader's own
 * VHTLC `sender` key and the Arkade server, and NOBODY else. In particular the
 * emulator is not involved: it co-signs only the two covenant leaves
 * (`nonInteractiveClaim` / `nonInteractiveRefund`), which is why the solver's
 * own escape hatch has to go through it and this one does not. So unlike that
 * push, this transaction is submitted SIGNED, and the only counterparty is the
 * Arkade server doing what it does for any collaborative spend.
 *
 * One aggregate output, not one per input — again unlike the solver's covenant
 * refund, which needs index-aligned outputs because its ArkadeScript inspects
 * the output at the current input's index. This leaf carries no covenant, so a
 * single output paying the whole balance is both valid and cheaper.
 *
 * `refundPkScript` defaults to the destination the contract itself commits to
 * (`nonInteractiveRefund`'s `senderPkScript`, i.e. the address the trader gave
 * at quote time), so the ordinary call cannot send the refund somewhere the
 * trader did not intend. It is overridable because this leaf, having no
 * covenant, genuinely does permit any destination.
 *
 * **Consensus, not wall clock, decides when this is spendable.** A seconds
 * locktime matures against median-time-past, which trails real time by roughly
 * an hour, so a push issued the moment `refundLocktime` passes can be rejected
 * until enough blocks land. That is expected, not a failure — see
 * {@link refundIfUnresolved}, which retries.
 */
export async function pushRefundWithoutReceiver(
    ark: RefundArkProvider,
    input: {
        script: InstanceType<typeof VHTLC.ScriptV2>;
        /** The `sender` private key from `requestLightningSend`/`requestOnchainSend`. */
        senderPrivateKey: Uint8Array;
        vtxos: readonly LockupVtxo[];
        /** Defaults to the contract's own committed refund destination. */
        refundPkScript?: Uint8Array;
    },
): Promise<{ arkTxid: string; amount: number }> {
    if (input.vtxos.length === 0) throw new Error("nothing to refund: no funded outputs");

    const refundPkScript =
        input.refundPkScript ?? input.script.options.nonInteractiveRefund?.senderPkScript;
    if (!refundPkScript) {
        throw new Error(
            "no refund destination: the contract carries no nonInteractiveRefund leaf, so pass refundPkScript explicitly",
        );
    }

    const info = await ark.getInfo();
    let serverUnrollScript: CSVMultisigTapscript.Type;
    try {
        serverUnrollScript = CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript));
    } catch {
        throw new Error("invalid checkpointTapscript from the Arkade server");
    }

    const leaf = input.script.refundWithoutReceiver();
    const tapTree = input.script.encode();
    const amount = input.vtxos.reduce((sum, vtxo) => sum + vtxo.value, 0);

    // buildOffchainTx reads the CLTV out of this leaf and sets the ark tx's
    // nLockTime and input sequence itself, on the checkpoints too — nothing
    // here has to restate `refundLocktime`.
    const { arkTx, checkpoints } = buildOffchainTx(
        input.vtxos.map((vtxo) => ({
            txid: vtxo.txid,
            vout: vtxo.vout,
            value: vtxo.value,
            tapLeafScript: leaf,
            tapTree,
        })),
        [{ script: refundPkScript, amount: BigInt(amount) }],
        serverUnrollScript,
    );

    const signer = SingleKey.fromPrivateKey(input.senderPrivateKey);
    // No index list: every input spends the same leaf, so all are signed.
    const signedArkTx = await signer.sign(arkTx);
    const submitted = await ark.submitTx(
        base64.encode(signedArkTx.toPSBT()),
        checkpoints.map((c) => base64.encode(c.toPSBT())),
    );
    assertSubmittedArkTxid(submitted, signedArkTx, "refundWithoutReceiver");

    // Only checkpoints we built ourselves get signed: the server's response is
    // matched against the local set first, so a substituted checkpoint is
    // rejected rather than blind-signed with the sender key.
    const matched = matchServerCheckpoints(
        submitted.signedCheckpointTxs,
        checkpoints,
        "refundWithoutReceiver",
    );
    const finalCheckpoints = await Promise.all(
        matched.map(async ({ server }) => base64.encode((await signer.sign(server, [0])).toPSBT())),
    );

    await ark.finalizeTx(submitted.arkTxid, finalCheckpoints);
    return { arkTxid: submitted.arkTxid, amount };
}

// ── Ask first, then fall back ────────────────────────────────────────────────

/**
 * How long past `refundLocktime` to keep retrying the push before giving up
 * and surfacing the server's refusal.
 *
 * Two hours because the CLTV matures against median-time-past (BIP-113), which
 * lags wall clock by about an hour, plus room for a slow block. This is the
 * mirror of `MIN_HEADROOM_SECONDS`, which refuses to FUND without 90 minutes
 * of the same margin.
 */
export const REFUND_MTP_LAG_SECONDS = 2 * 60 * 60;

export type RefundOutcome =
    /** The solver resolved it — claimed (`settled`) or returned it (`refunded`). */
    | { outcome: "resolved"; status: RfqStatus }
    /** The trader took it back via `refundWithoutReceiver`. */
    | { outcome: "refunded"; arkTxid: string; amount: number; status: RfqStatus | null }
    /** The refund window opened but the lockup holds nothing to return. */
    | { outcome: "nothing_to_refund"; status: RfqStatus | null };

/**
 * Ask first, then fall back: watch the swap for the solver to resolve it, and
 * if `refundLocktime` matures without that happening, take the lockup back
 * with `refundWithoutReceiver`.
 *
 * This is the whole trader-side failure story in one call. It polls `status()`
 * — the only "asking" this protocol has (see the module doc) — and returns as
 * soon as the solver reports `settled` or `refunded`. Otherwise, once the
 * quote's `refund_locktime` passes, it looks up what is actually at the lockup
 * and pushes the refund.
 *
 * Two behaviours worth knowing:
 *
 * - **A dead negotiation is not a reason to stop.** `refused`, `expired` and
 *   `stuck` are terminal states, but a trader can be holding a funded lockup in
 *   every one of them, so they do not end the wait — only `settled`/`refunded`
 *   do (see {@link RFQ_RESOLVED_STATES}). What ends it otherwise is the
 *   timelock.
 * - **The first push after the deadline may legitimately fail.** Median-time-
 *   past trails wall clock, so the server can still consider the leaf locked
 *   for a while after `refundLocktime` passes in real time. Failures are
 *   retried at the poll interval until `attemptDeadline`, after which the last
 *   error is rethrown rather than swallowed.
 *
 * Safe to call late, and safe to call again: a caller recovering from a crash
 * well past the deadline skips straight to the push, and a lockup that is
 * already empty comes back as `nothing_to_refund` instead of an error.
 */
export async function refundIfUnresolved(
    transport: RfqTransport,
    ark: RefundArkProvider,
    indexer: RefundIndexer,
    input: {
        rfqId: string;
        script: InstanceType<typeof VHTLC.ScriptV2>;
        senderPrivateKey: Uint8Array;
        /** `refund_locktime` from the quote, unix seconds. */
        refundLocktime: number;
        /** Defaults to the contract's own committed refund destination. */
        refundPkScript?: Uint8Array;
        pollMs?: number;
        /** Stop retrying the push at this unix time, rethrowing the last
         * error. Defaults to `refundLocktime + REFUND_MTP_LAG_SECONDS`. */
        attemptDeadline?: number;
        /** Injected for tests; defaults to wall clock, in unix seconds. */
        now?: () => number;
    },
): Promise<RefundOutcome> {
    const pollMs = input.pollMs ?? 5_000;
    const now = input.now ?? (() => Math.floor(Date.now() / 1000));
    const attemptDeadline = input.attemptDeadline ?? input.refundLocktime + REFUND_MTP_LAG_SECONDS;

    for (;;) {
        const status = await transport.status(input.rfqId);
        if (status && isResolved(status.state)) return { outcome: "resolved", status };

        if (now() >= input.refundLocktime) {
            const vtxos = await findLockupVtxos(indexer, input.script.pkScript);
            if (vtxos.length === 0) return { outcome: "nothing_to_refund", status };
            try {
                const pushed = await pushRefundWithoutReceiver(ark, {
                    script: input.script,
                    senderPrivateKey: input.senderPrivateKey,
                    vtxos,
                    refundPkScript: input.refundPkScript,
                });
                return { outcome: "refunded", status, ...pushed };
            } catch (error) {
                // Expected while median-time-past has not caught up; give up
                // only once the window closes, and surface the real reason.
                if (now() >= attemptDeadline) throw error;
            }
        }

        await sleep(pollMs);
    }
}
