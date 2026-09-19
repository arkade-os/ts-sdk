import { describe, expect, it } from "vitest";
import { getNormalizedVtxos, normalizeVtxo } from "../src/wallet/vtxo";
import type { GetVtxosOptions, IndexerProvider, PageResponse } from "../src/providers/indexer";
import type { ExtendedVirtualCoin, VirtualCoin } from "../src/wallet";
import type { WalletRepository } from "../src/repositories/walletRepository";

const MINIMAL_COIN: VirtualCoin = {
    txid: "11".repeat(32),
    vout: 0,
    value: 1000,
    status: { confirmed: true },
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    isUnrolled: false,
    script: "51".repeat(17),
};

class MinimalIndexerProvider {
    async getVtxos(
        _opts?: GetVtxosOptions,
    ): Promise<{ vtxos: VirtualCoin[]; page?: PageResponse }> {
        return { vtxos: [MINIMAL_COIN] };
    }
}

class MinimalWalletRepository {
    readonly version = 2 as const;
    async getVtxos(_address: string): Promise<ExtendedVirtualCoin[]> {
        return [MINIMAL_COIN as ExtendedVirtualCoin];
    }
    async saveVtxos(_address: string, _vtxos: ExtendedVirtualCoin[]): Promise<void> {}
}

describe("public VTXO construction shape", () => {
    it("a custom IndexerProvider may omit optional canonical facts", async () => {
        const provider: Pick<IndexerProvider, "getVtxos"> = new MinimalIndexerProvider();
        const { vtxos } = await getNormalizedVtxos(provider);
        expect(vtxos[0].isSwept).toBe(false);
        expect(vtxos[0].isPreconfirmed).toBe(false);
        expect(vtxos[0].isSpent).toBe(false);
    });

    it("a custom WalletRepository still satisfies the read/write surface", async () => {
        const repo: Pick<WalletRepository, "getVtxos" | "saveVtxos" | "version"> =
            new MinimalWalletRepository();
        const loaded = await repo.getVtxos("ark1x");
        await repo.saveVtxos("ark1x", [normalizeVtxo(loaded[0])]);
        expect(normalizeVtxo(loaded[0]).commitmentTxIds).toEqual([]);
    });

    it("normalization populates every always-determinable fact", () => {
        const n = normalizeVtxo(MINIMAL_COIN);
        expect(n.isSwept).toBe(false);
        expect(n.isPreconfirmed).toBe(false);
        expect(n.isSpent).toBe(false);
        expect(n.commitmentTxIds).toEqual([]);
        expect(n.spentBy).toBe("");
    });

    it("leaves genuinely optional facts absent when they do not apply", () => {
        const n = normalizeVtxo(MINIMAL_COIN);
        expect(n.expiresAt).toBeUndefined();
        expect(n.expiresAtHeight).toBeUndefined();
        expect(n.settledBy).toBeUndefined();
    });

    it("egress is projection-free: the normalized coin is the public coin", () => {
        const n = normalizeVtxo(MINIMAL_COIN);
        const asPublic: VirtualCoin = n;
        expect(asPublic.spentBy).toBe("");
        expect(asPublic.commitmentTxIds).toEqual([]);
    });
});
