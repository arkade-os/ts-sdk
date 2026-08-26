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
    type Identity,
    RestArkProvider,
    RestIndexerProvider,
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
export type RefundOperatorProvider = Pick<RestArkProvider, "getInfo" | "submitTx" | "finalizeTx">;

/** The indexer surface the lockup lookup needs. */
export type RefundIndexer = Pick<RestIndexerProvider, "getVtxos">;

/** A still-refundable virtual output sitting at the swap lockup. */
export interface LockupVtxo {
    txid: string;
    vout: number;
    value: number;
    /**
     * The batch this output lived in expired and the operator swept it, so it
     * is no longer a live leaf — it can be RECOVERED, but not spent offchain.
     *
     * It is still the trader's money and it is still visible, which is why
     * {@link findLockupVtxos} returns it. What it is not is refundable by
     * {@link pushRefundWithoutReceiver}: that builds an offchain Ark
     * transaction, and the SDK's own predicates make the two states mutually
     * exclusive — `canSpendOffchain` is false exactly when `canRecoverOnchain`
     * is true (`wallet/vtxo.ts`), and the latter is documented as "must be
     * recovered into a fresh batch rather than spent offchain". Holding the
     * trader's `sender` key does not change that; a sweep removes the leaf from
     * the live tree, not the signature from the trader.
     *
     * `packages/boltz-swap` splits on exactly this fact rather than working
     * around it: `settleRefundWithoutReceiver` sends a live VTXO through an
     * offchain tx and a recoverable one through `joinBatch` — "a swept
     * (recoverable) VTXO is no longer a live leaf, so it can only be reclaimed
     * by re-registering it into a batch".
     *
     * So the remedy is recovery (renewing the output into a fresh batch),
     * after which the ordinary CLTV refund works again. This package does not
     * build that round — see {@link pushRefundWithoutReceiver}, which refuses
     * rather than submitting a spend that cannot succeed.
     */
    recoverable: boolean;
}

/**
 * Thrown when a refund was asked for over outputs that have been swept.
 *
 * Carries the outpoints so a caller can act — recover exactly those, then
 * retry — instead of reading a server rejection and guessing. `reason` follows
 * the same convention as `awaitOnchainFill`'s `fill_timeout` and
 * `claimOnchainFill`'s `claim_window_closed`.
 *
 * **The remedy already exists; this package does not reimplement it.** The SDK
 * recovers swept outputs by re-registering them into a fresh batch, through
 * `IVtxoManager.recoverVtxos()` — the same batch round `packages/boltz-swap`
 * reaches via its own `joinBatch`. It reads the wallet's registered-contract
 * snapshot (`recoverVtxos` → `wallet.getVtxos({ withRecoverable: true })` →
 * `contractSnapshot()` → `contractManager.getContractsWithVtxos()`), so it
 * covers a swap lockup as soon as that lockup is registered as a contract —
 * which is what {@link RfqSwapManagerDeps.contracts} does. Registration is
 * therefore not only a latency optimization; it is what turns a swept lockup
 * from a dead end into something the ordinary wallet path can recover.
 *
 * Two caveats a caller must hold, neither enforceable from here:
 *
 * - **The wallet must hold the lockup's `sender` key**, because recovery
 *   settles through `refundWithoutReceiver` — the leaf `vhtlc-v2` annotates
 *   these VTXOs with.
 * - **`refundLocktime` must have matured.** That leaf carries a CLTV, so a
 *   recovery round including this VTXO earlier is rejected. `recoverVtxos`
 *   sweeps every recoverable output in ONE settlement and has no CLTV
 *   awareness, so recovering early can fail the whole batch rather than just
 *   this output. `packages/boltz-swap` encodes the same rule as "pre-CLTV
 *   recoverable → skipped".
 */
export class LockupNeedsRecoveryError extends Error {
    readonly name = "LockupNeedsRecoveryError";
    readonly reason = "needs_recovery";
    /** `txid:vout` for each output that must be recovered first. */
    readonly outpoints: string[];
    /**
     * The contract's `refundLocktime`. Recovering before this matures is the
     * hazard described above: `recoverVtxos()` sweeps EVERY recoverable output
     * into one settlement with no CLTV awareness, so an early attempt can fail
     * the whole batch — including unrelated outputs that were otherwise fine.
     *
     * Exposed as a value, not only inside the message, so a caller can encode
     * `packages/boltz-swap`'s "pre-CLTV recoverable → skipped" rule without
     * parsing prose. Seconds-based locktimes mature against the chain tip's
     * timestamp rather than wall clock, so treat this as a floor to wait past,
     * not an exact alarm.
     */
    readonly recoverableAfter: bigint;

