/**
 * Tracking a funded swap and taking the lockup back.
 *
 * The tests that matter most assert the two things a refund can silently get
 * wrong and only discover on chain: that the spend really uses the
 * `refundWithoutReceiver` leaf (carrying the CLTV that makes it valid), and
 * that a dead-but-funded swap is still refunded rather than reported done.
 */
import { describe, expect, it } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { CSVMultisigTapscript, SingleKey, Transaction, type ArkProvider } from "@arkade-os/sdk";

import { lightningSendContract, type RfqStatus, type RfqTransport } from "../src/rfq";
import {
    LockupNeedsRecoveryError,
    RFQ_RESOLVED_STATES,
    awaitRfqResolution,
    findLockupVtxos,
    isRfqTerminal,
    pushRefundWithoutReceiver,
    readLockupFate,
    refundIfUnresolved,
    type LockupSpendIndexer,
    type LockupVtxo,
    type RefundIndexer,
} from "../src/refund";

const priv = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const key = (fill: number): Uint8Array => schnorr.getPublicKey(priv(fill));
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

const RFQ_ID = "a1".repeat(32);
const REFUND_LOCKTIME = 1_800_000_000;
const SENDER_PRIVATE_KEY = priv(13);
/** The sender key as the signer the refund path now takes. */
const SENDER = SingleKey.fromPrivateKey(SENDER_PRIVATE_KEY);
const REFUND_PK_SCRIPT = p2tr(key(5));

/** The same golden participant set rfq.test.ts pins the script bytes against. */
const swapScript = () =>
    lightningSendContract({
        solverPubkey: key(1),
        operatorPubkey: key(3),
        paymentHash: hex.encode(sha256(new Uint8Array(32).fill(7))),
        refundLocktime: REFUND_LOCKTIME,
        claimDelay: 4096,
        emulatorPubkey: key(9),
        refundPkScript: REFUND_PK_SCRIPT,
        senderPubkey: key(13),
        receiverPkScript: p2tr(key(1)),
    });

const CHECKPOINT_TAPSCRIPT = hex.encode(
    CSVMultisigTapscript.encode({
        timelock: { type: "blocks", value: BigInt(144) },
        pubkeys: [key(3)],
    }).script,
);

const VTXOS: LockupVtxo[] = [
    { txid: "11".repeat(32), vout: 0, value: 60_000, recoverable: false },
    { txid: "22".repeat(32), vout: 1, value: 40_000, recoverable: false },
];

/** A scripted arkd: echoes back the checkpoints it was handed (as a real one
 * does, plus its own signature) and reports the ark txid it was submitted.
 * Typed against the production contract so a change to ArkProvider
 * breaks the fake at compile time. */
type FakeOperator = ArkProvider & {
    submitted: { tx: string; checkpoints: string[] }[];
    finalized: { txid: string; checkpoints: string[] }[];
};

const fakeOperator = (
    over: {
        checkpointTapscript?: string;
        checkpointsFor?: (submitted: string[]) => string[];
        failSubmit?: () => Error | undefined;
    } = {},
): FakeOperator => {
    const submitted: { tx: string; checkpoints: string[] }[] = [];
    const finalized: { txid: string; checkpoints: string[] }[] = [];
    return {
        submitted,
        finalized,
        getInfo: async () => ({
            checkpointTapscript: over.checkpointTapscript ?? CHECKPOINT_TAPSCRIPT,
        }),
        submitTx: async (tx: string, checkpoints: string[]) => {
            const failure = over.failSubmit?.();
            if (failure) throw failure;
            submitted.push({ tx, checkpoints });
            return {
                arkTxid: Transaction.fromPSBT(base64.decode(tx)).id,
                finalArkTx: tx,
                signedCheckpointTxs: over.checkpointsFor
                    ? over.checkpointsFor(checkpoints)
                    : checkpoints,
            };
        },
        finalizeTx: async (txid: string, checkpoints: string[]) => {
            finalized.push({ txid, checkpoints });
        },
    } as unknown as FakeOperator;
};

