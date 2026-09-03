import { base64, hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { InMemoryVirtualTxRepository } from "../src/repositories/inMemory/virtualTxRepository";
import { ChainedTxType } from "../src/repositories/virtualTxRepository";
import { Transaction } from "../src/utils/transaction";
import { RepositoryExitDataSource } from "../src/wallet/exit/repositorySource";

// A PSBT spending `parentTxid:0`, so `spends` can be derived from its inputs.
function psbtSpending(parentTxid: string): string {
    const t = new Transaction({ version: 2 });
    t.addInput({
        txid: hex.decode(parentTxid),
        index: 0,
        witnessUtxo: { script: hex.decode("0014" + "00".repeat(20)), amount: 1000n },
    });
    return base64.encode(t.toPSBT());
}

describe("RepositoryExitDataSource", () => {
    it("Full: reconstructs the chain with spends derived from stored PSBTs", async () => {
        const repo = new InMemoryVirtualTxRepository();
        const root = "aa".repeat(32);
        const leafPsbt = psbtSpending(root);
        const leafTxid = Transaction.fromPSBT(base64.decode(leafPsbt)).id;
        await repo.upsertVirtualTxs([
            { txid: root, psbt: null, expiresAt: null, type: ChainedTxType.Commitment },
            { txid: leafTxid, psbt: leafPsbt, expiresAt: 1234, type: ChainedTxType.Ark },
        ]);
        await repo.setBranch({ txid: "bb".repeat(32), vout: 0 }, [
            { vtxoTxid: "bb".repeat(32), vtxoVout: 0, virtualTxid: root, position: 0 },
            { vtxoTxid: "bb".repeat(32), vtxoVout: 0, virtualTxid: leafTxid, position: 1 },
        ]);

        const source = new RepositoryExitDataSource(repo);
        const chain = await source.getVtxoChain({ txid: "bb".repeat(32), vout: 0 });
        expect(chain).not.toBeNull();
        const leaf = chain!.find((c) => c.txid === leafTxid)!;
        expect(leaf.spends).toEqual([root]); // derived from the PSBT input
        expect(leaf.type).toBe("INDEXER_CHAINED_TX_TYPE_ARK");
    });

    it("Lite: returns null when a non-commitment tx has no PSBT (structure miss)", async () => {
        const repo = new InMemoryVirtualTxRepository();
        await repo.upsertVirtualTxs([
            { txid: "cc".repeat(32), psbt: null, expiresAt: null, type: ChainedTxType.Ark },
        ]);
        await repo.setBranch({ txid: "dd".repeat(32), vout: 0 }, [
            { vtxoTxid: "dd".repeat(32), vtxoVout: 0, virtualTxid: "cc".repeat(32), position: 0 },
        ]);
        const source = new RepositoryExitDataSource(repo);
        expect(await source.getVtxoChain({ txid: "dd".repeat(32), vout: 0 })).toBeNull();
    });

    it("returns null for an unknown vtxo (empty branch)", async () => {
        const source = new RepositoryExitDataSource(new InMemoryVirtualTxRepository());
        expect(await source.getVtxoChain({ txid: "ee".repeat(32), vout: 0 })).toBeNull();
    });

    it("getVirtualTxs returns only stored PSBTs, keyed by txid", async () => {
        const repo = new InMemoryVirtualTxRepository();
        await repo.upsertVirtualTxs([
            { txid: "ff".repeat(32), psbt: "storedpsbt", expiresAt: null, type: ChainedTxType.Ark },
        ]);
        const source = new RepositoryExitDataSource(repo);
        const got = await source.getVirtualTxs(["ff".repeat(32), "99".repeat(32)]);
        expect(got.get("ff".repeat(32))).toBe("storedpsbt");
        expect(got.has("99".repeat(32))).toBe(false);
    });
});
