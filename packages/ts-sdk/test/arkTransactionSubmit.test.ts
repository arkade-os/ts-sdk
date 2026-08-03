import { describe, it, expect, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { Transaction } from "../src/utils/transaction";
import {
    submitOffchainTx,
    type OffchainTx,
    type OffchainTxSigner,
    type OffchainTxSubmitProvider,
} from "../src/utils/arkTransaction";

const P2TR = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0xab)]);

/** Deterministic x-only pubkey; PSBT encoding rejects arbitrary 32 bytes. */
const key = (seed: number) => schnorr.getPublicKey(new Uint8Array(32).fill(seed));
const SERVER_KEY = key(7);

// Distinguishable checkpoints: each spends a different outpoint, so the txid
// matching under test has something to tell them apart. Every one carries a
// tapScriptSig standing in for the server's share, which the merge branch
// concatenates the user's onto.
function checkpoint(seed: number): Transaction {
    const tx = new Transaction();
    tx.addInput({
        txid: new Uint8Array(32).fill(seed),
        index: 0,
        witnessUtxo: { script: P2TR, amount: 1000n },
    });
    tx.addOutput({ script: P2TR, amount: 900n });
    tx.updateInput(0, {
        tapScriptSig: [
            [{ pubKey: SERVER_KEY, leafHash: new Uint8Array(32) }, new Uint8Array(64).fill(0xff)],
        ],
    });
    return tx;
}

/** A copy of `tx` carrying an extra tapScriptSig keyed by `seed`. */
function userSigned(tx: Transaction, seed: number): Transaction {
    const copy = Transaction.fromPSBT(tx.toPSBT());
    copy.updateInput(0, {
        tapScriptSig: [
            [{ pubKey: key(seed), leafHash: new Uint8Array(32) }, new Uint8Array(64).fill(seed)],
        ],
    });
    return copy;
}

function offchainTx(checkpoints: Transaction[]): OffchainTx {
    return { arkTx: new Transaction(), checkpoints };
}

function encode(checkpoints: Transaction[]): string[] {
    return checkpoints.map((c) => base64.encode(c.toPSBT()));
}

// `userSignedCheckpoints` selects the batch (merge) branch vs the sign-after
// branch, which is what these tests steer.
function signer(userSignedCheckpoints?: Transaction[]): OffchainTxSigner & {
    signCheckpoint: ReturnType<typeof vi.fn>;
} {
    return {
        signArkTx: async (arkTx) => ({ arkTx, userSignedCheckpoints }),
        signCheckpoint: vi.fn(async (checkpoint: Transaction) => checkpoint),
    };
}

function provider(signedCheckpointTxs: string[]): OffchainTxSubmitProvider & {
    submitTx: ReturnType<typeof vi.fn>;
    finalizeTx: ReturnType<typeof vi.fn>;
} {
    return {
        submitTx: vi.fn(async () => ({ arkTxid: "txid", signedCheckpointTxs })),
        finalizeTx: vi.fn(async () => {}),
    };
}

/** Txids of the checkpoints handed to `finalizeTx`, in the order they arrived. */
function finalizedTxids(p: { finalizeTx: ReturnType<typeof vi.fn> }): string[] {
    return (p.finalizeTx.mock.calls[0][1] as string[]).map(
        (c) => Transaction.fromPSBT(base64.decode(c)).id,
    );
}

/** Pubkeys of the tapScriptSigs on input 0 of each finalized checkpoint (PSBT-sorted). */
function finalizedSigners(p: { finalizeTx: ReturnType<typeof vi.fn> }): string[][] {
    return (p.finalizeTx.mock.calls[0][1] as string[]).map((c) =>
        (Transaction.fromPSBT(base64.decode(c)).getInput(0).tapScriptSig ?? [])
            .map(([data]) => hex.encode(data.pubKey))
            .sort(),
    );
}

