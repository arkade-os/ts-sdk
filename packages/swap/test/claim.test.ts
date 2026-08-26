/**
 * The receive-corridor claim: the trader spends the solver-funded lockup with
 * its own preimage and receiver key.
 *
 * The assertions that matter: the spend really uses the `claim` leaf (not
 * some other leaf that happens to be spendable), the preimage is attached
 * AFTER signing on both the ark transaction and every checkpoint (the order
 * the server enforces), and a preimage that does not open the script is
 * caught before anything is signed.
 */
import { describe, expect, it } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
    CSVMultisigTapscript,
    ConditionWitness,
    SingleKey,
    Transaction,
    getArkPsbtFields,
    type ArkProvider,
} from "@arkade-os/sdk";

import { lightningReceiveContract } from "../src/rfq";
import {
    LockupAmountMismatchError,
    awaitLockupFunding,
    claimReceiveLockup,
    pushClaim,
} from "../src/claim";
import { LockupNeedsRecoveryError, type LockupVtxo, type RefundIndexer } from "../src/refund";

const priv = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const key = (fill: number): Uint8Array => schnorr.getPublicKey(priv(fill));
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

const PREIMAGE = new Uint8Array(32).fill(7);
const REFUND_LOCKTIME = 1_800_000_000;
/** The trader's receiver key as the signer the claim path takes. */
const RECEIVER = SingleKey.fromPrivateKey(priv(13));
const DESTINATION_PK_SCRIPT = p2tr(key(21));

/** The same role-inverted participant set rfqReceive.test.ts pins against the
 * reference solver: solver = key(1) (VHTLC sender), trader = key(13)
 * (receiver), server = key(3), emulator = key(9). */
