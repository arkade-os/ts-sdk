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
            issueTxIds: ["a".repeat(64)],
            claimTxIds: [],
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
                { height: 509 },
            ).status,
        ).toBe("available");
        expect(
            classifyArkadeCash(
                [coin],
                1_000n,
                { timestamp: new Date(), height: 504 },
                { height: 510 },
            ).status,
        ).toBe("exitable");
    });
});