const fakeIndexer = (vtxos: LockupVtxo[]): RefundIndexer & { scripts: string[][] } => {
    const scripts: string[][] = [];
    return {
        scripts,
        getVtxos: async (opts?: { scripts?: string[] }) => {
            scripts.push(opts?.scripts ?? []);
            return { vtxos };
        },
    } as unknown as RefundIndexer & { scripts: string[][] };
};

const statusOf = (state: string): RfqStatus => ({
    v: 1,
    type: "rfq_status",
    rfq_id: RFQ_ID,
    state,
    updated_at: 1,
    profile: {},
});

/** A transport that serves a scripted sequence of statuses, repeating the last. */
const fakeTransport = (states: (string | null)[]): RfqTransport & { calls: number } => {
    const transport = {
        calls: 0,
        async requestQuote() {
            throw new Error("not used");
        },
        async status() {
            const state = states[Math.min(transport.calls, states.length - 1)];
            transport.calls += 1;
            return state === null ? null : statusOf(state);
        },
        async close() {},
    };
    return transport as unknown as RfqTransport & { calls: number };
};

/** The leaf script the ark tx's single input actually spends. */
const spentLeafOf = (psbt: string): string => {
    const tx = Transaction.fromPSBT(base64.decode(psbt));
    const leaf = tx.getInput(0).tapLeafScript![0][1];
    return hex.encode(leaf.subarray(0, -1));
};

