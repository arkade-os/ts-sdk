import { describe, it, expect, vi } from "vitest";
import { base64 } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import {
    submitOffchainTx,
    type OffchainTx,
    type OffchainTxSigner,
    type OffchainTxSubmitProvider,
} from "../src/utils/arkTransaction";

// The checkpoint contents are irrelevant here: these tests pin the count
// invariants around submit/finalize, which are enforced before any signature is
// inspected. Empty PSBTs keep the fixtures honest about that.
function offchainTx(checkpointCount: number): OffchainTx {
    return {
        arkTx: new Transaction({ allowUnknown: true, allowUnknownOutputs: true }),
        checkpoints: Array.from(
            { length: checkpointCount },
            () => new Transaction({ allowUnknown: true, allowUnknownOutputs: true }),
        ),
    };
}

function encoded(count: number): string[] {
    return Array.from({ length: count }, () =>
        base64.encode(new Transaction({ allowUnknown: true }).toPSBT()),
    );
}

// Signs nothing; `userSignedCheckpoints` selects the batch (merge) branch vs the
// sign-after branch, which is all these tests need to steer.
function signer(userSignedCheckpointCount?: number): OffchainTxSigner {
    return {
        signArkTx: async (arkTx) => ({
            arkTx,
            userSignedCheckpoints:
                userSignedCheckpointCount === undefined
                    ? undefined
                    : Array.from(
                          { length: userSignedCheckpointCount },
                          () => new Transaction({ allowUnknown: true }),
                      ),
        }),
        signCheckpoint: async (checkpoint) => checkpoint,
    };
}

function provider(signedCheckpointCount: number): OffchainTxSubmitProvider & {
    submitTx: ReturnType<typeof vi.fn>;
    finalizeTx: ReturnType<typeof vi.fn>;
} {
    return {
        submitTx: vi.fn(async () => ({
            arkTxid: "txid",
            signedCheckpointTxs: encoded(signedCheckpointCount),
        })),
        finalizeTx: vi.fn(async () => {}),
    };
}

describe("submitOffchainTx checkpoint count guards", () => {
    it("rejects a truncated submitTx response on the sign-after path", async () => {
        const p = provider(1);

        await expect(submitOffchainTx(p, offchainTx(2), signer())).rejects.toThrow(
            /submitTx returned 1 checkpoints, expected 2/,
        );
        expect(p.finalizeTx).not.toHaveBeenCalled();
    });

    it("rejects an overlong submitTx response on the sign-after path", async () => {
        const p = provider(3);

        await expect(submitOffchainTx(p, offchainTx(2), signer())).rejects.toThrow(
            /submitTx returned 3 checkpoints, expected 2/,
        );
        expect(p.finalizeTx).not.toHaveBeenCalled();
    });

    // The pre-existing guard compared the two arrays to each other, so a signer
    // and a server that were truncated by the same amount agreed with each other
    // while still dropping a checkpoint. Both are checked against the built set.
    it("rejects equally truncated signer and server arrays", async () => {
        const p = provider(1);

        await expect(submitOffchainTx(p, offchainTx(2), signer(1))).rejects.toThrow(
            /signer returned 1 signed checkpoints, expected 2/,
        );
    });

    it("rejects a miscounting signer before submitting", async () => {
        const p = provider(2);

        await expect(submitOffchainTx(p, offchainTx(2), signer(1))).rejects.toThrow(
            /signer returned 1 signed checkpoints, expected 2/,
        );
        // Failing before submitTx is the point: a tx registered server-side but
        // never finalized would be left pending with no local recovery path.
        expect(p.submitTx).not.toHaveBeenCalled();
        expect(p.finalizeTx).not.toHaveBeenCalled();
    });

    it("finalizes every checkpoint when the counts line up", async () => {
        const p = provider(2);

        const { arkTxid } = await submitOffchainTx(p, offchainTx(2), signer());

        expect(arkTxid).toBe("txid");
        expect(p.finalizeTx).toHaveBeenCalledTimes(1);
        expect(p.finalizeTx.mock.calls[0][1]).toHaveLength(2);
    });
});
