/**
 * Tracking a funded RFQ swap to its end, and taking the lockup back when the
 * solver never resolves it.
 *
 * **There is no "please refund me" message in this protocol** (`RfqTransport` has only
 * `requestQuote`, `status`, `close`). "Ask first" means WATCH `status()`: a solver that gives up
 * co-signs `refund` or pushes its own `nonInteractiveRefund`, both paying the trader's committed
 * address. The fallback is the trader refunding once `refund_locktime` matures
 * ({@link refundIfUnresolved}).
 *
 * | leaf                              | needs                        | timelock |
 * |-----------------------------------|------------------------------|----------|
 * | `refund`                          | trader + solver + server     | none     |
 * | `refundWithoutReceiver`           | trader + server              | CLTV     |
 * | `unilateralRefund`                | trader + solver              | CSV      |
 * | `unilateralRefundWithoutReceiver` | trader alone                 | CSV, longest |
 *
 * `refund` needs the solver's signature, which a stuck trader cannot get. The CSV leaves only
 * count once the VTXO is onchain, i.e. after a full unilateral exit. `refundWithoutReceiver`
 * needs neither the solver nor an exit, so it is what this module builds.
 */
import { base64, hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import {
    CSVMultisigTapscript,
    ConditionWitness,
    type ArkTxInput,
    type IContractManager,
    type Identity,
    type ArkProvider,
    RestIndexerProvider,
    Transaction,
    VHTLC,
    assertSubmittedArkTxid,
    buildOffchainTx,
    getArkPsbtFields,
    hasTerminalSpend,
    matchServerCheckpoints,
    type IWallet,
} from "@arkade-os/sdk";

import { pollUntil, sleep } from "./onchainHtlc";
import { RFQ_TERMINAL_STATES, type RfqStatus, type RfqTransport } from "./rfq";

/** True for the states after which the solver will report nothing further. */
export const isRfqTerminal = (state: string): boolean =>
    (RFQ_TERMINAL_STATES as readonly string[]).includes(state);

/**
 * The terminal states that mean the lockup is already gone: claimed (`settled`) or returned
 * (`refunded`).
 *
 * Deliberately narrower than {@link RFQ_TERMINAL_STATES}: `refused`, `expired` and `stuck` end the
 * NEGOTIATION but the trader may still have funded the lockup, and is then exactly who needs the
 * refund. The VTXO lookup, not the RFQ state, decides whether anything is there.
 */
export const RFQ_RESOLVED_STATES = ["settled", "refunded"] as const;

const isResolved = (state: string): boolean =>
    (RFQ_RESOLVED_STATES as readonly string[]).includes(state);

/**
 * Poll a swap's status until it reaches a terminal state. Same conventions as
 * {@link awaitOnchainFill}; throws with `reason: "status_timeout"` past `deadline`.
 *
 * A `null` status is "not yet" (a status route can 404 briefly after a quote). Transport errors
 * reject; restarting after a blip loses nothing, since the refund is gated on an absolute
 * timelock.
 */
export async function awaitRfqResolution(
    transport: RfqTransport,
    rfqId: string,
    options: { pollMs?: number; deadline?: number } = {},
): Promise<RfqStatus> {
    return pollUntil(
        async () => {
            const status = await transport.status(rfqId);
            return status && isRfqTerminal(status.state) ? status : undefined;
        },
        options,
        "status_timeout",
        `rfq ${rfqId} did not reach a terminal state before the deadline`,
    );
}

// ── The refundWithoutReceiver push ───────────────────────────────────────────

/**
 * What a push needs from the operator: the broadcast pair, plus the info read that supplies
 * `checkpointTapscript`. Narrow so a wallet's own connection satisfies it (see
 * {@link walletOperator}) and no second connection is opened; a full `ArkProvider` also fits.
 */
export type SwapOperator = Pick<ArkProvider, "getInfo" | "submitTx" | "finalizeTx">;

/**
 * A wallet's own connection, as a {@link SwapOperator}. The broadcaster is resolved lazily and
 * held; `getInfo` is deliberately NOT held (always live): a stale `checkpointTapscript` derives a
 * checkpoint the operator will not co-sign.
 */
export const walletOperator = (wallet: IWallet): SwapOperator => {
    let broadcaster: Promise<Awaited<ReturnType<IWallet["getArkadeBroadcaster"]>>> | undefined;
    const broadcasting = () => (broadcaster ??= wallet.getArkadeBroadcaster());
    return {
        getInfo: () => wallet.getArkadeInfo({ requireLive: true }),
        submitTx: async (...args) => (await broadcasting()).submitTx(...args),
        finalizeTx: async (...args) => (await broadcasting()).finalizeTx(...args),
    };
};

/**
 * The contract-manager surface the lockup lookup needs: the registered contract and its VTXOs,
 * in one read. A real `ContractManager` syncs on every read and reports degraded fallback via
 * `getSyncState()`; {@link findLockupVtxos} trusts this read.
 */
export type LockupContractSource = Pick<IContractManager, "getContractsWithVtxos">;

/** A still-refundable virtual output sitting at the swap lockup. */
export interface LockupVtxo {
    txid: string;
    vout: number;
    value: number;
    /**
     * The batch expired and the operator swept it: still the trader's money, but no longer a
     * live leaf, so it can be RECOVERED into a fresh batch but not spent offchain
     * (`canSpendOffchain` is false whenever `canRecoverOnchain` is true), whatever key signs.
     * After recovery the ordinary CLTV refund works again; {@link pushRefundWithoutReceiver}
     * refuses these rather than submitting a doomed spend.
     */
    recoverable: boolean;
}

/**
 * Thrown when a refund was asked for over outputs that have been swept. Carries the outpoints so
 * a caller can recover exactly those, then retry.
 *
 * The remedy is the SDK's `IVtxoManager.recoverVtxos()`, which covers a lockup once it is
 * registered as a contract — so registration is what makes a swept lockup recoverable at all.
 * Caveats a caller must hold:
 *
 * - **The wallet must hold the lockup's `sender` key**: recovery settles through
 *   `refundWithoutReceiver`.
 * - **`refundLocktime` must have matured.** `recoverVtxos` settles every recoverable output in ONE
 *   round with no CLTV awareness, so recovering early can fail the whole batch.
 */
export class LockupNeedsRecoveryError extends Error {
    readonly name = "LockupNeedsRecoveryError";
    readonly reason = "needs_recovery";
    /** `txid:vout` for each output that must be recovered first. */
    readonly outpoints: string[];
    /**
     * The contract's `refundLocktime`; do not recover before it (see above). Seconds-based
     * locktimes mature against chain time, not wall clock, so treat this as a floor.
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
 * Every output still at the lockup script — spendable AND swept-but-recoverable, each tagged.
 * This read, not the RFQ's reported state, is the authority on what is left.
 *
 * All of them, not the first: a lockup funded in several sends would otherwise be partly
 * stranded. Visible is not refundable: see {@link LockupVtxo.recoverable}.
 *
 * **Unrolled and terminally spent outputs are dropped** (`hasTerminalSpend`, the wallet's own
 * spend gate): nothing offchain can reach them and `LockupVtxo` could not say so.
 * {@link readLockupFate} reports exits as `exited`; this drop is the second line of defence.
 *
 * **Reads the REGISTERED contract row and trusts it**, with no fallback to a script query:
 * callers own registration (`request*Send`, `RfqSwapManager.ensureRegistered`), and an empty row
 * is honored as-is. {@link readLockupFate} stays on the indexer because it needs the spending
 * transactions' witnesses, which the manager does not expose.
 */
export async function findLockupVtxos(
    contracts: LockupContractSource,
    swapPkScript: Uint8Array,
): Promise<LockupVtxo[]> {
    const [row] = await contracts.getContractsWithVtxos({
        script: hex.encode(swapPkScript),
    });
    const seen = new Set<string>();
    const out: LockupVtxo[] = [];
    for (const vtxo of row?.vtxos ?? []) {
        if (vtxo.isUnrolled) continue;
        if (hasTerminalSpend(vtxo)) continue;
        const key = `${vtxo.txid}:${vtxo.vout}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            txid: vtxo.txid,
            vout: vtxo.vout,
            value: Number(vtxo.value),
            recoverable: vtxo.isSwept,
        });
    }
    return out;
}

// ── Reading the lockup's fate off chain ──────────────────────────────────────

/**
 * The indexer surface the lockup-spend read needs: the vtxo lookup, plus the raw transactions
 * those vtxos were spent by. Taken by `SwapDriveConfig.indexer`; returned by
 * `walletLockupIndexer()`.
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
    /** Spent by a witness carrying a preimage that HASHES to the quote's `payment_hash`. */
    | { fate: "claimed"; preimage: Uint8Array; spends: readonly LockupSpend[] }
    /** Fully spent, and nothing that spent it revealed a matching preimage —
     * so the money went back to the trader. See {@link readLockupFate}. */
    | { fate: "returned"; spends: readonly LockupSpend[] }
    /**
     * At least one output was unilaterally exited: onchain under the VHTLC script, beyond any
     * offchain claim or refund. Not terminal and not a loss (`completeUnroll` plus an onchain
     * spend can still end it). Outranks `open` and any sibling's verdict: unspent-but-unreachable
     * is not a merely running swap.
     */
    | { fate: "exited"; outpoints: readonly { txid: string; vout: number }[] }
    /** Nothing was learned (see {@link readLockupFate}). Never an answer. */
    | { fate: "unknown" };

/** `sha256(candidate)` against the quote's payment hash — see {@link readLockupFate}. */
const hashesTo = (candidate: Uint8Array, paymentHash: string): boolean =>
    hex.encode(sha256(candidate)) === paymentHash;

/**
 * Every witness item one input of a spend might carry the preimage in: Ark's `ConditionWitness`
 * PSBT field (survives a default `fromPSBT`) and `finalScriptWitness`. Reading only one could
 * miss a real settlement; reading both is free because neither is trusted until hashed.
 */
const candidateWitnessItems = (tx: Transaction, inputIndex: number): Uint8Array[] => [
    ...getArkPsbtFields(tx, inputIndex, ConditionWitness).flat(),
    ...(tx.getInput(inputIndex).finalScriptWitness ?? []),
];

/**
 * Decide from chain data alone whether a swap lockup settled, came back, or is
 * still live.
 *
 * **Decidable without asking anyone.** Only the claim leaf reveals `P`, and the counterparty only
 * legitimately obtains `P` by completing its side. Every OTHER leaf is a refund:
 * `nonInteractiveRefund` is covenant-pinned to the trader's address and the rest need the
 * trader's signature. So "spent, but not by a hash-verified claim" means the money came back.
 *
 * **A matching witness SHAPE is not proof**: only a candidate hashing to `paymentHash` counts.
 * Being permissive would report "settled" for a swap that refunded.
 *
 * **`unknown` is not `returned`**: an empty vtxo set, an unnamed or unfetchable spend, or an
 * undecodable blob all give `unknown`, and `getVirtualTxs` may return fewer txs than asked, so the
 * observed set is counted. Treat `unknown` like `open`; the refund timelock ends the wait.
 *
 * An exit is checked first, across the whole set, so output order cannot change the answer.
 * Read fresh on every poll, never cached.
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

    const exited = all.filter((vtxo) => vtxo.isUnrolled && !hasTerminalSpend(vtxo));
    if (exited.length > 0) {
        return {
            fate: "exited",
            outpoints: exited.map((vtxo) => ({ txid: vtxo.txid, vout: vtxo.vout })),
        };
    }

    const spentBy = new Map<string, LockupSpend>();
    let everySpendNamed = true;
    for (const vtxo of all) {
        // Not `spentBy` alone: the wire permits `isSpent: true` with an EMPTY `spentBy`.
        if (!hasTerminalSpend(vtxo)) return { fate: "open" };
        // Truthiness, not presence: an unnamed `spentBy` is "". When set it names the
        // CHECKPOINT tx, which carries the lockup leaf's witness (the ark tx spends the
        // checkpoint, so it is the wrong place to look).
        if (vtxo.spentBy)
            spentBy.set(vtxo.spentBy, {
                checkpointTxid: vtxo.spentBy,
                txid: vtxo.arkTxId,
            });
        // Spent by nothing we can read: no witness, so no proof either way.
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
        // Bound by the PSBT's own id (witness cannot change a taproot txid), not by position.
        if (spentBy.has(tx.id)) observed.add(tx.id);
        for (let i = 0; i < tx.inputsLength; i++) {
            const spent = tx.getInput(i);
            if (!spent.txid) continue;
            // Same txid convention as the indexer (cf. `assertCheckpointsMatchInputs`).
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

/** Refuse a spend over any swept output — see {@link pushRefundWithoutReceiver}. */
export const assertNoneSwept = (
    vtxos: readonly LockupVtxo[],
    contract: InstanceType<typeof VHTLC.ScriptV2>,
): void => {
    const swept = vtxos.filter((vtxo) => vtxo.recoverable);
    if (swept.length > 0) {
        throw new LockupNeedsRecoveryError(
            swept.map((vtxo) => `${vtxo.txid}:${vtxo.vout}`),
            contract.options.refundLocktime,
        );
    }
};

export const operatorUnrollScript = async (
    operator: SwapOperator,
): Promise<CSVMultisigTapscript.Type> => {
    const info = await operator.getInfo();
    try {
        return CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript));
    } catch {
        throw new Error("invalid checkpointTapscript from the operator");
    }
};

/** Every lockup output as an offchain input spending `leaf`. */
export const lockupInputs = (
    vtxos: readonly LockupVtxo[],
    contract: InstanceType<typeof VHTLC.ScriptV2>,
    leaf: ArkTxInput["tapLeafScript"],
): ArkTxInput[] => {
    const tapTree = contract.encode();
    return vtxos.map((vtxo) => ({
        txid: vtxo.txid,
        vout: vtxo.vout,
        value: vtxo.value,
        tapLeafScript: leaf,
        tapTree,
    }));
};

/**
 * Build, sign, and push the `refundWithoutReceiver` spend: return every funded
 * output at the lockup to the trader's refund address.
 *
 * The leaf is `CLTV(refundLocktime) + <sender> + <server>`: no emulator (it co-signs only the
 * covenant leaves), so the tx is submitted SIGNED. One aggregate output, since this leaf has no
 * covenant requiring index-aligned outputs.
 *
 * `refundPkScript` defaults to the contract's committed `senderPkScript` (the trader's quote-time
 * address); overridable because this leaf genuinely permits any destination.
 *
 * **Median-time-past (BIP-113), not wall clock, decides spendability**: it trails by about an
 * hour, so an early rejection is expected; {@link refundIfUnresolved} retries.
 *
 * **Swept outputs refuse the whole push** with {@link LockupNeedsRecoveryError}: one swept input
 * would sink the aggregate tx, and silently filtering it would report success over unmoved money.
 */
export async function pushRefundWithoutReceiver(
    operator: SwapOperator,
    input: {
        contract: InstanceType<typeof VHTLC.ScriptV2>;
        /** The `sender` signer. Build it with {@link senderIdentityForSwapRecord}, so every
         * inability to produce it is a typed, permanent {@link RefundNotLocallyPossibleError}. */
        sender: Identity;
        vtxos: readonly LockupVtxo[];
        /** Defaults to the contract's own committed refund destination. */
        refundPkScript?: Uint8Array;
    },
): Promise<{ txid: string; amount: number }> {
    if (input.vtxos.length === 0) throw new Error("nothing to refund: no funded outputs");

    assertNoneSwept(input.vtxos, input.contract);

    const refundPkScript =
        input.refundPkScript ?? input.contract.options.nonInteractiveParameters?.senderPkScript;
    if (!refundPkScript) {
        throw new Error(
            "no refund destination: the contract carries no emulator covenant suite, so pass refundPkScript explicitly",
        );
    }

    const serverUnrollScript = await operatorUnrollScript(operator);

    const leaf = input.contract.refundWithoutReceiver();
    const amount = input.vtxos.reduce((sum, vtxo) => sum + vtxo.value, 0);

    // buildOffchainTx sets nLockTime/sequence from the leaf's CLTV, checkpoints included.
    const { arkTx: tx, checkpoints } = buildOffchainTx(
        lockupInputs(input.vtxos, input.contract, leaf),
        [{ script: refundPkScript, amount: BigInt(amount) }],
        serverUnrollScript,
    );

    // No index list: every input spends the same leaf, so all are signed.
    const signedTx = await input.sender.sign(tx);
    const submitted = await operator.submitTx(
        base64.encode(signedTx.toPSBT()),
        checkpoints.map((c) => base64.encode(c.toPSBT())),
    );
    assertSubmittedArkTxid(submitted, signedTx, "refundWithoutReceiver");

    // Only checkpoints we built get signed: a substituted one is rejected, not blind-signed.
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
 * How long past `refundLocktime` to keep retrying the push before surfacing the server's refusal.
 * Two hours: MTP (BIP-113) lags wall clock by about an hour, plus room for a slow block. Mirror
 * of `MIN_HEADROOM_SECONDS`, which refuses to FUND without 90 minutes of the same margin.
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
     * The money is still at the lockup but its batch was swept; no waiting fixes that (see
     * {@link LockupNeedsRecoveryError}). Recover the named outpoints, then call again.
     */
    | {
          outcome: "needs_recovery";
          outpoints: string[];
          vtxos: LockupVtxo[];
          status: RfqStatus | null;
      }
    /**
     * The lockup was unilaterally exited: its outputs sit onchain, beyond any offchain refund.
     * Complete the unroll and spend the named outputs onchain.
     *
     * **`outpoints` may not be the whole lockup.** `exited` fires as soon as ANY output exited
     * (the same rule `RfqSwapManager` uses; the two must agree), and a still-live sibling is left
     * for the caller to pursue separately. Distinct from `needs_recovery`, whose batch-recovery
     * remedy cannot reach an onchain output.
     */
    | { outcome: "exited"; outpoints: string[]; status: RfqStatus | null };

/**
 * Ask first, then fall back: watch the swap for the solver to resolve it, and
 * if `refundLocktime` matures without that happening, take the lockup back
 * with `refundWithoutReceiver`.
 *
 * - **A dead negotiation does not stop the wait** (see {@link RFQ_RESOLVED_STATES}).
 * - **Early pushes may fail** while MTP catches up; retried at the poll interval until
 *   `attemptDeadline`, then the last error is rethrown.
 * - **A swept lockup returns `needs_recovery`** instead of burning the window.
 * - **An exited lockup returns `exited`**, checked first via {@link readLockupFate} (an extra
 *   indexer read per pass). A failing fate read is swallowed: it is a shortcut only.
 *
 * Safe to call late and to call again: an empty lockup is `nothing_to_refund`, not an error.
 *
 * @deprecated Use `client.recover()`. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export async function refundIfUnresolved(
    transport: RfqTransport,
    operator: SwapOperator,
    contracts: LockupContractSource,
    indexer: LockupSpendIndexer,
    input: {
        rfqId: string;
        contract: InstanceType<typeof VHTLC.ScriptV2>;
        /** @see pushRefundWithoutReceiver */
        sender: Identity;
        /**
         * `sha256(P)`, hex — the quote's `payment_hash`. Not derivable from `script`, whose
         * `preimageHash` is a `hash160`.
         */
        paymentHash: string;
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
            // Before the refundable read, to prevent the doomed push. Guarded: a transient
            // `getVirtualTxs` failure must not end a wait the path below can answer.
            let fate: LockupFate = { fate: "unknown" };
            try {
                fate = await readLockupFate(indexer, {
                    swapPkScript: input.contract.pkScript,
                    paymentHash: input.paymentHash,
                });
            } catch {
                // `findLockupVtxos`'s own drop still refuses the doomed push.
            }
            if (fate.fate === "exited") {
                return {
                    outcome: "exited",
                    outpoints: fate.outpoints.map((o) => `${o.txid}:${o.vout}`),
                    status,
                };
            }

            const vtxos = await findLockupVtxos(contracts, input.contract.pkScript);
            if (vtxos.length === 0) return { outcome: "nothing_to_refund", status };
            try {
                const pushed = await pushRefundWithoutReceiver(operator, {
                    contract: input.contract,
                    sender: input.sender,
                    vtxos,
                    refundPkScript: input.refundPkScript,
                });
                return { outcome: "refunded", status, ...pushed };
            } catch (error) {
                // Swept is "not this way", not "not yet": retrying would burn the window.
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
