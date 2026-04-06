import { describe, expect, it } from "vitest";
import {
    verifyCheckpointTransactions,
    verifyCheckpointTimelocks,
} from "../../src/verification/checkpointVerifier";
import { ChainTxType, type ChainTx } from "../../src/providers/indexer";
import type { RelativeTimelock } from "../../src/script/tapscript";

const sweepInterval = {
    value: 144n,
    type: "blocks",
} as RelativeTimelock;

describe("verifyCheckpointTransactions", () => {
    it("accepts a checkpoint integrated between parent and child", () => {
        const chain: ChainTx[] = [
            {
                txid: "aa".repeat(32),
                type: ChainTxType.COMMITMENT,
                expiresAt: "",
                spends: [],
            },
            {
                txid: "cp".repeat(32),
                type: ChainTxType.CHECKPOINT,
                expiresAt: "2099-01-01T00:00:00Z",
                spends: ["aa".repeat(32)],
            },
            {
                txid: "bb".repeat(32),
                type: ChainTxType.ARK,
                expiresAt: "",
                spends: ["cp".repeat(32)],
            },
        ];

        const [result] = verifyCheckpointTransactions(chain, sweepInterval);

        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it("rejects a checkpoint that has no child integration in the DAG", () => {
        const chain: ChainTx[] = [
            {
                txid: "aa".repeat(32),
                type: ChainTxType.COMMITMENT,
                expiresAt: "",
                spends: [],
            },
            {
                txid: "cp".repeat(32),
                type: ChainTxType.CHECKPOINT,
                expiresAt: "2099-01-01T00:00:00Z",
                spends: ["aa".repeat(32)],
            },
        ];

        const [result] = verifyCheckpointTransactions(chain, sweepInterval);

        expect(result.valid).toBe(false);
        expect(
            result.errors.some((error) =>
                /not integrated into the DAG/i.test(error)
            )
        ).toBe(true);
    });

    it("rejects a checkpoint with multiple parents", () => {
        const chain: ChainTx[] = [
            {
                txid: "aa".repeat(32),
                type: ChainTxType.COMMITMENT,
                expiresAt: "",
                spends: [],
            },
            {
                txid: "bb".repeat(32),
                type: ChainTxType.COMMITMENT,
                expiresAt: "",
                spends: [],
            },
            {
                txid: "cp".repeat(32),
                type: ChainTxType.CHECKPOINT,
                expiresAt: "2099-01-01T00:00:00Z",
                spends: ["aa".repeat(32), "bb".repeat(32)],
            },
            {
                txid: "cc".repeat(32),
                type: ChainTxType.ARK,
                expiresAt: "",
                spends: ["cp".repeat(32)],
            },
        ];

        const [result] = verifyCheckpointTransactions(chain, sweepInterval);

        expect(result.valid).toBe(false);
        expect(
            result.errors.some((error) => /multiple parents/i.test(error))
        ).toBe(true);
    });
});

describe("verifyCheckpointTimelocks", () => {
    it("warns when checkpoint expiry metadata is missing", () => {
        const result = verifyCheckpointTimelocks(
            {
                txid: "cp".repeat(32),
                type: ChainTxType.CHECKPOINT,
                expiresAt: "",
                spends: ["aa".repeat(32)],
            },
            sweepInterval
        );

        expect(result.valid).toBe(true);
        expect(
            result.warnings.some((warning) =>
                /missing expiry metadata/i.test(warning)
            )
        ).toBe(true);
    });

    it("warns when checkpoint expiry is already past", () => {
        const result = verifyCheckpointTimelocks(
            {
                txid: "cp".repeat(32),
                type: ChainTxType.CHECKPOINT,
                expiresAt: "2020-01-01T00:00:00Z",
                spends: ["aa".repeat(32)],
            },
            sweepInterval
        );

        expect(result.valid).toBe(true);
        expect(
            result.warnings.some((warning) => /has expired/i.test(warning))
        ).toBe(true);
    });

    it("rejects invalid expiry timestamps", () => {
        const result = verifyCheckpointTimelocks(
            {
                txid: "cp".repeat(32),
                type: ChainTxType.CHECKPOINT,
                expiresAt: "not-a-date",
                spends: ["aa".repeat(32)],
            },
            sweepInterval
        );

        expect(result.valid).toBe(false);
        expect(
            result.errors.some((error) =>
                /invalid expiry timestamp/i.test(error)
            )
        ).toBe(true);
    });
});
