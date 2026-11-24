import { describe, expect, it } from "vitest";
import { ContractManager, InMemoryContractRepository, InMemoryWalletRepository } from "../../src";
import { isOnchainScoped, scopeOf } from "../../src/contracts/scope";
import type { Contract } from "../../src/contracts/types";
import { createMockIndexerProvider } from "./helpers";

const base = { params: {}, script: "51", address: "a", state: "active", createdAt: 0 } as const;

describe("contract scope", () => {
    it("defaults from the handler", () => {
        expect(scopeOf({ ...base, type: "boarding" } as Contract)).toBe("onchain");
        expect(scopeOf({ ...base, type: "default" } as Contract)).toBe("offchain");
        expect(scopeOf({ ...base, type: "unknown-type" } as Contract)).toBe("offchain");
    });

    it("explicit scope wins", () => {
        expect(scopeOf({ ...base, type: "vhtlc", scope: "both" } as Contract)).toBe("both");
    });

    it("ContractManager.getContracts filters by scope", async () => {
        const contractRepository = new InMemoryContractRepository();
        await contractRepository.saveContract({ ...base, type: "boarding", script: "5101" });
        await contractRepository.saveContract({ ...base, type: "default", script: "5102" });
        const manager = await ContractManager.create({
            indexerProvider: createMockIndexerProvider(),
            contractRepository,
            walletRepository: new InMemoryWalletRepository(),
        });

        const onchain = await manager.getContracts({ scope: "onchain" });

        expect(onchain.map((c) => c.script)).toEqual(["5101"]);
        manager.dispose();
    });

    it("isOnchainScoped", () => {
        expect(isOnchainScoped({ ...base, type: "boarding" } as Contract)).toBe(true);
        expect(isOnchainScoped({ ...base, type: "default", scope: "both" } as Contract)).toBe(true);
        expect(isOnchainScoped({ ...base, type: "default" } as Contract)).toBe(false);
    });
});
