/**
 * The zero-persistence recovery loop: contract rows in, refunds out.
 *
 * What must hold: a matured, funded lockup whose sender the wallet can
 * re-derive is refunded; an immature one is reported `pending`, not pushed; a
 * foreign sender (random-secrets swap, receive lockup) is `no-signer`; an
 * unfunded row is `empty`; swept outputs surface as `needsRecovery` instead
 * of poisoning the aggregate push. All of it from the row's serialized
 * params alone — the same write `registerLockupContract` makes.
 */
import { describe, expect, it } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
    CSVMultisigTapscript,
    SingleKey,
    Transaction,
    VHTLCV2ContractHandler,
    type IWallet,
} from "@arkade-os/sdk";

import { lightningSendVtxoScript } from "../src/rfq";
import {
    SWAP_LOCKUP_CONTRACT_KIND,
    SWAP_LOCKUP_CONTRACT_LABEL,
    SWAP_LOCKUP_CONTRACT_TYPE,
} from "../src/lockupContract";
import { sweepRefundableLockups } from "../src/lockupSweep";
import type { LockupVtxo, RefundArkProvider, RefundIndexer } from "../src/refund";

const priv = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const key = (fill: number): Uint8Array => schnorr.getPublicKey(priv(fill));
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

const REFUND_LOCKTIME = 1_800_000_000;
const SENDER = SingleKey.fromPrivateKey(priv(13));
const DESCRIPTOR = "tr(descriptor-for-sender)/0/7";

const swapScript = (over: { senderPubkey?: Uint8Array; refundLocktime?: number } = {}) =>
    lightningSendVtxoScript({
        solverPubkey: key(1),
        serverPubkey: key(3),
        paymentHash: hex.encode(sha256(new Uint8Array(32).fill(7))),
        refundLocktime: over.refundLocktime ?? REFUND_LOCKTIME,
        claimDelay: 4096,
        emulatorPubkey: key(9),
        refundPkScript: p2tr(key(5)),
        senderPubkey: over.senderPubkey ?? key(13),
        receiverPkScript: p2tr(key(1)),
    });

const rowOf = (script: ReturnType<typeof swapScript>, address: string) => ({
    type: SWAP_LOCKUP_CONTRACT_TYPE,
    params: VHTLCV2ContractHandler.serializeParams(script.options),
    script: hex.encode(script.pkScript),
    address,
    state: "active",
    createdAt: 0,
    label: SWAP_LOCKUP_CONTRACT_LABEL,
    metadata: { genericallySpendable: false, kind: SWAP_LOCKUP_CONTRACT_KIND },
});

const CHECKPOINT_TAPSCRIPT = hex.encode(
    CSVMultisigTapscript.encode({
        timelock: { type: "blocks", value: BigInt(144) },
        pubkeys: [key(3)],
    }).script,
);

const fakeArk = (): RefundArkProvider & { submitted: string[] } => {
    const submitted: string[] = [];
    return {
        submitted,
        getInfo: async () => ({ checkpointTapscript: CHECKPOINT_TAPSCRIPT }),
        submitTx: async (arkTx: string, checkpoints: string[]) => {
            submitted.push(arkTx);
            return {
                arkTxid: Transaction.fromPSBT(base64.decode(arkTx)).id,
                finalArkTx: arkTx,
                signedCheckpointTxs: checkpoints,
            };
        },
        finalizeTx: async () => {},
    } as unknown as RefundArkProvider & { submitted: string[] };
};

/** Serves per-pkScript vtxo sets; anything unlisted is unfunded. */
const fakeIndexer = (byScript: Record<string, LockupVtxo[]>): RefundIndexer =>
    ({
        getVtxos: async (opts?: { scripts?: string[]; recoverableOnly?: boolean }) => {
            const vtxos = byScript[opts?.scripts?.[0] ?? ""] ?? [];
            return {
                vtxos: vtxos.filter(
                    (v) => Boolean(v.recoverable) === Boolean(opts?.recoverableOnly),
                ),
            };
        },
    }) as unknown as RefundIndexer;

