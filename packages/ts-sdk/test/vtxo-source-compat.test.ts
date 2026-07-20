import { describe, expect, it } from "vitest";
import { getNormalizedVtxos, normalizeVtxo } from "../src/wallet/vtxo";
import type { GetVtxosOptions, IndexerProvider, PageResponse } from "../src/providers/indexer";
import type { ExtendedVirtualCoin, VirtualCoin } from "../src/wallet";
import type { WalletRepository } from "../src/repositories/walletRepository";

/**
 * `IndexerProvider` and `WalletRepository` are public interfaces, so `VirtualCoin` sits in
 * *construction* position: a consumer's implementation predates the canonical facts and must keep
 * compiling without supplying them. That is what forces the facts to be optional on the public
 * type — and what the normalization boundary exists to make safe.
 *
 * These are compile-time assertions first: if the canonical facts ever become required on
 * `VirtualCoin`, this file stops typechecking, which is the point.
 */

const LEGACY_COIN: VirtualCoin = {
    txid: "11".repeat(32),
    vout: 0,
    value: 1000,
    status: { confirmed: true },
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    isUnrolled: false,
    script: "51".repeat(17),
    // No isSwept / isPreconfirmed / commitmentTxIds / expiresAt / spentBy — a pre-canonical coin.
    virtualStatus: { state: "swept", commitmentTxIds: ["22".repeat(32)], batchExpiry: undefined },
};

/** A custom provider written before this pass existed. */
class LegacyIndexerProvider {
    async getVtxos(
        _opts?: GetVtxosOptions,
    ): Promise<{ vtxos: VirtualCoin[]; page?: PageResponse }> {
        return { vtxos: [LEGACY_COIN] };
    }
}

/** A custom repository written before this pass existed. */
class LegacyWalletRepository {
    readonly version = 2 as const;
    async getVtxos(_address: string): Promise<ExtendedVirtualCoin[]> {
        return [LEGACY_COIN as ExtendedVirtualCoin];
    }
    async saveVtxos(_address: string, _vtxos: ExtendedVirtualCoin[]): Promise<void> {}
}

describe("source compatibility", () => {
    it("a legacy custom IndexerProvider still satisfies the interface", async () => {
        const provider: Pick<IndexerProvider, "getVtxos"> = new LegacyIndexerProvider();
        const { vtxos } = await getNormalizedVtxos(provider);
        expect(vtxos[0].isSwept).toBe(true);
    });

    it("a legacy custom WalletRepository still satisfies the read/write surface", async () => {
        const repo: Pick<WalletRepository, "getVtxos" | "saveVtxos" | "version"> =
            new LegacyWalletRepository();
        const loaded = await repo.getVtxos("ark1x");
        // saveVtxos accepts what the SDK now hands it: a normalized coin is a valid public coin.
        await repo.saveVtxos("ark1x", [normalizeVtxo(loaded[0])]);
        expect(normalizeVtxo(loaded[0]).isSwept).toBe(true);
    });

    it("normalized SDK output populates the always-determinable facts", () => {
        const n = normalizeVtxo(LEGACY_COIN);
        expect(n.isSwept).toBe(true);
        expect(n.isPreconfirmed).toBe(false);
        expect(n.isSpent).toBe(false);
        expect(n.commitmentTxIds).toEqual(["22".repeat(32)]);
        expect(n.spentBy).toBe("");
    });

    it("leaves the genuinely-optional facts absent when they do not apply", () => {
        // A VTXO with no expiry carries neither expiry field — absent means "no expiry", not
        // "unknown", which is why these two stay optional on the normalized shape too.
        const n = normalizeVtxo(LEGACY_COIN);
        expect(n.expiresAt).toBeUndefined();
        expect(n.expiresAtHeight).toBeUndefined();
        expect(n.settledBy).toBeUndefined();
    });

    it("egress is projection-free: the normalized coin IS the public coin", () => {
        const n = normalizeVtxo(LEGACY_COIN);
        // Assignable to the public type with no mapping step, so there is no egress projection to
        // forget.
        const asPublic: VirtualCoin = n;
        expect(asPublic.virtualStatus).toBeDefined();
        expect(asPublic.virtualStatus.state).toBe("swept");
        expect(asPublic.spentBy).toBe("");
    });
});
