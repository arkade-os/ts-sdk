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
import { CSVMultisigTapscript, Transaction } from "@arkade-os/sdk";

import { lightningSendVtxoScript, type RfqStatus, type RfqTransport } from "../src/rfq";
import {
    RFQ_RESOLVED_STATES,
    awaitRfqResolution,
    findLockupVtxos,
    isRfqTerminal,
    pushRefundWithoutReceiver,
    refundIfUnresolved,
    type LockupVtxo,
    type RefundArkProvider,
    type RefundIndexer,
} from "../src/refund";

const priv = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const key = (fill: number): Uint8Array => schnorr.getPublicKey(priv(fill));
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

const RFQ_ID = "a1".repeat(32);
const REFUND_LOCKTIME = 1_800_000_000;
const SENDER_PRIVATE_KEY = priv(13);
const REFUND_PK_SCRIPT = p2tr(key(5));

/** The same golden participant set rfq.test.ts pins the script bytes against. */
const swapScript = () =>
    lightningSendVtxoScript({
        solverPubkey: key(1),
        serverPubkey: key(3),
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
    { txid: "11".repeat(32), vout: 0, value: 60_000 },
    { txid: "22".repeat(32), vout: 1, value: 40_000 },
];

/** A scripted arkd: echoes back the checkpoints it was handed (as a real one
 * does, plus its own signature) and reports the ark txid it was submitted.
 * Typed against the production contract so a change to RefundArkProvider
 * breaks the fake at compile time. */
type FakeArk = RefundArkProvider & {
    submitted: { arkTx: string; checkpoints: string[] }[];
    finalized: { arkTxid: string; checkpoints: string[] }[];
};

const fakeArk = (
    over: {
        checkpointTapscript?: string;
        checkpointsFor?: (submitted: string[]) => string[];
        failSubmit?: () => Error | undefined;
    } = {},
): FakeArk => {
    const submitted: { arkTx: string; checkpoints: string[] }[] = [];
    const finalized: { arkTxid: string; checkpoints: string[] }[] = [];
    return {
        submitted,
        finalized,
        getInfo: async () => ({
            checkpointTapscript: over.checkpointTapscript ?? CHECKPOINT_TAPSCRIPT,
        }),
        submitTx: async (arkTx: string, checkpoints: string[]) => {
            const failure = over.failSubmit?.();
            if (failure) throw failure;
            submitted.push({ arkTx, checkpoints });
            return {
                arkTxid: Transaction.fromPSBT(base64.decode(arkTx)).id,
                finalArkTx: arkTx,
                signedCheckpointTxs: over.checkpointsFor
                    ? over.checkpointsFor(checkpoints)
                    : checkpoints,
            };
        },
        finalizeTx: async (arkTxid: string, checkpoints: string[]) => {
            finalized.push({ arkTxid, checkpoints });
        },
    } as unknown as FakeArk;
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
        const script = swapScript();
        const ark = fakeArk();
        await pushRefundWithoutReceiver(ark, {
            script,
            senderPrivateKey: SENDER_PRIVATE_KEY,
            vtxos: VTXOS,
        });

        expect(ark.submitted).toHaveLength(1);
        // Not `refund` (needs the solver) and not a unilateral leaf (needs an
        // exit): the CLTV leaf is the only one a stranded trader can drive.
        expect(spentLeafOf(ark.submitted[0].arkTx)).toBe(script.refundWithoutReceiverScript);

        // SingleKey.sign() swallows "No inputs signed", so an unsigned tx would
        // otherwise sail through to submitTx and be rejected only server-side.
        const tx = Transaction.fromPSBT(base64.decode(ark.submitted[0].arkTx));
        for (let i = 0; i < tx.inputsLength; i++) {
            expect(tx.getInput(i).tapScriptSig?.length).toBeGreaterThan(0);
        }
    });

    it("carries the CLTV locktime and an nLockTime-enabling sequence", async () => {
        const ark = fakeArk();
        await pushRefundWithoutReceiver(ark, {
            script: swapScript(),
            senderPrivateKey: SENDER_PRIVATE_KEY,
            vtxos: VTXOS,
        });

        // Without both of these the spend is simply not consensus-valid — and
        // nothing in this package restates the locktime, so this is the check
        // that the CLTV leaf (not a timelock-free one) was handed to the builder.
        const tx = Transaction.fromPSBT(base64.decode(ark.submitted[0].arkTx));
        expect(tx.lockTime).toBe(REFUND_LOCKTIME);
        expect(tx.getInput(0).sequence).toBeLessThan(0xffffffff);
    });

    it("returns every funded output to the contract's own committed destination", async () => {
        const ark = fakeArk();
        const result = await pushRefundWithoutReceiver(ark, {
            script: swapScript(),
            senderPrivateKey: SENDER_PRIVATE_KEY,
            vtxos: VTXOS,
        });

        // Both deposits, aggregated: refunding vtxos[0] alone would strand the
        // rest at a script whose other refund paths are all longer.
        expect(result.amount).toBe(100_000);
        const tx = Transaction.fromPSBT(base64.decode(ark.submitted[0].arkTx));
        expect(tx.inputsLength).toBe(2);
        expect(hex.encode(tx.getOutput(0).script!)).toBe(hex.encode(REFUND_PK_SCRIPT));
        expect(tx.getOutput(0).amount).toBe(BigInt(100_000));
        expect(ark.finalized).toHaveLength(1);
        expect(ark.finalized[0].arkTxid).toBe(result.arkTxid);
    });

    it("honours an explicit destination override", async () => {
        const ark = fakeArk();
        const elsewhere = p2tr(key(21));
        await pushRefundWithoutReceiver(ark, {
            script: swapScript(),
            senderPrivateKey: SENDER_PRIVATE_KEY,
            vtxos: VTXOS,
            refundPkScript: elsewhere,
        });
        const tx = Transaction.fromPSBT(base64.decode(ark.submitted[0].arkTx));
        expect(hex.encode(tx.getOutput(0).script!)).toBe(hex.encode(elsewhere));
    });

    it("refuses an empty lockup instead of pushing an inputless transaction", async () => {
        await expect(
            pushRefundWithoutReceiver(fakeArk(), {
                script: swapScript(),
                senderPrivateKey: SENDER_PRIVATE_KEY,
                vtxos: [],
            }),
        ).rejects.toThrow(/nothing to refund/);
    });

    it("refuses to sign a checkpoint the server substituted", async () => {
        // The substitute is a REAL checkpoint for a different deposit at the
        // same script — so the sender key can sign it perfectly well, and only
        // matching it against the locally built set catches the swap. (A
        // malformed stand-in would prove nothing: signing would fail anyway.)
        const capture = fakeArk();
        await pushRefundWithoutReceiver(capture, {
            script: swapScript(),
            senderPrivateKey: SENDER_PRIVATE_KEY,
            vtxos: [{ txid: "33".repeat(32), vout: 0, value: 7_000 }],
        });
        const foreignCheckpoint = capture.submitted[0].checkpoints[0];

        const ark = fakeArk({ checkpointsFor: () => [foreignCheckpoint] });
        await expect(
            pushRefundWithoutReceiver(ark, {
                script: swapScript(),
                senderPrivateKey: SENDER_PRIVATE_KEY,
                vtxos: [VTXOS[0]],
            }),
        ).rejects.toThrow(/does not match any submitted checkpoint/);
        expect(ark.finalized).toHaveLength(0);
    });

    it("reports a malformed checkpointTapscript rather than failing deep in the builder", async () => {
        await expect(
            pushRefundWithoutReceiver(fakeArk({ checkpointTapscript: "00" }), {
                script: swapScript(),
                senderPrivateKey: SENDER_PRIVATE_KEY,
                vtxos: VTXOS,
            }),
        ).rejects.toThrow(/checkpointTapscript/);
    });
});