describe("pushRefundWithoutReceiver", () => {
    it("spends the refundWithoutReceiver leaf, signed by the trader's own sender key", async () => {
        const contract = swapScript();
        const operator = fakeOperator();
        await pushRefundWithoutReceiver(operator, {
            contract: contract,
            sender: SENDER,
            vtxos: VTXOS,
        });

        expect(operator.submitted).toHaveLength(1);
        // Not `refund` (needs the solver) and not a unilateral leaf (needs an
        // exit): the CLTV leaf is the only one a stranded trader can drive.
        expect(spentLeafOf(operator.submitted[0].tx)).toBe(contract.refundWithoutReceiverScript);

        // SingleKey.sign() swallows "No inputs signed", so an unsigned tx would
        // otherwise sail through to submitTx and be rejected only server-side.
        const tx = Transaction.fromPSBT(base64.decode(operator.submitted[0].tx));
        for (let i = 0; i < tx.inputsLength; i++) {
            expect(tx.getInput(i).tapScriptSig?.length).toBeGreaterThan(0);
        }
    });

    it("carries the CLTV locktime and an nLockTime-enabling sequence", async () => {
        const operator = fakeOperator();
        await pushRefundWithoutReceiver(operator, {
            contract: swapScript(),
            sender: SENDER,
            vtxos: VTXOS,
        });

        // Without both of these the spend is simply not consensus-valid — and
        // nothing in this package restates the locktime, so this is the check
        // that the CLTV leaf (not a timelock-free one) was handed to the builder.
        const tx = Transaction.fromPSBT(base64.decode(operator.submitted[0].tx));
        expect(tx.lockTime).toBe(REFUND_LOCKTIME);
        expect(tx.getInput(0).sequence).toBeLessThan(0xffffffff);
    });

    it("returns every funded output to the contract's own committed destination", async () => {
        const operator = fakeOperator();
        const result = await pushRefundWithoutReceiver(operator, {
            contract: swapScript(),
            sender: SENDER,
            vtxos: VTXOS,
        });

        // Both deposits, aggregated: refunding vtxos[0] alone would strand the
        // rest at a script whose other refund paths are all longer.
        expect(result.amount).toBe(100_000);
        const tx = Transaction.fromPSBT(base64.decode(operator.submitted[0].tx));
        expect(tx.inputsLength).toBe(2);
        expect(hex.encode(tx.getOutput(0).script!)).toBe(hex.encode(REFUND_PK_SCRIPT));
        expect(tx.getOutput(0).amount).toBe(BigInt(100_000));
        expect(operator.finalized).toHaveLength(1);
        expect(operator.finalized[0].txid).toBe(result.txid);
    });

    it("honours an explicit destination override", async () => {
        const operator = fakeOperator();
        const elsewhere = p2tr(key(21));
        await pushRefundWithoutReceiver(operator, {
            contract: swapScript(),
            sender: SENDER,
            vtxos: VTXOS,
            refundPkScript: elsewhere,
        });
        const tx = Transaction.fromPSBT(base64.decode(operator.submitted[0].tx));
        expect(hex.encode(tx.getOutput(0).script!)).toBe(hex.encode(elsewhere));
    });

    it("refuses an empty lockup instead of pushing an inputless transaction", async () => {
        await expect(
            pushRefundWithoutReceiver(fakeOperator(), {
                contract: swapScript(),
                sender: SENDER,
                vtxos: [],
            }),
        ).rejects.toThrow(/nothing to refund/);
    });

    describe("swept outputs", () => {
        /**
         * A swept output is no longer a live leaf, so no OFFCHAIN spend can
         * take it back — `canSpendOffchain` and `canRecoverOnchain` are
         * mutually exclusive in the SDK, and the latter means "must be
         * recovered into a fresh batch rather than spent offchain". Holding the
         * sender key does not change that.
         */
        it("refuses rather than submitting a spend the server must reject", async () => {
            const operator = fakeOperator();
            const swept: LockupVtxo[] = [
                { txid: "33".repeat(32), vout: 0, value: 5_000, recoverable: true },
            ];
            await expect(
                pushRefundWithoutReceiver(operator, {
                    contract: swapScript(),
                    sender: SENDER,
                    vtxos: swept,
                }),
            ).rejects.toThrow(LockupNeedsRecoveryError);
            // Nothing was sent: the point is to refuse before the round trip.
            expect(operator.submitted).toEqual([]);
        });

        it("names the outpoints that need recovering", async () => {
            const swept: LockupVtxo[] = [
                { txid: "33".repeat(32), vout: 2, value: 5_000, recoverable: true },
            ];
            const error: unknown = await pushRefundWithoutReceiver(fakeOperator(), {
                contract: swapScript(),
                sender: SENDER,
                vtxos: swept,
            }).then(
                () => undefined,
                (e: unknown) => e,
            );
            expect(error).toBeInstanceOf(LockupNeedsRecoveryError);
            const needsRecovery = error as LockupNeedsRecoveryError;
            expect(needsRecovery.reason).toBe("needs_recovery");
            expect(needsRecovery.outpoints).toEqual([`${"33".repeat(32)}:2`]);
            // The caller needs the CLTV floor as a VALUE: recoverVtxos() sweeps
            // every recoverable output into one settlement with no CLTV
            // awareness, so recovering before this can fail the whole batch.
            // Parsing it back out of the message is not an interface.
            expect(needsRecovery.recoverableAfter).toBe(swapScript().options.refundLocktime);
        });

        it("refuses the WHOLE push when one output among live ones is swept", async () => {
            // Every input lands in one aggregate transaction, so a swept output
            // would take the live ones down with it. Refusing names the fix;
            // silently dropping it would report success over money that never
            // moved.
            const operator = fakeOperator();
            const mixed: LockupVtxo[] = [
                { ...VTXOS[0], recoverable: false },
                { txid: "44".repeat(32), vout: 1, value: 9_000, recoverable: true },
            ];
            await expect(
                pushRefundWithoutReceiver(operator, {
                    contract: swapScript(),
                    sender: SENDER,
                    vtxos: mixed,
                }),
            ).rejects.toThrow(LockupNeedsRecoveryError);
            expect(operator.submitted).toEqual([]);
        });

        it("still pushes when every output is live", async () => {
            const operator = fakeOperator();
            const live: LockupVtxo[] = VTXOS.map((v) => ({ ...v, recoverable: false }));
            await pushRefundWithoutReceiver(operator, {
                contract: swapScript(),
                sender: SENDER,
                vtxos: live,
            });
            expect(operator.submitted).toHaveLength(1);
        });
    });

    it("refuses to sign a checkpoint the server substituted", async () => {
        // The substitute is a REAL checkpoint for a different deposit at the
        // same script — so the sender key can sign it perfectly well, and only
        // matching it against the locally built set catches the swap. (A
        // malformed stand-in would prove nothing: signing would fail anyway.)
        const capture = fakeOperator();
        await pushRefundWithoutReceiver(capture, {
            contract: swapScript(),
            sender: SENDER,
            vtxos: [{ txid: "33".repeat(32), vout: 0, value: 7_000, recoverable: false }],
        });
        const foreignCheckpoint = capture.submitted[0].checkpoints[0];

        const operator = fakeOperator({ checkpointsFor: () => [foreignCheckpoint] });
        await expect(
            pushRefundWithoutReceiver(operator, {
                contract: swapScript(),
                sender: SENDER,
                vtxos: [VTXOS[0]],
            }),
        ).rejects.toThrow(/does not match any submitted checkpoint/);
        expect(operator.finalized).toHaveLength(0);
    });

    it("reports a malformed checkpointTapscript rather than failing deep in the builder", async () => {
        await expect(
            pushRefundWithoutReceiver(fakeOperator({ checkpointTapscript: "00" }), {
                contract: swapScript(),
                sender: SENDER,
                vtxos: VTXOS,
            }),
        ).rejects.toThrow(/checkpointTapscript/);
    });
});

