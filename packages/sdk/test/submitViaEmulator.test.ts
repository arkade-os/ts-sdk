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
        await expect(
            submitViaEmulator(emu, await spend(), undefined, { inputIndexes: [1] }),
        ).rejects.toMatchObject({ message: expect.stringContaining("identity") });
        expect(emu.submitTx).not.toHaveBeenCalled();
    });
});
