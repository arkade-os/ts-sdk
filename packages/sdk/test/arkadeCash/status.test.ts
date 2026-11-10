import { describe, expect, it } from "vitest";
import { classifyArkadeCash } from "../../src/arkadeCash/status";
import type { VirtualCoin } from "../../src/wallet";

const live = (): VirtualCoin => ({
    txid: "a".repeat(64),
    vout: 0,
    value: 5_000,
    script: "51".repeat(34),
    createdAt: new Date(),
    status: { confirmed: false },
    isUnrolled: false,
});

describe("classifyArkadeCash", () => {
    it("returns public correlation metadata, not a bearer instrument", () => {
        const result = classifyArkadeCash([live()], 1_000n, { timestamp: new Date() });
        expect(result).toEqual({
            status: "available",
            amount: 5_000,
            issues: [{ txid: "a".repeat(64), amount: 5_000 }],
            claims: [],
        });
        expect("token" in result).toBe(false);
    });

    it("recognizes server-swept funds still awaiting recovery", () => {
        expect(
            classifyArkadeCash([{ ...live(), isSwept: true }], 1_000n, { timestamp: new Date() })
                .status,
        ).toBe("recovering");
    });

    it("uses a height threshold for a block timelock", () => {
        const coin = { ...live(), expiresAtHeight: 510 };
        expect(
            classifyArkadeCash(
                [coin],
                1_000n,
                { timestamp: new Date(), height: 500 },
                { blocks: 144 },
            ).status,
        ).toBe("available");
        expect(
            classifyArkadeCash(
                [coin],
                1_000n,
                { timestamp: new Date(), height: 510 },
                { blocks: 144 },
            ).status,
        ).toBe("exitable");
    });

    it("keeps a signer-expired voucher unavailable until it is swept", () => {
        expect(
            classifyArkadeCash([live()], 1_000n, { timestamp: new Date() }, undefined, true).status,
        ).toBe("expired");
    });

    it("prefers unspent exited funds over spent claim evidence", () => {
        const exited = { ...live(), txid: "b".repeat(64), isUnrolled: true };
        const spent = { ...live(), txid: "c".repeat(64), isSpent: true };
        expect(classifyArkadeCash([spent, exited], 1_000n, { timestamp: new Date() }).status).toBe(
            "exited",
        );
    });

    it("reports a spent, exited coin as claimed", () => {
        expect(
            classifyArkadeCash([{ ...live(), isUnrolled: true, isSpent: true }], 1_000n, {
                timestamp: new Date(),
            }).status,
        ).toBe("claimed");
    });

    it("groups coins by funding transaction and by spending transaction", () => {
        const funding = (vout: number, value: number, arkTxId?: string): VirtualCoin => ({
            ...live(),
            vout,
            value,
            isSpent: arkTxId !== undefined,
            arkTxId,
        });
        const result = classifyArkadeCash(
            [
                funding(0, 3_000, "s".repeat(64)),
                funding(1, 2_000, "s".repeat(64)),
                funding(2, 4_000, "t".repeat(64)),
                { ...funding(0, 1_500), txid: "b".repeat(64) },
            ],
            1_000n,
            { timestamp: new Date() },
        );
        expect(result.issues).toEqual([
            { txid: "a".repeat(64), amount: 9_000 },
            { txid: "b".repeat(64), amount: 1_500 },
        ]);
        expect(result.claims).toEqual([
            { txid: "s".repeat(64), amount: 5_000 },
            { txid: "t".repeat(64), amount: 4_000 },
        ]);
    });
});
