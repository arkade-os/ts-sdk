import { describe, it, expect } from "vitest";
import { isBatchSignable, BatchSignableIdentity, SignRequest, Identity } from "../src/identity";
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

function stubBatchIdentity(): BatchSignableIdentity {
    const base = stubIdentity();
    return {
        ...base,
        signMultiple: async (requests: SignRequest[]) => requests.map((r) => r.tx.clone()),
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