const fakeWallet = (rows: ReturnType<typeof rowOf>[]): IWallet =>
    ({
        getContractManager: async () => ({ getContracts: async () => rows }),
        // HDWalletCapable — the sweep must find the sender without allocating.
        getCurrentSigningDescriptor: async () => DESCRIPTOR,
        getUsedSigningDescriptors: async () => [DESCRIPTOR],
        signerForDescriptor: async (descriptor: string) => {
            if (descriptor !== DESCRIPTOR) throw new Error(`unknown descriptor ${descriptor}`);
            return SENDER;
        },
    }) as unknown as IWallet;

const funded: LockupVtxo[] = [
    { txid: "11".repeat(32), vout: 0, value: 60_000, recoverable: false },
];

describe("sweepRefundableLockups", () => {
    it("refunds a matured lockup rebuilt from its contract row alone", async () => {
        const script = swapScript();
        const ark = fakeArk();
        const report = await sweepRefundableLockups(
            fakeWallet([rowOf(script, "ark1matured")]),
            "",
            {
                ark,
                indexer: fakeIndexer({ [hex.encode(script.pkScript)]: funded }),
                nowSeconds: REFUND_LOCKTIME + 1,
            },
        );
        expect(report.refunded).toHaveLength(1);
        expect(report.refunded[0].address).toBe("ark1matured");
        expect(report.refunded[0].amount).toBe(60_000);
        expect(ark.submitted).toHaveLength(1);
        expect(report.pending).toEqual([]);
        expect(report.skipped).toEqual([]);
    });

    it("reports an immature lockup as pending without pushing", async () => {
        const script = swapScript();
        const ark = fakeArk();
        const report = await sweepRefundableLockups(fakeWallet([rowOf(script, "ark1early")]), "", {
            ark,
            indexer: fakeIndexer({ [hex.encode(script.pkScript)]: funded }),
            nowSeconds: REFUND_LOCKTIME - 1,
        });
        expect(report.pending).toEqual([{ address: "ark1early", refundLocktime: REFUND_LOCKTIME }]);
        expect(ark.submitted).toEqual([]);
    });

    it("skips foreign senders and unfunded rows for the right reasons", async () => {
        const foreign = swapScript({ senderPubkey: key(42) }); // receive / random-secrets
        const empty = swapScript();
        const report = await sweepRefundableLockups(
            fakeWallet([rowOf(foreign, "ark1foreign"), rowOf(empty, "ark1empty")]),
            "",
            { ark: fakeArk(), indexer: fakeIndexer({}), nowSeconds: REFUND_LOCKTIME + 1 },
        );
        expect(report.skipped).toEqual([
            { address: "ark1foreign", reason: "no-signer" },
            { address: "ark1empty", reason: "empty" },
        ]);
        expect(report.refunded).toEqual([]);
    });

    it("routes swept outputs to needsRecovery instead of pushing", async () => {
        const script = swapScript();
        const swept: LockupVtxo[] = [
            { txid: "33".repeat(32), vout: 2, value: 10_000, recoverable: true },
        ];
        const report = await sweepRefundableLockups(fakeWallet([rowOf(script, "ark1swept")]), "", {
            ark: fakeArk(),
            indexer: fakeIndexer({ [hex.encode(script.pkScript)]: [...funded, ...swept] }),
            nowSeconds: REFUND_LOCKTIME + 1,
        });
        expect(report.needsRecovery).toEqual([
            { address: "ark1swept", outpoints: [`${"33".repeat(32)}:2`] },
        ]);
        expect(report.refunded).toEqual([]);
    });

    it("ignores contract rows that are not swap lockups", async () => {
        const report = await sweepRefundableLockups(
            fakeWallet([
                { ...rowOf(swapScript(), "ark1other"), metadata: { kind: "something-else" } },
            ]),
            "",
            { ark: fakeArk(), indexer: fakeIndexer({}), nowSeconds: REFUND_LOCKTIME + 1 },
        );
        expect(report.skipped).toEqual([]);
        expect(report.refunded).toEqual([]);
    });
});