describe("findLockupVtxos", () => {
    it("asks for the lockup script and returns every spendable output", async () => {
        const script = swapScript();
        const indexer = fakeIndexer(VTXOS);
        expect(await findLockupVtxos(indexer, script.pkScript)).toHaveLength(2);
        expect(indexer.scripts[0]).toEqual([hex.encode(script.pkScript)]);
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
        script: swapScript(),
        senderPrivateKey: SENDER_PRIVATE_KEY,
        refundLocktime: REFUND_LOCKTIME,
        pollMs: 1,
    });

    it("stops without refunding when the solver resolved it", async () => {
        for (const state of RFQ_RESOLVED_STATES) {
            const ark = fakeArk();
            const result = await refundIfUnresolved(
                fakeTransport([state]),
                ark,
                fakeIndexer(VTXOS),
                { ...baseInput(), now: () => REFUND_LOCKTIME + 1 },
            );
            expect(result.outcome).toBe("resolved");
            // even though the deadline had passed and the lockup looked funded
            expect(ark.submitted).toHaveLength(0);
        }
    });

    it("still refunds a swap whose negotiation died — refused, expired or stuck", async () => {
        // These are terminal states, but a trader can be holding a funded
        // lockup in every one of them; treating "terminal" as "done" would
        // walk away from the money.
        for (const state of ["refused", "expired", "stuck"]) {
            const ark = fakeArk();
            const result = await refundIfUnresolved(
                fakeTransport([state]),
                ark,
                fakeIndexer(VTXOS),
                { ...baseInput(), now: () => REFUND_LOCKTIME + 1 },
            );
            expect(result.outcome).toBe("refunded");
            expect(ark.submitted).toHaveLength(1);
        }
    });

    it("waits while the refund window is shut, then pushes once it opens", async () => {
        const ark = fakeArk();
        let clock = REFUND_LOCKTIME - 3;
        const result = await refundIfUnresolved(
            fakeTransport(["quoted"]),
            ark,
            fakeIndexer(VTXOS),
            { ...baseInput(), now: () => clock++ },
        );
        expect(result.outcome).toBe("refunded");
        if (result.outcome === "refunded") expect(result.amount).toBe(100_000);
        expect(ark.submitted).toHaveLength(1);
    });

    it("retries a push refused while median-time-past lags, then succeeds", async () => {
        let attempts = 0;
        const ark = fakeArk({
            failSubmit: () => (++attempts <= 2 ? new Error("FORFEIT_CLOSURE_LOCKED") : undefined),
        });
        const result = await refundIfUnresolved(
            fakeTransport(["quoted"]),
            ark,
            fakeIndexer(VTXOS),
            { ...baseInput(), now: () => REFUND_LOCKTIME + 1 },
        );
        expect(result.outcome).toBe("refunded");
        expect(attempts).toBe(3);
    });

    it("rethrows the server's refusal once the attempt window closes", async () => {
        const ark = fakeArk({ failSubmit: () => new Error("FORFEIT_CLOSURE_LOCKED") });
        await expect(
            refundIfUnresolved(fakeTransport(["quoted"]), ark, fakeIndexer(VTXOS), {
                ...baseInput(),
                now: () => REFUND_LOCKTIME + 1,
                attemptDeadline: REFUND_LOCKTIME,
            }),
        ).rejects.toThrow(/FORFEIT_CLOSURE_LOCKED/);
    });

    it("reports an empty lockup instead of failing", async () => {
        const ark = fakeArk();
        const result = await refundIfUnresolved(fakeTransport(["stuck"]), ark, fakeIndexer([]), {
            ...baseInput(),
            now: () => REFUND_LOCKTIME + 1,
        });
        expect(result.outcome).toBe("nothing_to_refund");
        expect(ark.submitted).toHaveLength(0);
    });
});