describe("submitOffchainTx checkpoint count guards", () => {
    it("rejects a truncated submitTx response on the sign-after path", async () => {
        const p = provider(encode([checkpoint(1)]));

        await expect(
            submitOffchainTx(p, offchainTx([checkpoint(1), checkpoint(2)]), signer()),
        ).rejects.toThrow(/submitTx returned 1 checkpoints, expected 2/);
        expect(p.finalizeTx).not.toHaveBeenCalled();
    });

    it("rejects an overlong submitTx response on the sign-after path", async () => {
        const p = provider(encode([checkpoint(1), checkpoint(2), checkpoint(3)]));

        await expect(
            submitOffchainTx(p, offchainTx([checkpoint(1), checkpoint(2)]), signer()),
        ).rejects.toThrow(/submitTx returned 3 checkpoints, expected 2/);
        expect(p.finalizeTx).not.toHaveBeenCalled();
    });

    // The pre-existing guard compared the two arrays to each other, so a signer
    // and a server that were truncated by the same amount agreed with each other
    // while still dropping a checkpoint. Both are checked against the built set.
    it("rejects equally truncated signer and server arrays", async () => {
        const p = provider(encode([checkpoint(1)]));

        await expect(
            submitOffchainTx(
                p,
                offchainTx([checkpoint(1), checkpoint(2)]),
                signer([checkpoint(1)]),
            ),
        ).rejects.toThrow(/signer returned 1 signed checkpoints, expected 2/);
    });

    it("rejects a miscounting signer before submitting", async () => {
        const p = provider(encode([checkpoint(1), checkpoint(2)]));

        await expect(
            submitOffchainTx(
                p,
                offchainTx([checkpoint(1), checkpoint(2)]),
                signer([checkpoint(1)]),
            ),
        ).rejects.toThrow(/signer returned 1 signed checkpoints, expected 2/);
        // Failing before submitTx is the point: a tx registered server-side but
        // never finalized would be left pending with no local recovery path.
        expect(p.submitTx).not.toHaveBeenCalled();
        expect(p.finalizeTx).not.toHaveBeenCalled();
    });

    it("finalizes every checkpoint when the counts line up", async () => {
        const p = provider(encode([checkpoint(1), checkpoint(2)]));

        const { arkTxid } = await submitOffchainTx(
            p,
            offchainTx([checkpoint(1), checkpoint(2)]),
            signer(),
        );

        expect(arkTxid).toBe("txid");
        expect(p.finalizeTx).toHaveBeenCalledTimes(1);
        expect(p.finalizeTx.mock.calls[0][1]).toHaveLength(2);
    });
});

describe("submitOffchainTx checkpoint txid matching", () => {
    it("accepts reordered server checkpoints and finalizes in the server's order", async () => {
        const local = [checkpoint(1), checkpoint(2)];
        const p = provider(encode([local[1], local[0]]));

        await submitOffchainTx(p, offchainTx(local), signer());

        expect(finalizedTxids(p)).toEqual([local[1].id, local[0].id]);
    });

    it("rejects an unsubmitted checkpoint on the sign-after path", async () => {
        const local = [checkpoint(1), checkpoint(2)];
        const unsubmitted = checkpoint(9);
        const p = provider(encode([local[0], unsubmitted]));
        const s = signer();

        await expect(submitOffchainTx(p, offchainTx(local), s)).rejects.toThrow(
            new RegExp(`submitTx checkpoint 1 txid ${unsubmitted.id} does not match`),
        );
        expect(s.signCheckpoint).not.toHaveBeenCalled();
        expect(p.finalizeTx).not.toHaveBeenCalled();
    });

    it("merges user signatures by txid when the server reorders (batch path)", async () => {
        const local = [checkpoint(1), checkpoint(2)];
        const p = provider(encode([local[1], local[0]]));

        await submitOffchainTx(
            p,
            offchainTx(local),
            signer([userSigned(local[0], 1), userSigned(local[1], 2)]),
        );

        expect(finalizedTxids(p)).toEqual([local[1].id, local[0].id]);
        // Each server checkpoint carries the user share built for *its* txid,
        // appended to the server's own — never the one at the same position.
        expect(finalizedSigners(p)).toEqual([
            [hex.encode(SERVER_KEY), hex.encode(key(2))].sort(),
            [hex.encode(SERVER_KEY), hex.encode(key(1))].sort(),
        ]);
    });

    it("rejects an unsubmitted checkpoint on the batch path", async () => {
        const local = [checkpoint(1), checkpoint(2)];
        const unsubmitted = checkpoint(9);
        const p = provider(encode([unsubmitted, local[1]]));

        await expect(
            submitOffchainTx(
                p,
                offchainTx(local),
                signer([userSigned(local[0], 1), userSigned(local[1], 2)]),
            ),
        ).rejects.toThrow(
            new RegExp(`submitTx checkpoint 0 txid ${unsubmitted.id} does not match`),
        );
        expect(p.finalizeTx).not.toHaveBeenCalled();
    });
});