    constructor(outpoints: string[], recoverableAfter: bigint) {
        super(
            `refund refused: ${outpoints.length} lockup output(s) have been swept and can no longer be spent offchain ` +
                `(${outpoints.join(", ")}). Recover them into a fresh batch first — ` +
                `IVtxoManager.recoverVtxos() does this for a wallet whose contract manager has the ` +
                `lockup registered, once refundLocktime (${recoverableAfter}) has matured — then retry the refund. ` +
                `Recovering before then can fail the entire settlement, not just these outputs.`,
        );
        this.outpoints = outpoints;
        this.recoverableAfter = recoverableAfter;
    }
}

/**
 * Every output still sitting at the lockup script — spendable AND
 * swept-but-recoverable, each tagged with which it is.
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
 * **Visible is not the same as refundable.** A `recoverable` output cannot be
 * spent offchain at all — see {@link LockupVtxo.recoverable} — so this set is
 * "what is there", not "what {@link pushRefundWithoutReceiver} can take back".
 * That function refuses the recoverable ones by name rather than submitting a
 * spend the server must reject.
 *
 * This read — not the RFQ's reported state — is the authority on whether
 * there is anything left at the lockup.
 *
 * **Not replaced by the contract manager's VTXO state, deliberately.** Once a
 * lockup is registered (see `RfqSwapManagerDeps.contracts`) the wallet tracks
 * these same outputs, and `getContractsWithVtxos` plus `canSpendOffchain` /
 * `canRecoverOnchain` would classify them. That is a WEAKER answer here on two
 * counts: it serves the wallet REPOSITORY, which a degraded sync will happily
 * hand back stale (`getSyncState()` reports `degraded` and returns cached rows
 * rather than failing), and its height-based expiry test needs a chain tip this
 * module does not have. The two queries below ask the indexer itself and need
 * neither. Ask-the-indexer, don't-trust-local-state — the same posture
 * {@link readLockupFate} takes, and for the same reason: this decides money.
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
export interface LockupSpend {
    /** What the vtxo's `spentBy` names — the checkpoint, never the ark
     * transaction. */
    checkpointTxid: string;
    /** The ark transaction that spent the above checkpoint output. What
     * history correlation matches on; absent when the indexer omitted it. */
    txid?: string;
}

export type LockupFate =
    /** At least one output at the lockup is still unspent. Not over. */
    | { fate: "open" }
    /** Spent by a witness carrying a preimage that HASHES to the quote's
     * `payment_hash`. Only the claim leaf can reveal one, and the only
     * legitimate way the solver obtains it is by completing its side. */
    | { fate: "claimed"; preimage: Uint8Array; spends: readonly LockupSpend[] }
    /** Fully spent, and nothing that spent it revealed a matching preimage —
     * so the money went back to the trader. See {@link readLockupFate}. */
    | { fate: "returned"; spends: readonly LockupSpend[] }
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

    const spentBy = new Map<string, LockupSpend>();
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
        if (vtxo.spentBy)
            spentBy.set(vtxo.spentBy, {
                checkpointTxid: vtxo.spentBy,
                txid: vtxo.arkTxId,
            });
        // Spent, but by nothing this can go and read. No witness to verify, so
        // this output can never contribute proof either way.
        else everySpendNamed = false;
    }

    const spends = [...spentBy.values()];
    const { txs } = await indexer.getVirtualTxs([...spentBy.keys()]);
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
                    return { fate: "claimed", preimage: candidate, spends };
                }
            }
        }
    }

    // Only a lockup whose every spend was actually seen can be called returned.
    return everySpendNamed && observed.size === spentBy.size
        ? { fate: "returned", spends }
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
 *
 * **Swept outputs are refused, not attempted.** This is an OFFCHAIN spend, and
 * a swept output is no longer a live leaf: `canSpendOffchain` and
 * `canRecoverOnchain` are mutually exclusive by construction, so a recoverable
 * input cannot be spent this way whatever key signs it (see
 * {@link LockupVtxo.recoverable}). Because every input lands in ONE aggregate
 * transaction, a single swept output would take the live ones down with it —
 * so the whole push is refused with {@link LockupNeedsRecoveryError} naming the
 * outpoints, rather than submitted and rejected. Filtering them out silently
 * would be worse still: it would report success over money that never moved.
 */
