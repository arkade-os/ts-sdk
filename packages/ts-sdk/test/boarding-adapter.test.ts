import { base64, hex } from "@scure/base";
import { sha256 } from "@scure/btc-signer/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it, vi } from "vitest";
vi.mock("../src/tree/validation", () => ({
    validateVtxoTxGraph: vi.fn(),
    validateConnectorsTxGraph: vi.fn(),
}));
import { Intent, type SignedIntent } from "../src/intent";
import { Transaction } from "../src/utils/transaction";
import type { BoardingSigningAdapter, PreparedBoardingRegistration } from "../src/wallet/boarding";
import { Wallet } from "../src/wallet/wallet";
import { createBoardingProgramScript } from "../src/script/boarding";
import { extendCoinWithTapscript } from "../src/wallet/utils";
import { InputSignerRouter } from "../src/wallet/inputSignerRouter";
import { networks } from "../src/networks";
import { SingleKey } from "../src/identity/singleKey";
import { Batch } from "../src/wallet/batch";
import { SettlementEventType, type SettlementEvent } from "../src/providers/ark";

const ready: PreparedBoardingRegistration = {
    status: "ready",
    handle: "opaque-runtime-handle",
    registerExpireAt: Math.floor(Date.now() / 1000) + 60,
};
const privateKey = (fill: number) => new Uint8Array(32).fill(fill);

function proof(message: Intent.RegisterMessage | Intent.DeleteMessage): SignedIntent<any> {
    return { proof: base64.encode(new Transaction().toPSBT()), message };
}

function walletWith(adapter: BoardingSigningAdapter): Wallet & Record<string, any> {
    const wallet = Object.create(Wallet.prototype) as Wallet & Record<string, any>;
    wallet.boardingSigningAdapter = adapter;
    return wallet;
}

function adapter(overrides: Partial<BoardingSigningAdapter> = {}): BoardingSigningAdapter {
    return {
        publicKey: new Uint8Array(32).fill(2),
        prepareRegistration: vi.fn().mockResolvedValue(ready),
        registerIntent: vi.fn().mockResolvedValue({ status: "registered", intentId: "intent-1" }),
        submitCommitment: vi.fn().mockResolvedValue({ status: "submitted" }),
        releaseIntent: vi.fn().mockResolvedValue({ status: "released" }),
        ...overrides,
    };
}

