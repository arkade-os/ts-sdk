import { describe, it, expect, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    buildOffchainTx,
    CSVMultisigTapscript,
    MultisigTapscript,
    ServerResponseMismatchError,
    SingleKey,
    submitViaEmulator,
    Transaction,
    VtxoScript,
    type EmulatorSubmitProposal,
    type EmulatorSubmitOptions,
} from "../src";
import { mintCoin } from "./helpers/prevArkTx";

const key = (seed: number) => schnorr.getPublicKey(new Uint8Array(32).fill(seed));
const SERVER = key(7);
const user = SingleKey.fromHex(hex.encode(new Uint8Array(32).fill(0x11)));

function input(value: number, pubkeys: Uint8Array[]) {
    const script = new VtxoScript([MultisigTapscript.encode({ pubkeys }).script]);
    return { ...mintCoin(value), tapLeafScript: script.leaves[0], tapTree: script.encode() };
}

/** Input 0 spends someone else's leaf, input 1 the user's. */
async function spend() {
    return buildOffchainTx(
        [input(1_000, [key(8), SERVER]), input(2_000, [await user.xOnlyPublicKey(), SERVER])],
        [{ script: new Uint8Array([0x51, 0x20, ...key(9)]), amount: 3_000n }],
        CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: 10n },
            pubkeys: [SERVER],
        }),
    );
}

function emulator(reply: (arkTx: string) => string = (arkTx) => arkTx) {
    return {
        submitTx: vi.fn(async (arkTx: string, checkpointTxs: string[]) => ({
            signedArkTx: reply(arkTx),
            signedCheckpointTxs: checkpointTxs,
        })),
    };
}

const decode = (psbt: string) => Transaction.fromPSBT(base64.decode(psbt));
const signers = (tx: Transaction, index: number) =>
    (tx.getInput(index).tapScriptSig ?? []).map(([{ pubKey }]) => hex.encode(pubKey));

