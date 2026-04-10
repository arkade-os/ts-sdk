import { describe, it, expect, vi } from "vitest";
import {
    isBatchSignable,
    BatchSignableIdentity,
    SignRequest,
    Identity,
} from "../src/identity";
import { Transaction } from "../src/utils/transaction";
import { SignerSession, TreeSignerSession } from "../src/tree/signingSession";

function stubIdentity(): Identity {
    return {
        async xOnlyPublicKey() {
            return new Uint8Array(32);
        },
        async compressedPublicKey() {
            return new Uint8Array(33);
        },
        signerSession(): SignerSession {
            return TreeSignerSession.random();
        },
        async sign(tx: Transaction) {
            return tx;
        },
        async signMessage() {
            return new Uint8Array(64);
        },
    };
}

function stubBatchIdentity(
    signMultipleFn?: (requests: SignRequest[]) => Promise<Transaction[]>
): BatchSignableIdentity {
    const base = stubIdentity();
    return {
        ...base,
        signMultiple:
            signMultipleFn ??
            (async (requests: SignRequest[]) =>
                requests.map((r) => r.tx.clone())),
    };
}

describe("isBatchSignable", () => {
    it("should return true for BatchSignableIdentity", () => {
        const identity = stubBatchIdentity();
        expect(isBatchSignable(identity)).toBe(true);
    });

    it("should return false for plain Identity", () => {
        const identity = stubIdentity();
        expect(isBatchSignable(identity)).toBe(false);
    });

    it("should return false if signMultiple is not a function", () => {
        const identity = stubIdentity() as any;
        identity.signMultiple = "not a function";
        expect(isBatchSignable(identity)).toBe(false);
    });
});

describe("BatchSignableIdentity contract", () => {
    it("should return same number of transactions as requests", async () => {
        const identity = stubBatchIdentity();
        const tx = new Transaction();
        const requests: SignRequest[] = [
            { tx: tx.clone() },
            { tx: tx.clone() },
            { tx: tx.clone() },
        ];
        const results = await identity.signMultiple(requests);
        expect(results).toHaveLength(requests.length);
    });

    it("should handle empty requests", async () => {
        const identity = stubBatchIdentity();
        const results = await identity.signMultiple([]);
        expect(results).toEqual([]);
    });

    it("should pass inputIndexes through to each request", async () => {
        const receivedRequests: SignRequest[] = [];
        const identity = stubBatchIdentity(async (requests) => {
            receivedRequests.push(...requests);
            return requests.map((r) => r.tx.clone());
        });

        const tx = new Transaction();
        await identity.signMultiple([
            { tx: tx.clone(), inputIndexes: [0, 2] },
            { tx: tx.clone() },
        ]);

        expect(receivedRequests[0].inputIndexes).toEqual([0, 2]);
        expect(receivedRequests[1].inputIndexes).toBeUndefined();
    });

    it("should preserve request order in results", async () => {
        const markers: string[] = [];
        const identity = stubBatchIdentity(async (requests) => {
            return requests.map((r, i) => {
                markers.push(`signed-${i}`);
                return r.tx.clone();
            });
        });

        const tx = new Transaction();
        await identity.signMultiple([
            { tx: tx.clone() },
            { tx: tx.clone() },
            { tx: tx.clone() },
        ]);

        expect(markers).toEqual(["signed-0", "signed-1", "signed-2"]);
    });
});