describe("findLockupVtxos", () => {
    it("asks for the lockup script and returns every spendable output", async () => {
        const contract = swapScript();
        const indexer = fakeIndexer(VTXOS);
        expect(await findLockupVtxos(indexer, contract.pkScript)).toHaveLength(2);
        expect(indexer.scripts[0]).toEqual([hex.encode(contract.pkScript)]);
    });

    /** Filter-aware, unlike `fakeIndexer`: the two sets are disjoint here, which
     * is what makes a swept output visible or not. `isUnrolled` is the wire's,
     * not `LockupVtxo`'s — the point is that it never survives the mapping. */
    type IndexedVtxo = LockupVtxo & { isUnrolled?: boolean };

    const byFilterIndexer = (spendable: IndexedVtxo[], recoverable: IndexedVtxo[]): RefundIndexer =>
        ({
            getVtxos: async (opts?: { spendableOnly?: boolean; recoverableOnly?: boolean }) => ({
                vtxos: opts?.recoverableOnly ? recoverable : opts?.spendableOnly ? spendable : [],
            }),
        }) as unknown as RefundIndexer;

    it("finds a swept lockup, which a spendable-only read would report as nothing to refund", async () => {
        // A batch expiry sweeps the output out of the spendable set. It is
        // still the trader's money and still visible — so missing it would
        // claim a swap resolved while the funds sit at the script, and this
        // path exists precisely for swaps that sat long enough to get here.
        // Visible is NOT the same as refundable: a swept output must be
        // recovered before any offchain spend, which
        // `pushRefundWithoutReceiver` enforces rather than discovers.
        const contract = swapScript();
        const swept = { txid: "cc".repeat(32), vout: 1, value: 4_000, recoverable: false };
        const found = await findLockupVtxos(byFilterIndexer([], [swept]), contract.pkScript);
        expect(found).toEqual([{ ...swept, recoverable: true }]);
    });

    it("merges both sets and marks which outputs were swept", async () => {
        const contract = swapScript();
        const live = { txid: "aa".repeat(32), vout: 0, value: 1_000, recoverable: false };
        const swept = { txid: "bb".repeat(32), vout: 2, value: 2_000, recoverable: false };
        const found = await findLockupVtxos(byFilterIndexer([live], [swept]), contract.pkScript);
        expect(found).toEqual([
            { ...live, recoverable: false },
            { ...swept, recoverable: true },
        ]);
    });

    it("drops an unrolled output the indexer still lists as spendable", async () => {
        // arkd is not depended on to exclude a unilateral exit from
        // `spendableOnly`, and `LockupVtxo` carries no flag to pass one along —
        // so anything that reached the mapping would be indistinguishable from
        // the live output beside it and would be signed into a refund that no
        // offchain leaf can land. The live sibling proves the drop is the
        // output's own, not the whole response being discarded.
        const script = swapScript();
        const live = { txid: "ee".repeat(32), vout: 0, value: 3_000, recoverable: false };
        const exited = {
            txid: "ef".repeat(32),
            vout: 1,
            value: 6_000,
            recoverable: false,
            isUnrolled: true,
        };
        const found = await findLockupVtxos(byFilterIndexer([live, exited], []), script.pkScript);
        expect(found).toEqual([live]);
    });

    it("drops an unrolled output from the recoverable half too", async () => {
        // Both queries feed one loop, so the exclusion has to hold on the side
        // whose outputs are already un-spendable for a different reason.
        const script = swapScript();
        const swept = { txid: "f0".repeat(32), vout: 0, value: 2_500, recoverable: false };
        const exited = {
            txid: "f1".repeat(32),
            vout: 3,
            value: 9_000,
            recoverable: false,
            isUnrolled: true,
        };
        const found = await findLockupVtxos(byFilterIndexer([], [swept, exited]), script.pkScript);
        expect(found).toEqual([{ ...swept, recoverable: true }]);
    });

    it("counts an output appearing in both sets exactly once", async () => {
        // Disjoint today, but double-counting would add the same outpoint to
        // the refund's aggregate output twice and build a transaction that
        // cannot be signed.
        const contract = swapScript();
        const both = { txid: "dd".repeat(32), vout: 0, value: 7_000, recoverable: false };
        const found = await findLockupVtxos(byFilterIndexer([both], [both]), contract.pkScript);
        expect(found).toHaveLength(1);
        expect(found[0]!.recoverable).toBe(false);
    });
});