describe("submitViaEmulator", () => {
    it("captures the receipt callback before waiting for the signer", async () => {
        const emu = emulator();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const sign = vi.fn(async (tx: Transaction, indexes?: number[]) => {
            await gate;
            return user.sign(tx, indexes);
        });
        const receipt = vi.fn(() => {
            expect(emu.submitTx).not.toHaveBeenCalled();
        });
        const options: EmulatorSubmitOptions & { inputIndexes: number[] } = {
            inputIndexes: [1],
            beforeEmulatorSubmit: receipt,
        };
        const pending = submitViaEmulator(emu, await spend(), { sign }, options);
        try {
            await vi.waitFor(() => expect(sign).toHaveBeenCalledOnce());
            options.beforeEmulatorSubmit = undefined;
            expect(emu.submitTx).not.toHaveBeenCalled();
        } finally {
            release();
            await pending;
        }
        expect(receipt).toHaveBeenCalledOnce();
        expect(emu.submitTx).toHaveBeenCalledOnce();
    });

    it("awaits an immutable receipt containing the exact signed request before dispatch", async () => {
        const emu = emulator();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let receipt!: EmulatorSubmitProposal;
        const beforeEmulatorSubmit = vi.fn(async (proposal: EmulatorSubmitProposal) => {
            receipt = proposal;
            await gate;
        });
        const pending = submitViaEmulator(emu, await spend(), user, {
            inputIndexes: [1],
            beforeEmulatorSubmit,
        });
        try {
            await vi.waitFor(() => expect(beforeEmulatorSubmit).toHaveBeenCalledOnce());
            expect(emu.submitTx).not.toHaveBeenCalled();
            expect(Object.isFrozen(receipt)).toBe(true);
            expect(Object.isFrozen(receipt.checkpointTxs)).toBe(true);
            expect(Reflect.set(receipt, "arkTx", "changed")).toBe(false);
            expect(Reflect.set(receipt.checkpointTxs, "0", "changed")).toBe(false);
            const userKey = hex.encode(await user.xOnlyPublicKey());
            expect(signers(decode(receipt.arkTx), 1)).toEqual([userKey]);
            expect(signers(decode(receipt.checkpointTxs[1]), 0)).toEqual([userKey]);
            expect(receipt.txid).toBe(decode(receipt.arkTx).id);
        } finally {
            release();
            await pending;
        }
        expect(emu.submitTx).toHaveBeenCalledExactlyOnceWith(receipt.arkTx, [
            ...receipt.checkpointTxs,
        ]);
    });

    it.each([false, true])(
        "does not submit when receipt persistence rejects (async=%s)",
        async (async) => {
            const emu = emulator();
            const failure = new Error("receipt storage failed");
            const beforeEmulatorSubmit = () => {
                if (async) return Promise.reject(failure);
                throw failure;
            };
            await expect(
                submitViaEmulator(emu, await spend(), user, {
                    inputIndexes: [1],
                    beforeEmulatorSubmit,
                }),
            ).rejects.toBe(failure);
            expect(emu.submitTx).not.toHaveBeenCalled();
        },
    );

    it.each([false, true])(
        "validates the encoded request despite original transaction mutation (wrongReply=%s)",
        async (wrongReply) => {
            const tx = await spend();
            const originalId = tx.arkTx.id;
            const emu = emulator((encoded) =>
                wrongReply ? base64.encode(tx.arkTx.toPSBT()) : encoded,
            );
            const pending = submitViaEmulator(emu, tx, undefined, {
                inputIndexes: [],
                beforeEmulatorSubmit: async () => {
                    await Promise.resolve();
                    tx.arkTx.updateOutput(0, { amount: 1n });
                },
            });
            if (wrongReply)
                await expect(pending).rejects.toBeInstanceOf(ServerResponseMismatchError);
            else await expect(pending).resolves.toMatchObject({ txid: originalId });
            expect(decode(emu.submitTx.mock.calls[0][0]).id).toBe(originalId);
        },
    );

    it("signs only the user's inputs and their checkpoints, and submits them", async () => {
        const emu = emulator();
        await submitViaEmulator(emu, await spend(), user, { inputIndexes: [1] });

        const [arkTx, checkpoints] = emu.submitTx.mock.calls[0];
        const userKey = hex.encode(await user.xOnlyPublicKey());
        expect([0, 1].map((i) => signers(decode(arkTx), i))).toEqual([[], [userKey]]);
        expect(checkpoints.map((c) => signers(decode(c), 0))).toEqual([[], [userKey]]);
    });

    it("returns the emulator's co-signed txs under the submitted txid", async () => {
        const cosigned = (psbt: string) => {
            const tx = decode(psbt);
            tx.updateInput(0, {
                tapScriptSig: [
                    [{ pubKey: SERVER, leafHash: new Uint8Array(32) }, new Uint8Array(64).fill(1)],
                ],
            });
            return base64.encode(tx.toPSBT());
        };
        const tx = await spend();
        const emu = emulator(cosigned);

        const result = await submitViaEmulator(emu, tx, undefined, { inputIndexes: [] });

        const [arkTx, checkpoints] = emu.submitTx.mock.calls[0];
        expect(arkTx).toBe(base64.encode(tx.arkTx.toPSBT()));
        expect(result).toEqual({
            txid: tx.arkTx.id,
            signedArkTx: cosigned(arkTx),
            signedCheckpointTxs: checkpoints,
        });
    });

    it("rejects a returned ark tx with a different txid", async () => {
        const other = base64.encode((await spend()).arkTx.toPSBT());
        await expect(
            submitViaEmulator(
                emulator(() => other),
                await spend(),
                undefined,
                { inputIndexes: [] },
            ),
        ).rejects.toBeInstanceOf(ServerResponseMismatchError);
    });

    it("refuses user inputs without a signer, before submitting", async () => {
        const emu = emulator();
        const beforeEmulatorSubmit = vi.fn();
        await expect(
            submitViaEmulator(emu, await spend(), undefined, {
                inputIndexes: [1],
                beforeEmulatorSubmit,
            }),
        ).rejects.toMatchObject({ message: expect.stringContaining("identity") });
        expect(beforeEmulatorSubmit).not.toHaveBeenCalled();
        expect(emu.submitTx).not.toHaveBeenCalled();
    });
});