export async function pushRefundWithoutReceiver(
    operator: RefundOperatorProvider,
    input: {
        script: InstanceType<typeof VHTLC.ScriptV2>;
        /** The `sender` signer. Build it from the swap record with
         * {@link senderIdentityForSwapRecord} — on an HD wallet that resolves
         * from the seed, with no stored key bytes anywhere, and every way the
         * wallet can fail to produce it arrives as one typed
         * {@link RefundNotLocallyPossibleError} the manager reads as permanent
         * rather than retrying for the rest of the refund window. */
        sender: Identity;
        vtxos: readonly LockupVtxo[];
        /** Defaults to the contract's own committed refund destination. */
        refundPkScript?: Uint8Array;
    },
): Promise<{ txid: string; amount: number }> {
    if (input.vtxos.length === 0) throw new Error("nothing to refund: no funded outputs");

    const swept = input.vtxos.filter((vtxo) => vtxo.recoverable);
    if (swept.length > 0) {
        throw new LockupNeedsRecoveryError(
            swept.map((vtxo) => `${vtxo.txid}:${vtxo.vout}`),
            input.script.options.refundLocktime,
        );
    }

    const refundPkScript =
        input.refundPkScript ?? input.script.options.nonInteractiveRefund?.senderPkScript;
    if (!refundPkScript) {
        throw new Error(
            "no refund destination: the contract carries no nonInteractiveRefund leaf, so pass refundPkScript explicitly",
        );
    }

    const info = await operator.getInfo();
    let operatorUnrollScript: CSVMultisigTapscript.Type;
    try {
        operatorUnrollScript = CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript));
    } catch {
        throw new Error("invalid checkpointTapscript from the Arkade server");
    }

    const leaf = input.script.refundWithoutReceiver();
    const tapTree = input.script.encode();
    const amount = input.vtxos.reduce((sum, vtxo) => sum + vtxo.value, 0);

    // buildOffchainTx reads the CLTV out of this leaf and sets the ark tx's
    // nLockTime and input sequence itself, on the checkpoints too — nothing
    // here has to restate `refundLocktime`.
    const { arkTx: tx, checkpoints } = buildOffchainTx(
        input.vtxos.map((vtxo) => ({
            txid: vtxo.txid,
            vout: vtxo.vout,
            value: vtxo.value,
            tapLeafScript: leaf,
            tapTree,
        })),
        [{ script: refundPkScript, amount: BigInt(amount) }],
        operatorUnrollScript,
    );

    // No index list: every input spends the same leaf, so all are signed.
    const signedTx = await input.sender.sign(tx);
    const submitted = await operator.submitTx(
        base64.encode(signedTx.toPSBT()),
        checkpoints.map((c) => base64.encode(c.toPSBT())),
    );
    assertSubmittedArkTxid(submitted, signedTx, "refundWithoutReceiver");

    // Only checkpoints we built ourselves get signed: the server's response is
    // matched against the local set first, so a substituted checkpoint is
    // rejected rather than blind-signed with the sender key.
    const matched = matchServerCheckpoints(
        submitted.signedCheckpointTxs,
        checkpoints,
        "refundWithoutReceiver",
    );
    const finalCheckpoints = await Promise.all(
        matched.map(async ({ server }) =>
            base64.encode((await input.sender.sign(server, [0])).toPSBT()),
        ),
    );

    await operator.finalizeTx(submitted.arkTxid, finalCheckpoints);
    return { txid: submitted.arkTxid, amount };
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
    | { outcome: "refunded"; txid: string; amount: number; status: RfqStatus | null }
    /** The refund window opened but the lockup holds nothing to return. */
    | { outcome: "nothing_to_refund"; status: RfqStatus | null }
    /**
     * The money is still at the lockup, but its batch was swept, so no offchain
     * spend can take it back until it is recovered into a fresh batch. Returned
     * rather than retried: unlike a median-time-past refusal, no amount of
     * waiting fixes this — see {@link LockupNeedsRecoveryError}. Recover the
     * named outpoints, then call this again.
     */
    | {
          outcome: "needs_recovery";
          outpoints: string[];
          vtxos: LockupVtxo[];
          status: RfqStatus | null;
      };

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
 * - **A swept lockup ends the wait instead of consuming it.** Once the batch
 *   is gone the CLTV refund is not "not yet" but "not this way", so it returns
 *   `needs_recovery` naming the outpoints rather than retrying until the
 *   deadline. Recover them and call again.
 *
 * Safe to call late, and safe to call again: a caller recovering from a crash
 * well past the deadline skips straight to the push, and a lockup that is
 * already empty comes back as `nothing_to_refund` instead of an error.
 */
export async function refundIfUnresolved(
    transport: RfqTransport,
    operator: RefundOperatorProvider,
    indexer: RefundIndexer,
    input: {
        rfqId: string;
        script: InstanceType<typeof VHTLC.ScriptV2>;
        /** @see pushRefundWithoutReceiver */
        sender: Identity;
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
                const pushed = await pushRefundWithoutReceiver(operator, {
                    script: input.script,
                    sender: input.sender,
                    vtxos,
                    refundPkScript: input.refundPkScript,
                });
                return { outcome: "refunded", status, ...pushed };
            } catch (error) {
                // A swept lockup is not a "not yet" — it is a "not this way".
                // Retrying it until `attemptDeadline` would burn the whole
                // window on a spend that cannot succeed and then rethrow, when
                // the caller could have recovered the outputs and finished.
                if (error instanceof LockupNeedsRecoveryError) {
                    return {
                        outcome: "needs_recovery",
                        outpoints: error.outpoints,
                        vtxos,
                        status,
                    };
                }
                // Expected while median-time-past has not caught up; give up
                // only once the window closes, and surface the real reason.
                if (now() >= attemptDeadline) throw error;
            }
        }

        await sleep(pollMs);
    }
}