describe("awaitRfqResolution", () => {
    it("resolves once the swap reaches a terminal state", async () => {
        const transport = fakeTransport([null, "quoted", "settled"]);
        const status = await awaitRfqResolution(transport, RFQ_ID, { pollMs: 1 });
        expect(status.state).toBe("settled");
    });

    it("times out with the status_timeout reason", async () => {
        await expect(
            awaitRfqResolution(fakeTransport(["quoted"]), RFQ_ID, { pollMs: 1, deadline: 1 }),
        ).rejects.toMatchObject({ reason: "status_timeout" });
    });

    it("agrees with the exported terminal-state vocabulary", () => {
        expect(isRfqTerminal("settled")).toBe(true);
        expect(isRfqTerminal("refunded")).toBe(true);
        expect(isRfqTerminal("quoted")).toBe(false);
        // resolved is a strict subset of terminal
        for (const state of RFQ_RESOLVED_STATES) expect(isRfqTerminal(state)).toBe(true);
    });
});

describe("refundIfUnresolved", () => {
    const baseInput = () => ({
        rfqId: RFQ_ID,
        contract: swapScript(),
        sender: SENDER,
        refundLocktime: REFUND_LOCKTIME,
        pollMs: 1,
    });

    it("stops without refunding when the solver resolved it", async () => {
        for (const state of RFQ_RESOLVED_STATES) {
            const operator = fakeOperator();
            const result = await refundIfUnresolved(
                fakeTransport([state]),
                operator,
                fakeIndexer(VTXOS),
                { ...baseInput(), now: () => REFUND_LOCKTIME + 1 },
            );
            expect(result.outcome).toBe("resolved");
            // even though the deadline had passed and the lockup looked funded
            expect(operator.submitted).toHaveLength(0);
        }
    });

    it("still refunds a swap whose negotiation died — refused, expired or stuck", async () => {
        // These are terminal states, but a trader can be holding a funded
        // lockup in every one of them; treating "terminal" as "done" would
        // walk away from the money.
        for (const state of ["refused", "expired", "stuck"]) {
            const operator = fakeOperator();
            const result = await refundIfUnresolved(
                fakeTransport([state]),
                operator,
                fakeIndexer(VTXOS),
                { ...baseInput(), now: () => REFUND_LOCKTIME + 1 },
            );
            expect(result.outcome).toBe("refunded");
            expect(operator.submitted).toHaveLength(1);
        }
    });

    it("reports a swept lockup instead of retrying a push that cannot succeed", async () => {
        // Unlike a median-time-past refusal, waiting fixes nothing here: the
        // batch is gone, so the CLTV refund is not "not yet" but "not this
        // way". Burning the whole `attemptDeadline` window on it and then
        // rethrowing would waste the time the caller needed to RECOVER the
        // outputs and finish the refund properly.
        const operator = fakeOperator();
        const swept = { txid: "55".repeat(32), vout: 3, value: 8_000 };
        const indexer = {
            getVtxos: async (opts?: { spendableOnly?: boolean; recoverableOnly?: boolean }) => ({
                vtxos: opts?.recoverableOnly ? [swept] : [],
            }),
        } as unknown as RefundIndexer;

        const result = await refundIfUnresolved(fakeTransport(["quoted"]), operator, indexer, {
            ...baseInput(),
            now: () => REFUND_LOCKTIME + 1,
        });

        expect(result.outcome).toBe("needs_recovery");
        if (result.outcome === "needs_recovery") {
            expect(result.outpoints).toEqual([`${"55".repeat(32)}:3`]);
            expect(result.vtxos).toEqual([{ ...swept, recoverable: true }]);
        }
        expect(operator.submitted).toEqual([]);
    });

    it("waits while the refund window is shut, then pushes once it opens", async () => {
        const operator = fakeOperator();
        let clock = REFUND_LOCKTIME - 3;
        const result = await refundIfUnresolved(
            fakeTransport(["quoted"]),
            operator,
            fakeIndexer(VTXOS),
            { ...baseInput(), now: () => clock++ },
        );
        expect(result.outcome).toBe("refunded");
        if (result.outcome === "refunded") expect(result.amount).toBe(100_000);
        expect(operator.submitted).toHaveLength(1);
    });

    it("retries a push refused while median-time-past lags, then succeeds", async () => {
        let attempts = 0;
        const operator = fakeOperator({
            failSubmit: () => (++attempts <= 2 ? new Error("FORFEIT_CLOSURE_LOCKED") : undefined),
        });
        const result = await refundIfUnresolved(
            fakeTransport(["quoted"]),
            operator,
            fakeIndexer(VTXOS),
            { ...baseInput(), now: () => REFUND_LOCKTIME + 1 },
        );
        expect(result.outcome).toBe("refunded");
        expect(attempts).toBe(3);
    });

    it("rethrows the server's refusal once the attempt window closes", async () => {
        const operator = fakeOperator({ failSubmit: () => new Error("FORFEIT_CLOSURE_LOCKED") });
        await expect(
            refundIfUnresolved(fakeTransport(["quoted"]), operator, fakeIndexer(VTXOS), {
                ...baseInput(),
                now: () => REFUND_LOCKTIME + 1,
                attemptDeadline: REFUND_LOCKTIME,
            }),
        ).rejects.toThrow(/FORFEIT_CLOSURE_LOCKED/);
    });

    it("reports nothing to refund when the lockup's only output was unrolled", async () => {
        // The output is unspent, but onchain behind its CSV: no offchain leaf
        // reaches it. Pushing anyway would fail every retry until
        // `attemptDeadline` and then rethrow — burning the window on a spend
        // that was never going to land.
        const operator = fakeOperator();
        let pushes = 0;
        const watched = {
            ...operator,
            getInfo: async () => {
                pushes += 1;
                return operator.getInfo();
            },
        } as unknown as FakeOperator;
        const exited = { txid: "66".repeat(32), vout: 0, value: 8_000, isUnrolled: true };
        const indexer = {
            getVtxos: async (opts?: { spendableOnly?: boolean }) => ({
                vtxos: opts?.spendableOnly ? [exited] : [],
            }),
        } as unknown as RefundIndexer;

        const result = await refundIfUnresolved(fakeTransport(["quoted"]), watched, indexer, {
            ...baseInput(),
            now: () => REFUND_LOCKTIME + 1,
        });

        expect(result.outcome).toBe("nothing_to_refund");
        // The outcome alone would pass while the doomed push still went out.
        expect(pushes).toBe(0);
        expect(operator.submitted).toEqual([]);
    });

    it("reports an empty lockup instead of failing", async () => {
        const operator = fakeOperator();
        const result = await refundIfUnresolved(
            fakeTransport(["stuck"]),
            operator,
            fakeIndexer([]),
            {
                ...baseInput(),
                now: () => REFUND_LOCKTIME + 1,
            },
        );
        expect(result.outcome).toBe("nothing_to_refund");
        expect(operator.submitted).toHaveLength(0);
    });
});