const swapScript = () =>
    lightningReceiveContract({
        solverPubkey: key(1),
        refundLocktime: REFUND_LOCKTIME,
        operatorPubkey: key(3),
        paymentHash: hex.encode(sha256(PREIMAGE)),
        claimDelay: 4096,
        emulatorPubkey: key(9),
        solverRefundPkScript: p2tr(key(8)),
        payoutPubkey: key(13),
        payoutPkScript: p2tr(key(5)),
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
/** The quote's `to_amount`, captured at request time. */
const EXPECTED_AMOUNT = 100_000;

/** A scripted arkd, same contract as refund.test.ts's. */
type FakeArk = ArkProvider & {
    submitted: { tx: string; checkpoints: string[] }[];
    finalized: { txid: string; checkpoints: string[] }[];
};

/** The Ark server's own key — key(3) in the covenant above. */
const SERVER_SIGNER = SingleKey.fromPrivateKey(priv(3));

const operatorCosign = async (psbt: string): Promise<string> =>
    base64.encode((await SERVER_SIGNER.sign(Transaction.fromPSBT(base64.decode(psbt)))).toPSBT());

/** A scripted arkd that countersigns like the real one — `pushClaim` verifies
 * those signatures before finalizing, so a mute fake would prove nothing. */
const fakeOperator = (
    over: {
        checkpointsFor?: (submitted: string[]) => string[];
        /** Answer without countersigning, as a server that never signed. */
        cosign?: boolean;
        finalTx?: (signed: string) => string | undefined;
    } = {},
): FakeArk => {
    const submitted: { tx: string; checkpoints: string[] }[] = [];
    const finalized: { txid: string; checkpoints: string[] }[] = [];
    const cosign = over.cosign ?? true;
    return {
        submitted,
        finalized,
        getInfo: async () => ({ checkpointTapscript: CHECKPOINT_TAPSCRIPT }),
        submitTx: async (tx: string, checkpoints: string[]) => {
            submitted.push({ tx, checkpoints });
            const answered = over.checkpointsFor ? over.checkpointsFor(checkpoints) : checkpoints;
            const finalTx = cosign ? await operatorCosign(tx) : tx;
            return {
                arkTxid: Transaction.fromPSBT(base64.decode(tx)).id,
                finalArkTx: over.finalTx ? over.finalTx(finalTx) : finalTx,
                signedCheckpointTxs: cosign
                    ? await Promise.all(answered.map(operatorCosign))
                    : answered,
            };
        },
        finalizeTx: async (txid: string, checkpoints: string[]) => {
            finalized.push({ txid, checkpoints });
        },
    } as unknown as FakeArk;
};

/** The leaf script the ark tx's single input actually spends. */
const spentLeafOf = (psbt: string): string => {
    const tx = Transaction.fromPSBT(base64.decode(psbt));
    const leaf = tx.getInput(0).tapLeafScript![0][1];
    return hex.encode(leaf.subarray(0, -1));
};

describe("pushClaim", () => {
    it("spends the claim leaf, signed by the trader's receiver key, preimage attached", async () => {
        const contract = swapScript();
        const operator = fakeOperator();
        const result = await pushClaim(operator, {
            contract: contract,
            receiver: RECEIVER,
            preimage: PREIMAGE,
            vtxos: VTXOS,
            destinationPkScript: DESTINATION_PK_SCRIPT,
            expectedAmount: EXPECTED_AMOUNT,
        });

        expect(operator.submitted).toHaveLength(1);
        // The exact leaf bytes, control block stripped — the claim leaf and no
        // other.
        expect(spentLeafOf(operator.submitted[0]!.tx)).toBe(contract.claimScript);
        // One aggregate output to the trader's destination, for the full amount.
        const tx = Transaction.fromPSBT(base64.decode(operator.submitted[0]!.tx));
        expect(tx.outputsLength).toBeGreaterThan(0);
        expect(hex.encode(tx.getOutput(0)!.script!)).toBe(hex.encode(DESTINATION_PK_SCRIPT));
        expect(tx.getOutput(0)!.amount).toBe(BigInt(100_000));
        expect(result.amount).toBe(100_000);
        // The preimage rides the condition-witness field on the ark
        // transaction, attached after signing…
        const conditionFields = getArkPsbtFields(tx, 0, ConditionWitness);
        expect(conditionFields).toHaveLength(1);
        expect(hex.encode(conditionFields[0]![0]!)).toBe(hex.encode(PREIMAGE));
        // …and finalize got the checkpoints back signed.
        expect(operator.finalized).toHaveLength(1);
        expect(operator.finalized[0]!.txid).toBe(result.txid);
    });

    it("attaches the preimage only after signing — the server's INVALID_SIGNATURE ordering", async () => {
        // A signer that records whether the ConditionWitness field was already
        // present AT SIGN TIME: it must not be, or the signature covers a
        // different payload than the one submitted.
        const contract = swapScript();
        let fieldPresentAtSignTime = false;
        const probe = {
            ...RECEIVER,
            sign: async (tx: InstanceType<typeof Transaction>, inputIndexes?: number[]) => {
                const indexes =
                    inputIndexes ?? Array.from({ length: tx.inputsLength }, (_, i) => i);
                for (const index of indexes) {
                    fieldPresentAtSignTime ||=
                        getArkPsbtFields(tx, index, ConditionWitness).length > 0;
                }
                return RECEIVER.sign(tx, inputIndexes);
            },
        };
        await pushClaim(fakeOperator(), {
            contract: contract,
            receiver: probe,
            preimage: PREIMAGE,
            vtxos: VTXOS,
            destinationPkScript: DESTINATION_PK_SCRIPT,
            expectedAmount: EXPECTED_AMOUNT,
        });
        expect(fieldPresentAtSignTime).toBe(false);
    });

    it("refuses a preimage that cannot open the script, before signing anything", async () => {
        const operator = fakeOperator();
        await expect(
            pushClaim(operator, {
                contract: swapScript(),
                receiver: RECEIVER,
                preimage: new Uint8Array(32).fill(8),
                vtxos: VTXOS,
                destinationPkScript: DESTINATION_PK_SCRIPT,
                expectedAmount: EXPECTED_AMOUNT,
            }),
        ).rejects.toThrow(/does not match/);
        expect(operator.submitted).toHaveLength(0);
    });

    it("refuses a swept output rather than submitting a spend that cannot succeed", async () => {
        await expect(
            pushClaim(fakeOperator(), {
                contract: swapScript(),
                receiver: RECEIVER,
                preimage: PREIMAGE,
                vtxos: [{ txid: "33".repeat(32), vout: 0, value: 5_000, recoverable: true }],
                destinationPkScript: DESTINATION_PK_SCRIPT,
                expectedAmount: EXPECTED_AMOUNT,
            }),
        ).rejects.toThrow(LockupNeedsRecoveryError);
    });

    // The dust-funding attack: the script is the one we derived ourselves, so
    // only the value says anything is wrong. Claiming anyway publishes `P` and
    // lets the solver settle the payer's HTLC in full.
    it("refuses a lockup funded below the agreed amount, with nothing signed or submitted", async () => {
        const operator = fakeOperator();
        await expect(
            pushClaim(operator, {
                contract: swapScript(),
                receiver: RECEIVER,
                preimage: PREIMAGE,
                vtxos: [{ txid: "44".repeat(32), vout: 0, value: 330, recoverable: false }],
                destinationPkScript: DESTINATION_PK_SCRIPT,
                expectedAmount: EXPECTED_AMOUNT,
            }),
        ).rejects.toThrow(LockupAmountMismatchError);
        // `P` reaches the Ark server at submit, so this is the whole guarantee.
        expect(operator.submitted).toHaveLength(0);
    });

    // NaN and undefined fail every comparison, so an unchecked one does not
    // fail the gate — it deletes it, and the dust claim above goes through.
    it.each([
        ["NaN", Number.NaN],
        ["missing from an older record", undefined as unknown as number],
    ])("refuses an expectedAmount that is %s instead of comparing against it", async (_, bad) => {
        const operator = fakeOperator();
        await expect(
            pushClaim(operator, {
                contract: swapScript(),
                receiver: RECEIVER,
                preimage: PREIMAGE,
                vtxos: [{ txid: "44".repeat(32), vout: 0, value: 330, recoverable: false }],
                destinationPkScript: DESTINATION_PK_SCRIPT,
                expectedAmount: bad,
            }),
        ).rejects.toMatchObject({ reason: "invalid_gate_input" });
        expect(operator.submitted).toHaveLength(0);
    });

    it("refuses a lockup whose indexed value is not a number", async () => {
        const operator = fakeOperator();
        await expect(
            pushClaim(operator, {
                contract: swapScript(),
                receiver: RECEIVER,
                preimage: PREIMAGE,
                vtxos: [{ txid: "44".repeat(32), vout: 0, value: Number.NaN, recoverable: false }],
                destinationPkScript: DESTINATION_PK_SCRIPT,
                expectedAmount: EXPECTED_AMOUNT,
            }),
        ).rejects.toMatchObject({ reason: "lockup_malformed" });
        expect(operator.submitted).toHaveLength(0);
    });

    it("sums across outputs and tolerates overfunding", async () => {
        // VTXOS is 60_000 + 40_000: neither output covers the amount alone.
        const split = fakeOperator();
        await pushClaim(split, {
            contract: swapScript(),
            receiver: RECEIVER,
            preimage: PREIMAGE,
            vtxos: VTXOS,
            destinationPkScript: DESTINATION_PK_SCRIPT,
            expectedAmount: EXPECTED_AMOUNT,
        });
        expect(split.submitted).toHaveLength(1);

        const over = fakeOperator();
        const result = await pushClaim(over, {
            contract: swapScript(),
            receiver: RECEIVER,
            preimage: PREIMAGE,
            vtxos: VTXOS,
            destinationPkScript: DESTINATION_PK_SCRIPT,
            expectedAmount: EXPECTED_AMOUNT - 1,
        });
        expect(result.amount).toBe(100_000);
    });

    it("claims the remainder of a partially-claimed lockup regardless of the amount", async () => {
        const operator = fakeOperator();
        const result = await pushClaim(operator, {
            contract: swapScript(),
            receiver: RECEIVER,
            preimage: PREIMAGE,
            vtxos: [{ txid: "55".repeat(32), vout: 0, value: 1_000, recoverable: false }],
            destinationPkScript: DESTINATION_PK_SCRIPT,
            expectedAmount: EXPECTED_AMOUNT,
            partiallyClaimed: true,
        });
        expect(result.amount).toBe(1_000);

        // Including one whose record predates the field: `P` is already
        // public, so refusing here would strand the remainder for nothing.
        const older = await pushClaim(fakeOperator(), {
            contract: swapScript(),
            receiver: RECEIVER,
            preimage: PREIMAGE,
            vtxos: [{ txid: "55".repeat(32), vout: 0, value: 1_000, recoverable: false }],
            destinationPkScript: DESTINATION_PK_SCRIPT,
            expectedAmount: undefined as unknown as number,
            partiallyClaimed: true,
        });
        expect(older.amount).toBe(1_000);
    });

    it("refuses a swept output before the amount is even considered", async () => {
        await expect(
            pushClaim(fakeOperator(), {
                contract: swapScript(),
                receiver: RECEIVER,
                preimage: PREIMAGE,
                vtxos: [{ txid: "33".repeat(32), vout: 0, value: 330, recoverable: true }],
                destinationPkScript: DESTINATION_PK_SCRIPT,
                expectedAmount: EXPECTED_AMOUNT,
            }),
        ).rejects.toThrow(LockupNeedsRecoveryError);
    });

    // Not a guard on `P` — that reached the server at submit — but on being
    // told the claim landed when nothing was co-signed.
    it("refuses to finalize a claim the server did not co-sign", async () => {
        const operator = fakeOperator({ cosign: false });
        await expect(
            pushClaim(operator, {
                contract: swapScript(),
                receiver: RECEIVER,
                preimage: PREIMAGE,
                vtxos: VTXOS,
                destinationPkScript: DESTINATION_PK_SCRIPT,
                expectedAmount: EXPECTED_AMOUNT,
            }),
        ).rejects.toThrow(/not signed by the server/);
        expect(operator.finalized).toHaveLength(0);
    });

    it("fails closed when the server returns no final ark tx to check", async () => {
        const operator = fakeOperator({ finalTx: () => undefined });
        await expect(
            pushClaim(operator, {
                contract: swapScript(),
                receiver: RECEIVER,
                preimage: PREIMAGE,
                vtxos: VTXOS,
                destinationPkScript: DESTINATION_PK_SCRIPT,
                expectedAmount: EXPECTED_AMOUNT,
            }),
        ).rejects.toThrow(/no final ark tx to verify/);
        expect(operator.finalized).toHaveLength(0);
    });

    it("throws on nothing to claim", async () => {
        await expect(
            pushClaim(fakeOperator(), {
                contract: swapScript(),
                receiver: RECEIVER,
                preimage: PREIMAGE,
                vtxos: [],
                destinationPkScript: DESTINATION_PK_SCRIPT,
                expectedAmount: EXPECTED_AMOUNT,
            }),
        ).rejects.toThrow(/nothing to claim/);
    });
});

describe("awaitLockupFunding + claimReceiveLockup", () => {
    const indexerOver = (rounds: LockupVtxo[][]): RefundIndexer => {
        let calls = 0;
        return {
            getVtxos: async (opts?: { spendableOnly?: boolean; recoverableOnly?: boolean }) => {
                // The real findLockupVtxos asks both filters; only the
                // spendable answer carries the live lockup.
                if (opts?.recoverableOnly) return { vtxos: [] };
                return { vtxos: rounds[Math.min(calls++, rounds.length - 1)]! };
            },
        } as unknown as RefundIndexer;
    };

    it("waits for the lockup, then claims it in one call", async () => {
        const indexer = indexerOver([[], VTXOS]);
        const operator = fakeOperator();
        const result = await claimReceiveLockup(indexer, operator, {
            contract: swapScript(),
            receiver: RECEIVER,
            preimage: PREIMAGE,
            swapPkScript: swapScript().pkScript,
            destinationPkScript: DESTINATION_PK_SCRIPT,
            expectedAmount: EXPECTED_AMOUNT,
            pollMs: 1,
        });
        expect(operator.submitted).toHaveLength(1);
        expect(result.amount).toBe(100_000);
    });

    it("times out with a stable reason when the lockup never lands", async () => {
        await expect(
            awaitLockupFunding(indexerOver([[]]), swapScript().pkScript, {
                pollMs: 1,
                deadline: Math.floor(Date.now() / 1000) - 1,
            }),
        ).rejects.toThrow(expect.objectContaining({ reason: "lockup_timeout" }));
    });
});
