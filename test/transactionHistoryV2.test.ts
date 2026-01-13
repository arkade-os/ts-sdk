// Data from https://mempool.space/api/address/bc1pzrrt7tfu7erym9la035da9488swnkxhvv9fqrlmrtxfzfkqckmtqyfu4k9/txs
import { describe, it, expect } from "vitest";
import transactionHistoryProgressive from "./fixtures/transaction_history-progressive.json";
import { transactionHistoryV2 } from "../src/utils/transactionHistoryV2";
import { ArkTransaction, VirtualCoin } from "../src";

describe("transactionHistoryV2", () => {
    const t = Array.from(transactionHistoryProgressive.entries());
    const { vtxos, expected, allBoardingTxs, commitmentsToIgnore } = t[0][1];

    it("excludes all boarding transactions in the 'commitments to ignore' list", async () => {
        const result = transactionHistoryV2(
            [],
            allBoardingTxs as ArkTransaction[],
            new Set(commitmentsToIgnore)
        );
        expect(result.map((_) => [_.amount, _.tag])).toStrictEqual([
            [979, "boarding"],
            [1743, "boarding"],
            [2323, "boarding"],
            [1307, "boarding"],
            [1965, "boarding"],
            [1200, "boarding"],
            [500, "boarding"],
            [903, "boarding"],
        ]);
    });

    it("excludes all boarding transactions in the 'commitments to ignore' list", async () => {
        const result = transactionHistoryV2(
            vtxos.map((_) => ({
                ..._,
                createdAt: new Date(_.createdAt),
            })) as VirtualCoin[],
            allBoardingTxs as ArkTransaction[],
            new Set(commitmentsToIgnore)
        );
        expect(result.map((_) => [_.amount, _.tag, _.type])).toStrictEqual([
            [499, "offchain", "RECEIVED"],
            [374, "offchain", "SENT"],
            [979, "boarding", "RECEIVED"],
            [734, "exit", "SENT"],
            [1743, "boarding", "RECEIVED"],
            [2323, "boarding", "RECEIVED"],
            [980, "offchain", "RECEIVED"],
            [991, "offchain", "SENT"],
            [1307, "boarding", "RECEIVED"],
            [1965, "boarding", "RECEIVED"],
            [1924, "offchain", "SENT"],
            [1443, "offchain", "SENT"],
            [1063, "offchain", "SENT"],
            [1118, "offchain", "RECEIVED"],
            [1100, "offchain", "RECEIVED"],
            [4055, "offchain", "SENT"],
            [1299, "offchain", "RECEIVED"],
            [1200, "boarding", "RECEIVED"],
            [500, "boarding", "RECEIVED"],
            [1107, "offchain", "SENT"],
            [903, "boarding", "RECEIVED"],
            [1000, "exit", "SENT"],
            [1000, "offchain", "SENT"],
            [300, "offchain", "RECEIVED"],
            [1500, "offchain", "RECEIVED"],
        ]);
    });
});
