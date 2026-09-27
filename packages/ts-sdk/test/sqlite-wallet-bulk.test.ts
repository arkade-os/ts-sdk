import { describe, expect, it } from "vitest";
import { TaprootControlBlock } from "@scure/btc-signer";
import { createNodeSQLExecutor } from "../../../config/test-helpers/nodeSqlExecutor";
import { SQLiteWalletRepository } from "../src/repositories/sqlite/walletRepository";
import { createMockExtendedVtxo } from "./contracts/helpers";

describe("SQLiteWalletRepository.getVtxosForScripts", () => {
    it("returns only matching rows across the SQLite parameter limit", async () => {
        const repository = new SQLiteWalletRepository(createNodeSQLExecutor());
        const scripts = Array.from(
            { length: 501 },
            (_, i) => "5120" + i.toString(16).padStart(64, "0"),
        );
        const leaf = [
            TaprootControlBlock.decode(new Uint8Array([0xc0, ...new Uint8Array(32)])),
            new Uint8Array([0x51]),
        ] as const;
        const rows = [scripts[0], scripts[500], "5120" + "ff".repeat(32)].map((script, i) =>
            createMockExtendedVtxo({
                txid: i.toString(16).padStart(64, "0"),
                vout: 0,
                script,
                forfeitTapLeafScript: leaf,
                intentTapLeafScript: leaf,
            }),
        );
        rows.push(
            createMockExtendedVtxo({
                ...rows[0],
                txid: "03".padStart(64, "0"),
                isSpent: true,
            }),
            createMockExtendedVtxo({
                ...rows[0],
                txid: "04".padStart(64, "0"),
                spentBy: "spent",
            }),
            createMockExtendedVtxo({
                ...rows[0],
                txid: "05".padStart(64, "0"),
                settledBy: "settled",
            }),
        );
        await repository.saveVtxos("address", rows);

        expect(await repository.getVtxosForScripts([])).toEqual([]);
        const result = await repository.getVtxosForScripts(scripts);
        expect(result).toHaveLength(5);
        const live = await repository.getVtxosForScripts(scripts, { nonterminalOnly: true });
        expect(live.map((row) => row.script)).toEqual([scripts[0], scripts[500]]);
    });
});
