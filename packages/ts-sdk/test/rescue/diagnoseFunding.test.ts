import { base64, hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vitest";
import type { IndexerProvider } from "../../src/providers/indexer";
import { ANCHOR_PKSCRIPT } from "../../src/utils/anchor";
import { DefaultVtxo } from "../../src/script/default";
import { VHTLC } from "../../src/script/vhtlc";
import type { VirtualCoin } from "../../src/wallet";
import {
    assessVhtlcLockup,
    diagnoseFundingOnServer,
    diagnoseFundingPsbt,
    formatFundingReport,
    reportFunding,
    type ServerSignerInfo,
} from "../../src/rescue/diagnoseFunding";

// On-curve x-only keys. Arbitrary 32-byte strings fail taproot construction.
const USER = hex.decode("d1dbd99dcd27234ef4dbc3d79e17b97f44ea6a9b45e624ea28783d4c59fcbfb2");
const SERVER = hex.decode("2b74c2011af089c849383ee527c72325de52df6a788428b68d49e9174053aaba");
const OTHER = hex.decode("8202bebddeb1f7442803897a85eaf3ce9254d07df0172fc3725ab5f0d097779c");
const STRANGER_SERVER = hex.decode(
    "b43a8363118c084a04d4f6a50ebfa58e81957f8cceceb2aee0ab64c9fd2d9977",
);
const EXIT = { type: "seconds" as const, value: 605184n };

const options = {
    serverPubkeys: [SERVER],
    exitTimelocks: [EXIT],
};

function fundingPsbt(): string {
    const wallet = new DefaultVtxo.Script({
        pubKey: USER,
        serverPubKey: SERVER,
        csvTimelock: EXIT,
    });
    const lockup = new DefaultVtxo.Script({
        pubKey: OTHER,
        serverPubKey: SERVER,
        csvTimelock: EXIT,
    });
    const tx = new Transaction({ version: 3 });
    tx.addInput({
        txid: hex.decode("aa".repeat(32)),
        index: 0,
        witnessUtxo: { amount: 1000n, script: wallet.pkScript },
        tapLeafScript: [wallet.forfeit()],
    });
    tx.addOutput({ amount: 600n, script: lockup.pkScript });
    tx.addOutput({ amount: 400n, script: wallet.pkScript });
    tx.addOutput({ amount: 0n, script: ANCHOR_PKSCRIPT });
    return base64.encode(tx.toPSBT());
}

function coin(
    over: Partial<VirtualCoin> & Pick<VirtualCoin, "txid" | "vout" | "value" | "script">,
): VirtualCoin {
    return {
        status: { confirmed: false },
        createdAt: new Date(0),
        isUnrolled: false,
        isSpent: false,
        isSwept: false,
        spentBy: "",
        ...over,
    };
}

const NOW = { timestamp: new Date("2026-09-29T00:00:00Z") };

describe("diagnoseFundingPsbt", () => {
    it("separates the sender's change from the lockup output", () => {
        const diagnosis = diagnoseFundingPsbt(fundingPsbt(), options);

        expect(diagnosis.senderPubkey).toBe(hex.encode(USER));
        expect(diagnosis.cosignerPubkey).toBe(hex.encode(SERVER));
        expect(diagnosis.outputs.map((output) => output.kind)).toEqual([
            "foreign",
            "wallet",
            "anchor",
        ]);
        expect(diagnosis.outputs[0].amount).toBe(600);
        expect(diagnosis.outputs[1].amount).toBe(400);
    });

    it("does not invent a sender when the leaf is not a known signer pair", () => {
        const stranger = new DefaultVtxo.Script({
            pubKey: OTHER,
            serverPubKey: STRANGER_SERVER,
            csvTimelock: EXIT,
        });
        const tx = new Transaction({ version: 3 });
        tx.addInput({
            txid: hex.decode("bb".repeat(32)),
            index: 0,
            witnessUtxo: { amount: 50n, script: stranger.pkScript },
            tapLeafScript: [stranger.forfeit()],
        });
        tx.addOutput({ amount: 50n, script: stranger.pkScript });
        const diagnosis = diagnoseFundingPsbt(base64.encode(tx.toPSBT()), options);

        expect(diagnosis.senderPubkey).toBeUndefined();
        expect(diagnosis.outputs[0].kind).toBe("foreign");
    });
});

describe("reportFunding", () => {
    const diagnosis = diagnoseFundingPsbt(fundingPsbt(), options);
    const lockup = diagnosis.outputs[0];
    const change = diagnosis.outputs[1];

    it("tells a swept lockup apart from swept change", () => {
        const report = reportFunding(
            [diagnosis],
            [
                coin({
                    txid: diagnosis.txid,
                    vout: 0,
                    value: lockup.amount,
                    script: lockup.pkScript,
                    isSwept: true,
                }),
                coin({
                    txid: diagnosis.txid,
                    vout: 1,
                    value: change.amount,
                    script: change.pkScript,
                    isSwept: true,
                }),
            ],
            NOW,
            { dust: 330 },
        );

        const byVout = new Map(report.outputs.map((output) => [output.vout, output]));
        expect(byVout.get(0)?.recovery.action).toBe("lockup-leaf");
        expect(byVout.get(0)?.liveness).toBe("recoverable");
        expect(byVout.get(1)?.recovery.action).toBe("wallet");
        expect(report.lockupSats).toBe(600);
        expect(report.walletRecoverableSats).toBe(400);
        expect(formatFundingReport(report)).toContain("refundWithoutReceiver");
    });

    it("stops at a spent lockup", () => {
        const report = reportFunding(
            [diagnosis],
            [
                coin({
                    txid: diagnosis.txid,
                    vout: 0,
                    value: lockup.amount,
                    script: lockup.pkScript,
                    isSpent: true,
                    spentBy: "cc".repeat(32),
                }),
            ],
            NOW,
        );
        expect(report.outputs.find((output) => output.vout === 0)?.recovery.action).toBe("none");
        expect(report.lockupSats).toBe(0);
    });

    it("counts an unrolled output as an onchain exit", () => {
        const report = reportFunding(
            [diagnosis],
            [
                coin({
                    txid: diagnosis.txid,
                    vout: 0,
                    value: lockup.amount,
                    script: lockup.pkScript,
                    isUnrolled: true,
                }),
            ],
            NOW,
        );
        expect(report.outputs.find((output) => output.vout === 0)?.recovery.action).toBe(
            "onchain-exit",
        );
    });
});

describe("assessVhtlcLockup", () => {
    const lockup = new VHTLC.Script({
        sender: USER,
        receiver: OTHER,
        server: SERVER,
        preimageHash: hex.decode("ab".repeat(20)),
        refundLocktime: 1_700_000_000n,
        unilateralClaimDelay: { type: "blocks", value: 10n },
        unilateralRefundDelay: { type: "blocks", value: 20n },
        unilateralRefundWithoutReceiverDelay: { type: "blocks", value: 30n },
    });
    const pkScript = hex.encode(lockup.pkScript);

    it("matches the output and reports a matured refund leaf", () => {
        const assessment = assessVhtlcLockup(lockup, pkScript, {
            currentTime: Date.parse("2026-09-29T00:00:00Z"),
        });
        expect(assessment.matches).toBe(true);
        expect(assessment.maturity).toBe("satisfied");
        expect(assessment.leaf).toBe("refundWithoutReceiver");
    });

    it("reports a locktime that has not matured", () => {
        const future = new VHTLC.Script({
            ...lockup.options,
            refundLocktime: 2_000_000_000n,
        });
        const assessment = assessVhtlcLockup(future, hex.encode(future.pkScript), {
            currentTime: Date.parse("2026-09-29T00:00:00Z"),
        });
        expect(assessment.maturity).toBe("pending");
    });

    it("rejects a script that tweaks to a different output", () => {
        const assessment = assessVhtlcLockup(lockup, "00".repeat(34), {
            currentTime: Date.parse("2026-09-29T00:00:00Z"),
        });
        expect(assessment.matches).toBe(false);
    });
});

describe("diagnoseFundingOnServer", () => {
    it("reads the indexer and includes other coins on the sender script", async () => {
        const psbt = fundingPsbt();
        const diagnosis = diagnoseFundingPsbt(psbt, options);
        const server: ServerSignerInfo = {
            signerPubkey: hex.encode(SERVER),
            deprecatedSigners: [],
            unilateralExitDelay: 605184n,
            network: "regtest",
            dust: 330n,
        };
        const extra = coin({
            txid: "dd".repeat(32),
            vout: 1,
            value: 7,
            script: diagnosis.outputs[1].pkScript,
            isSwept: true,
        });
        const indexer: Pick<IndexerProvider, "getVirtualTxs" | "getVtxos"> = {
            async getVirtualTxs() {
                return { txs: [psbt] };
            },
            async getVtxos(opts) {
                if (opts?.scripts) return { vtxos: [extra] };
                return {
                    vtxos: [
                        coin({
                            txid: diagnosis.txid,
                            vout: 0,
                            value: 600,
                            script: diagnosis.outputs[0].pkScript,
                            isSwept: true,
                        }),
                        coin({
                            txid: diagnosis.txid,
                            vout: 1,
                            value: 400,
                            script: diagnosis.outputs[1].pkScript,
                            isSwept: true,
                        }),
                    ],
                };
            },
        };

        const report = await diagnoseFundingOnServer(server, indexer, [diagnosis.txid], NOW);

        expect(report.lockupSats).toBe(600);
        expect(report.walletRecoverableSats).toBe(407);
        expect(report.walletVtxos).toEqual([
            {
                txid: extra.txid,
                vout: 1,
                value: 7,
                script: extra.script,
                liveness: "recoverable",
            },
        ]);
    });
});