describe("named boarding adapter lifecycle seam", () => {
    it("directly registers through the adapter and returns only the Operator intent id", async () => {
        const signingAdapter = adapter();
        const wallet = walletWith(signingAdapter);
        const intent = proof({
            type: "register",
            onchain_output_indexes: [],
            valid_at: 0,
            expire_at: ready.registerExpireAt,
            cosigners_public_keys: [],
        });

        await expect(wallet.safeRegisterIntent(intent, [], ready, [0])).resolves.toBe("intent-1");
        expect(signingAdapter.registerIntent).toHaveBeenCalledWith(
            expect.objectContaining({ handle: ready.handle, inputIndexes: [0] }),
        );
    });

    it("does not turn definitely-not-submitted or ambiguous registration into cleanup", async () => {
        for (const status of ["definitely_not_submitted", "ambiguous"] as const) {
            const signingAdapter = adapter({
                registerIntent: vi.fn().mockResolvedValue({ status }),
            });
            const wallet = walletWith(signingAdapter);
            const intent = proof({
                type: "register",
                onchain_output_indexes: [],
                valid_at: 0,
                expire_at: ready.registerExpireAt,
                cosigners_public_keys: [],
            });

            await expect(wallet.safeRegisterIntent(intent, [], ready, [0])).rejects.toBeInstanceOf(
                Error,
            );
            expect(signingAdapter.releaseIntent).not.toHaveBeenCalled();
        }
    });

    it("releases only an authoritative prior handle, then prepares a fresh attempt", async () => {
        const deleteExpireAt = Math.floor(Date.now() / 1000) + 30;
        const signingAdapter = adapter({
            prepareRegistration: vi
                .fn()
                .mockResolvedValueOnce({
                    status: "release_required",
                    handle: "prior-handle",
                    deleteExpireAt,
                })
                .mockResolvedValueOnce(ready),
        });
        const wallet = walletWith(signingAdapter);
        wallet.makeDeleteIntentSignature = vi
            .fn()
            .mockResolvedValue(proof({ type: "delete", expire_at: deleteExpireAt }));

        const result = await wallet.prepareNamedBoardingRegistration(
            [{ txid: "11".repeat(32), vout: 0 }],
            [{ address: "recipient", amount: 1 }],
            [0, 1],
        );

        expect(result).toEqual(ready);
        expect(signingAdapter.prepareRegistration).toHaveBeenCalledTimes(2);
        expect(signingAdapter.releaseIntent).toHaveBeenCalledWith(
            expect.objectContaining({ handle: "prior-handle", inputIndexes: [0, 1] }),
        );
    });

    it("keeps an ambiguous release blocked and does not start another attempt", async () => {
        const deleteExpireAt = Math.floor(Date.now() / 1000) + 30;
        const prepareRegistration = vi.fn().mockResolvedValue({
            status: "release_required",
            handle: "prior-handle",
            deleteExpireAt,
        });
        const signingAdapter = adapter({
            prepareRegistration,
            releaseIntent: vi.fn().mockResolvedValue({ status: "ambiguous" }),
        });
        const wallet = walletWith(signingAdapter);
        wallet.makeDeleteIntentSignature = vi
            .fn()
            .mockResolvedValue(proof({ type: "delete", expire_at: deleteExpireAt }));

        await expect(
            wallet.prepareNamedBoardingRegistration(
                [{ txid: "11".repeat(32), vout: 0 }],
                [{ address: "recipient", amount: 1 }],
                [0, 1],
            ),
        ).rejects.toThrow("release outcome is ambiguous");
        expect(prepareRegistration).toHaveBeenCalledTimes(1);
    });

    it("honors a runtime blocked result without signing or releasing", async () => {
        const signingAdapter = adapter({
            prepareRegistration: vi.fn().mockResolvedValue({
                status: "blocked",
                reason: "prior attempt may be selected",
            }),
        });
        const wallet = walletWith(signingAdapter);
        wallet.makeDeleteIntentSignature = vi.fn();

        await expect(wallet.prepareNamedBoardingRegistration([], [], [])).rejects.toThrow(
            "prior attempt may be selected",
        );
        expect(wallet.makeDeleteIntentSignature).not.toHaveBeenCalled();
        expect(signingAdapter.releaseIntent).not.toHaveBeenCalled();
    });

    it("accepts only a canonical txid for authoritative finalized reconciliation", async () => {
        for (const commitmentTxid of ["", "aa", "AA".repeat(32), "zz".repeat(32)]) {
            const wallet = walletWith(
                adapter({
                    prepareRegistration: vi.fn().mockResolvedValue({
                        status: "finalized",
                        commitmentTxid,
                    }),
                }),
            );
            await expect(wallet.prepareNamedBoardingRegistration([], [], [])).rejects.toThrow(
                "invalid finalized result",
            );
        }

        const txid = "ab".repeat(32);
        const wallet = walletWith(
            adapter({
                prepareRegistration: vi.fn().mockResolvedValue({
                    status: "finalized",
                    commitmentTxid: txid,
                }),
            }),
        );
        await expect(wallet.prepareNamedBoardingRegistration([], [], [])).resolves.toBe(txid);
    });

    it("refuses cooperative finalization once the phone recovery path is mature", async () => {
        const key = (fill: number) => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
        const delay = { type: "seconds", value: 512n } as const;
        const script = createBoardingProgramScript(
            {
                name: "example-board-v1",
                boardingPubKey: key(1),
                cosignerPubKey: key(2),
                recoveryPubKey: key(4),
            },
            key(3),
            delay,
        );
        const wallet = walletWith(adapter());
        wallet._boardingTapscript = script;
        wallet.onchainProvider = { getChainTip: vi.fn() };
        const matured = extendCoinWithTapscript(script, {
            txid: "11".repeat(32),
            vout: 0,
            value: 10_000,
            status: {
                confirmed: true,
                block_time: Math.floor(Date.now() / 1000) - Number(delay.value) - 1,
            },
        });

        await expect(wallet.assertNamedBoardingCooperativeWindow([matured])).rejects.toThrow(
            "recovery window",
        );
    });

    it.each(["signed", "missing signature", "changed batch", "changed commitment"] as const)(
        "passes final streamed boarding signatures with bound authority: %s",
        async (scenario) => {
            const signingAdapter = adapter();
            const wallet = walletWith(signingAdapter);
            const boardingIdentity = SingleKey.fromPrivateKey(privateKey(1));
            const script = createBoardingProgramScript(
                {
                    name: "example-board-v1",
                    boardingPubKey: await boardingIdentity.xOnlyPublicKey(),
                    cosignerPubKey: signingAdapter.publicKey,
                    recoveryPubKey: await SingleKey.fromPrivateKey(privateKey(4)).xOnlyPublicKey(),
                },
                await SingleKey.fromPrivateKey(privateKey(3)).xOnlyPublicKey(),
                { type: "blocks", value: 100n },
            );
            const input = extendCoinWithTapscript(script, {
                txid: "11".repeat(32),
                vout: 0,
                value: 10_000,
                status: { confirmed: true, block_height: 999, block_time: 1 },
            });
            Object.assign(wallet, {
                _boardingTapscript: script,
                network: networks.regtest,
                arkProvider: {
                    confirmRegistration: vi.fn(),
                    submitTreeNonces: vi.fn(),
                    submitTreeSignatures: vi.fn(),
                },
                onchainProvider: { getChainTip: vi.fn().mockResolvedValue({ height: 1_000 }) },
                forfeitPubkey: new Uint8Array(32).fill(3),
                forfeitOutputScript: new Uint8Array([0x51]),
                _signerRouter: new InputSignerRouter({
                    identity: boardingIdentity,
                    contractRepository: { getContracts: async () => [] } as never,
                    boardingPkScript: script.pkScript,
                }),
            });

            const intentId = "intent-1";
            const batchExpiry = 100n;
            const commitment = new Transaction({ allowUnknownOutputs: true });
            commitment.addInput({
                txid: input.txid,
                index: input.vout,
                witnessUtxo: { script: script.pkScript, amount: BigInt(input.value) },
            });
            commitment.addOutput({ script: new Uint8Array([0x51]), amount: 9_000n });
            const commitmentPsbt = base64.encode(commitment.toPSBT());
            const session = {
                getPublicKey: vi.fn().mockResolvedValue(hex.decode("02" + "55".repeat(32))),
                init: vi.fn(),
                getNonces: vi.fn().mockResolvedValue({}),
                aggregatedNonces: vi.fn().mockResolvedValue({ hasAllNonces: true }),
                sign: vi.fn().mockResolvedValue(new Map()),
            } as never;
            const handler = wallet.createBatchHandler(
                intentId,
                [input],
                [],
                session,
                ready,
                script.pkScript,
            );

            const tree = new Transaction({ allowUnknownOutputs: true });
            tree.addInput({ txid: commitment.id, index: 0 });
            tree.addOutput({ script: new Uint8Array([0x51]), amount: 9_000n });
            // Event wiring fixture: Guardian independently verifies aggregate signature validity.
            const aggregateSignature = "11".repeat(64);
            const events: SettlementEvent[] = [
                {
                    type: SettlementEventType.BatchStarted,
                    id: "batch-1",
                    intentIdHashes: [hex.encode(sha256(new TextEncoder().encode(intentId)))],
                    batchExpiry,
                },
                {
                    type: SettlementEventType.TreeTx,
                    id: "batch-1",
                    topic: [],
                    batchIndex: 0,
                    chunk: { txid: tree.id, tx: base64.encode(tree.toPSBT()), children: {} },
                },
                {
                    type: SettlementEventType.TreeSigningStarted,
                    id: "batch-1",
                    topic: [],
                    cosignersPublicKeys: ["02" + "55".repeat(32)],
                    unsignedCommitmentTx: commitmentPsbt,
                },
                {
                    type: SettlementEventType.TreeNonces,
                    id: "batch-1",
                    topic: [],
                    txid: tree.id,
                    nonces: new Map(),
                },
            ];
            if (scenario !== "missing signature")
                events.push({
                    type: SettlementEventType.TreeSignature,
                    id: "batch-1",
                    topic: [],
                    batchIndex: 0,
                    txid: tree.id,
                    signature: aggregateSignature,
                });
            const finalCommitment = commitment.clone();
            if (scenario === "changed commitment")
                finalCommitment.updateOutput(0, { amount: 8_999n }, true);
            events.push(
                {
                    type: SettlementEventType.BatchFinalization,
                    id: scenario === "changed batch" ? "another-batch" : "batch-1",
                    commitmentTx: base64.encode(finalCommitment.toPSBT()),
                },
                {
                    type: SettlementEventType.BatchFinalized,
                    id: "batch-1",
                    commitmentTxid: commitment.id,
                },
            );
            async function* stream() {
                yield* events;
            }
            const signing = vi.spyOn(wallet._signerRouter, "sign");
            if (scenario !== "signed") {
                await expect(Batch.join(stream(), handler)).rejects.toThrow();
                expect(signingAdapter.submitCommitment).not.toHaveBeenCalled();
                expect(signing).not.toHaveBeenCalled();
                return;
            }
            await expect(Batch.join(stream(), handler)).resolves.toBe(commitment.id);
            const submitted = vi.mocked(signingAdapter.submitCommitment).mock.calls[0][0];
            expect(
                hex.encode(
                    Transaction.fromPSBT(
                        base64.decode(submitted.validatedBatch.vtxoTree[0].tx),
                    ).getInput(0).tapKeySig!,
                ),
            ).toBe(aggregateSignature);
            expect(submitted.validatedBatch.unsignedCommitmentTx).toBe(commitmentPsbt);
            expect(
                Transaction.fromPSBT(base64.decode(submitted.psbt)).getInput(0).tapScriptSig
                    ?.length,
            ).toBeGreaterThan(0);

            expect(signingAdapter.submitCommitment).toHaveBeenCalledOnce();
            expect(
                vi.mocked(signingAdapter.submitCommitment).mock.calls[0][0].validatedBatch,
            ).toEqual(expect.objectContaining({ batchId: "batch-1", batchExpiry }));
        },
    );
});
