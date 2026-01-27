import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
    ContractRepository,
    InMemoryContractRepository,
} from "../../src/repositories";
import { Contract } from "../../src";

describe("ContractRepository", () => {
    let repository: ContractRepository;

    beforeEach(() => {
        repository = new InMemoryContractRepository();
    });

    it("should save and retrieve contract", async () => {
        const contract: Contract = {
            id: "test-1",
            type: "default",
            params: {},
            script: "script-hex",
            address: "address",
            state: "active",
            createdAt: Date.now(),
        };

        await repository.saveContract(contract);
        const contracts = await repository.getContracts({ id: "test-1" });

        expect(contracts).toHaveLength(1);
        expect(contracts[0]).toEqual(contract);
    });

    it("should get contracts by state", async () => {
        const activeContract: Contract = {
            id: "active-1",
            type: "default",
            params: {},
            script: "script-1",
            address: "address-1",
            state: "active",
            createdAt: Date.now(),
        };

        const inactiveContract: Contract = {
            id: "inactive-1",
            type: "default",
            params: {},
            script: "script-2",
            address: "address-2",
            state: "inactive",
            createdAt: Date.now(),
        };

        await repository.saveContract(activeContract);
        await repository.saveContract(inactiveContract);

        const activeContracts = await repository.getContracts({
            state: "active",
        });
        const inactiveContracts = await repository.getContracts({
            state: "inactive",
        });

        expect(activeContracts).toHaveLength(1);
        expect(activeContracts[0].id).toBe("active-1");
        expect(inactiveContracts).toHaveLength(1);
        expect(inactiveContracts[0].id).toBe("inactive-1");
    });

    it("should support array filters for id, state, and type", async () => {
        const contracts: Contract[] = [
            {
                id: "multi-1",
                type: "default",
                params: {},
                script: "script-1",
                address: "address-1",
                state: "active",
                createdAt: Date.now(),
            },
            {
                id: "multi-2",
                type: "vhtlc",
                params: {},
                script: "script-2",
                address: "address-2",
                state: "inactive",
                createdAt: Date.now(),
            },
            {
                id: "multi-3",
                type: "default",
                params: {},
                script: "script-3",
                address: "address-3",
                state: "inactive",
                createdAt: Date.now(),
            },
        ];

        for (const contract of contracts) {
            await repository.saveContract(contract);
        }

        const byIds = await repository.getContracts({
            id: ["multi-1", "multi-3"],
        });
        const byStates = await repository.getContracts({
            state: ["inactive"],
        });
        const byTypes = await repository.getContracts({
            type: ["vhtlc"],
        });

        expect(byIds.map((contract) => contract.id)).toEqual([
            "multi-1",
            "multi-3",
        ]);
        expect(byStates).toHaveLength(2);
        expect(byTypes).toHaveLength(1);
        expect(byTypes[0].id).toBe("multi-2");
    });

    it("should update contract state via save", async () => {
        const contract: Contract = {
            id: "test-1",
            type: "default",
            params: {},
            script: "script-hex",
            address: "address",
            state: "active",
            createdAt: Date.now(),
        };

        await repository.saveContract(contract);

        // Update state by saving modified contract
        await repository.saveContract({ ...contract, state: "inactive" });

        const contracts = await repository.getContracts({ id: "test-1" });
        expect(contracts[0]?.state).toBe("inactive");
    });

    it("should update contract data via save", async () => {
        const contract: Contract = {
            id: "test-1",
            type: "vhtlc",
            params: { hash: "abc" },
            script: "script-hex",
            address: "address",
            state: "active",
            createdAt: Date.now(),
            data: { hashlock: "abc" },
        };

        await repository.saveContract(contract);

        // Update data by saving with merged data
        await repository.saveContract({
            ...contract,
            data: { ...contract.data, preimage: "secret" },
        });

        const contracts = await repository.getContracts({ id: "test-1" });
        expect(contracts[0]?.data).toEqual({
            hashlock: "abc",
            preimage: "secret",
        });
    });

    it("should delete contract", async () => {
        const contract: Contract = {
            id: "test-1",
            type: "default",
            params: {},
            script: "script-hex",
            address: "address",
            state: "active",
            createdAt: Date.now(),
        };

        await repository.saveContract(contract);
        await repository.deleteContract("test-1");

        const contracts = await repository.getContracts({ id: "test-1" });
        expect(contracts).toHaveLength(0);
    });

    it("should get contract by script", async () => {
        const contract: Contract = {
            id: "test-1",
            type: "default",
            params: {},
            script: "unique-script-hex",
            address: "address",
            state: "active",
            createdAt: Date.now(),
        };

        await repository.saveContract(contract);
        const contracts = await repository.getContracts({
            script: "unique-script-hex",
        });

        expect(contracts).toHaveLength(1);
        expect(contracts[0].id).toBe("test-1");
    });
});
