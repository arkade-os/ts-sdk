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
} from "@arkade-os/sdk";

import { receiveVtxoScript } from "../src/rfq";
import {
    awaitLockupFunding,
    claimReceiveLockup,
    pushClaim,
    type ClaimArkProvider,
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
    receiveVtxoScript({
        solverPubkey: key(1),
        refundLocktime: REFUND_LOCKTIME,
        serverPubkey: key(3),
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

/** A scripted arkd, same contract as refund.test.ts's. */
type FakeArk = ClaimArkProvider & {
    submitted: { arkTx: string; checkpoints: string[] }[];
    finalized: { arkTxid: string; checkpoints: string[] }[];
};

const fakeArk = (over: { checkpointsFor?: (submitted: string[]) => string[] } = {}): FakeArk => {
    const submitted: { arkTx: string; checkpoints: string[] }[] = [];
    const finalized: { arkTxid: string; checkpoints: string[] }[] = [];
    return {
        submitted,
        finalized,
        getInfo: async () => ({ checkpointTapscript: CHECKPOINT_TAPSCRIPT }),
        submitTx: async (arkTx: string, checkpoints: string[]) => {
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

/** The leaf script the ark tx's single input actually spends. */
const spentLeafOf = (psbt: string): string => {
    const tx = Transaction.fromPSBT(base64.decode(psbt));
    const leaf = tx.getInput(0).tapLeafScript![0][1];
    return hex.encode(leaf.subarray(0, -1));
};

describe("pushClaim", () => {
    it("spends the claim leaf, signed by the trader's receiver key, preimage attached", async () => {
        const script = swapScript();
        const ark = fakeArk();
        const result = await pushClaim(ark, {
            script,
            receiver: RECEIVER,
            preimage: PREIMAGE,
            vtxos: VTXOS,
            destinationPkScript: DESTINATION_PK_SCRIPT,
        });

        expect(ark.submitted).toHaveLength(1);
        // The exact leaf bytes, control block stripped — the claim leaf and no
        // other.
        expect(spentLeafOf(ark.submitted[0]!.arkTx)).toBe(script.claimScript);
        // One aggregate output to the trader's destination, for the full amount.
        const arkTx = Transaction.fromPSBT(base64.decode(ark.submitted[0]!.arkTx));
        expect(arkTx.outputsLength).toBeGreaterThan(0);
        expect(hex.encode(arkTx.getOutput(0)!.script!)).toBe(hex.encode(DESTINATION_PK_SCRIPT));
        expect(arkTx.getOutput(0)!.amount).toBe(BigInt(100_000));
        expect(result.amount).toBe(100_000);
        // The preimage rides the condition-witness field on the ark
        // transaction, attached after signing…
        const conditionFields = getArkPsbtFields(arkTx, 0, ConditionWitness);
        expect(conditionFields).toHaveLength(1);
        expect(hex.encode(conditionFields[0]![0]!)).toBe(hex.encode(PREIMAGE));
        // …and finalize got the checkpoints back signed.
        expect(ark.finalized).toHaveLength(1);
        expect(ark.finalized[0]!.arkTxid).toBe(result.arkTxid);
    });

    it("attaches the preimage only after signing — the server's INVALID_SIGNATURE ordering", async () => {
        // A signer that records whether the ConditionWitness field was already
        // present AT SIGN TIME: it must not be, or the signature covers a
        // different payload than the one submitted.
        const script = swapScript();
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
        await pushClaim(fakeArk(), {
            script,
            receiver: probe,
            preimage: PREIMAGE,
            vtxos: VTXOS,
            destinationPkScript: DESTINATION_PK_SCRIPT,
        });
        expect(fieldPresentAtSignTime).toBe(false);
    });

    it("refuses a preimage that cannot open the script, before signing anything", async () => {
        const ark = fakeArk();
        await expect(
            pushClaim(ark, {
                script: swapScript(),
                receiver: RECEIVER,
                preimage: new Uint8Array(32).fill(8),
                vtxos: VTXOS,
                destinationPkScript: DESTINATION_PK_SCRIPT,
            }),
        ).rejects.toThrow(/does not match/);
        expect(ark.submitted).toHaveLength(0);
    });

    it("refuses a swept output rather than submitting a spend that cannot succeed", async () => {
        await expect(
            pushClaim(fakeArk(), {
                script: swapScript(),
                receiver: RECEIVER,
                preimage: PREIMAGE,
                vtxos: [{ txid: "33".repeat(32), vout: 0, value: 5_000, recoverable: true }],
                destinationPkScript: DESTINATION_PK_SCRIPT,
            }),
        ).rejects.toThrow(LockupNeedsRecoveryError);
    });

    it("throws on nothing to claim", async () => {
        await expect(
            pushClaim(fakeArk(), {
                script: swapScript(),
                receiver: RECEIVER,
                preimage: PREIMAGE,
                vtxos: [],
                destinationPkScript: DESTINATION_PK_SCRIPT,
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
        const ark = fakeArk();
        const result = await claimReceiveLockup(indexer, ark, {
            script: swapScript(),
            receiver: RECEIVER,
            preimage: PREIMAGE,
            swapPkScript: swapScript().pkScript,
            destinationPkScript: DESTINATION_PK_SCRIPT,
            pollMs: 1,
        });
        expect(ark.submitted).toHaveLength(1);
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
