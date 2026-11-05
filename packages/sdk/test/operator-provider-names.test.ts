import { describe, expect, it, vi } from "vitest";
import {
    CachingArkProvider,
    CachingOperatorProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    RestOperatorProvider,
    SingleKey,
    Wallet,
    type IndexerProvider,
    type OperatorProvider,
} from "../src";
import { ExpoArkProvider, ExpoOperatorProvider } from "../src/adapters/expo";

describe("deprecated operator provider names", () => {
    it("point at the new classes", () => {
        expect(RestArkProvider).toBe(RestOperatorProvider);
        expect(CachingArkProvider).toBe(CachingOperatorProvider);
        expect(ExpoArkProvider).toBe(ExpoOperatorProvider);
    });
});

describe("Wallet.create provider key", () => {
    const identity = SingleKey.fromRandomBytes();
    const provider = { getInfo: vi.fn() } as unknown as OperatorProvider;
    const storage = {
        walletRepository: new InMemoryWalletRepository(),
        contractRepository: new InMemoryContractRepository(),
    };

    it("reads operatorProvider", async () => {
        await expect(
            Wallet.create({ identity, operatorProvider: provider, storage }),
        ).rejects.toThrow(/indexerProvider is required when operatorProvider is provided/);
    });

    it("makes its boot read through operatorProvider", async () => {
        const stop = new Error("stop");
        const getInfo = vi.fn().mockRejectedValue(stop);
        await expect(
            Wallet.create({
                identity,
                operatorProvider: { getInfo } as unknown as OperatorProvider,
                indexerProvider: {} as IndexerProvider,
                storage,
            }),
        ).rejects.toBe(stop);
        expect(getInfo).toHaveBeenCalledOnce();
    });

    it("rejects both spellings", async () => {
        await expect(
            Wallet.create({ identity, operatorProvider: provider, arkProvider: provider, storage }),
        ).rejects.toThrow("Pass either `operatorProvider` or `arkProvider`, not both");
    });

    it("rejects operatorProvider beside service", async () => {
        await expect(
            Wallet.create({
                identity,
                operatorProvider: provider,
                service: { network: "bitcoin" },
                storage,
            }),
        ).rejects.toThrow("Pass either `service` or");
    });
});