describe("readLockupFate", () => {
    const PREIMAGE = new Uint8Array(32).fill(9);
    const PAYMENT_HASH = hex.encode(sha256(PREIMAGE));
    const SWAP_PK_SCRIPT = p2tr(key(21));
    const OUT_A = { txid: "b2".repeat(32), vout: 0 };
    const OUT_B = { txid: "b3".repeat(32), vout: 1 };

    /** A checkpoint spending one lockup output, as the indexer hands it back. */
    const spendOf = (
        out: { txid: string; vout: number },
        witness?: Uint8Array[],
    ): { txid: string; psbt: string } => {
        const tx = new Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });
        tx.addInput({ txid: out.txid, index: out.vout });
        tx.addOutput({ script: REFUND_PK_SCRIPT, amount: 1_000n });
        if (witness) tx.updateInput(0, { finalScriptWitness: witness });
        return { txid: tx.id, psbt: base64.encode(tx.toPSBT()) };
    };

    interface FateVtxo {
        txid: string;
        vout: number;
        spentBy: string;
        isSpent?: boolean;
        settledBy?: string;
        isUnrolled?: boolean;
        arkTxId?: string;
    }

    const fateIndexer = (
        vtxos: FateVtxo[],
        txs: { txid: string; psbt: string }[] = [],
    ): LockupSpendIndexer =>
        ({
            async getVtxos() {
                return { vtxos };
            },
            async getVirtualTxs(txids: string[]) {
                const known = new Map(txs.map((t) => [t.txid, t.psbt]));
                return { txs: txids.map((id) => known.get(id)).filter((psbt) => !!psbt) };
            },
        }) as unknown as LockupSpendIndexer;

    const read = (indexer: LockupSpendIndexer) =>
        readLockupFate(indexer, { swapPkScript: SWAP_PK_SCRIPT, paymentHash: PAYMENT_HASH });

    it("names every checkpoint that spent a multi-output lockup, and the ark tx each rode", async () => {
        const first = spendOf(OUT_A);
        const second = spendOf(OUT_B);
        const fate = await read(
            fateIndexer(
                [
                    { ...OUT_A, spentBy: first.txid, arkTxId: "c1".repeat(32) },
                    { ...OUT_B, spentBy: second.txid, arkTxId: "c2".repeat(32) },
                ],
                [first, second],
            ),
        );
        expect(fate).toEqual({
            fate: "returned",
            spends: [
                { checkpointTxid: first.txid, txid: "c1".repeat(32) },
                { checkpointTxid: second.txid, txid: "c2".repeat(32) },
            ],
        });
    });

    it("keeps each output's own ark tx when only one of them has it", async () => {
        // The shape a single hoisted `txid` would get wrong: two outputs,
        // one named, one not.
        const first = spendOf(OUT_A);
        const second = spendOf(OUT_B);
        const fate = await read(
            fateIndexer(
                [
                    { ...OUT_A, spentBy: first.txid },
                    { ...OUT_B, spentBy: second.txid, arkTxId: "c4".repeat(32) },
                ],
                [first, second],
            ),
        );
        expect(fate).toEqual({
            fate: "returned",
            spends: [
                { checkpointTxid: first.txid, txid: undefined },
                { checkpointTxid: second.txid, txid: "c4".repeat(32) },
            ],
        });
    });

    it("still names the checkpoint when the indexer omitted the ark tx", async () => {
        const spend = spendOf(OUT_A);
        const fate = await read(fateIndexer([{ ...OUT_A, spentBy: spend.txid }], [spend]));
        expect(fate).toEqual({
            fate: "returned",
            spends: [{ checkpointTxid: spend.txid, txid: undefined }],
        });
    });

    it("names the spend that carried the preimage too", async () => {
        const spend = spendOf(OUT_A, [PREIMAGE]);
        const fate = await read(
            fateIndexer([{ ...OUT_A, spentBy: spend.txid, arkTxId: "c3".repeat(32) }], [spend]),
        );
        expect(fate).toEqual({
            fate: "claimed",
            preimage: PREIMAGE,
            spends: [{ checkpointTxid: spend.txid, txid: "c3".repeat(32) }],
        });
    });

    it("claims no spend when the lockup is still open", async () => {
        expect(await read(fateIndexer([{ ...OUT_A, spentBy: "" }]))).toEqual({ fate: "open" });
    });

    it("reports an unrolled output as exited rather than open", async () => {
        // Unspent, but sitting onchain under the VHTLC script: neither the
        // claim nor any refund leaf can be spent offchain against it. Reading
        // it as a swap that is merely still running would leave a caller
        // waiting on a resolution nobody is able to produce.
        const fate = await read(fateIndexer([{ ...OUT_A, spentBy: "", isUnrolled: true }]));
        expect(fate).toEqual({ fate: "exited", outpoints: [OUT_A] });
    });

    it("finds the exit wherever the indexer happens to list it", async () => {
        // Scanned over the whole set, not in outpoint order: an in-loop test
        // would hit the plain unspent output first and answer `open`, making
        // the fate depend on the order the indexer returned rows in.
        const fate = await read(
            fateIndexer([
                { ...OUT_A, spentBy: "" },
                { ...OUT_B, spentBy: "", isUnrolled: true },
            ]),
        );
        expect(fate).toEqual({ fate: "exited", outpoints: [OUT_B] });
    });

    it("leaves an exited output that was then spent on the ordinary spent path", async () => {
        // `completeUnroll` already moved it, so the exit is history and the
        // witness is what says how the swap ended. Reporting `exited` here
        // would throw away hash-verified proof of a claim.
        const spend = spendOf(OUT_A, [PREIMAGE]);
        const fate = await read(
            fateIndexer([{ ...OUT_A, spentBy: spend.txid, isUnrolled: true }], [spend]),
        );
        expect(fate).toEqual({
            fate: "claimed",
            preimage: PREIMAGE,
            spends: [{ checkpointTxid: spend.txid, arkTxid: undefined }],
        });
    });

    it("reads a settled-only output as spent, not as money still sitting there", async () => {
        // The third spend fact, carried by the SDK's `hasTerminalSpend` and by
        // nothing else here: `settledBy` with no `spentBy` and no `isSpent`
        // means the output was renewed away, and a `spentBy`-only test would
        // call the empty lockup `open`.
        const settled = { ...OUT_A, spentBy: "", settledBy: "e1".repeat(32) };
        expect(await read(fateIndexer([settled]))).toEqual({ fate: "unknown" });
    });

    it("claims no spend when a spend was not named, or could not be produced", async () => {
        const spend = spendOf(OUT_A);
        // spent, but by nothing the indexer names
        expect(await read(fateIndexer([{ ...OUT_A, spentBy: "", isSpent: true }]))).toEqual({
            fate: "unknown",
        });
        // named, but the indexer cannot produce it
        expect(await read(fateIndexer([{ ...OUT_A, spentBy: spend.txid }]))).toEqual({
            fate: "unknown",
        });
    });
});
