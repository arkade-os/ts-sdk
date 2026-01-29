import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
    ContractRepository,
    IndexedDBContractRepository,
    InMemoryContractRepository,
} from "../../src/repositories";
import { Contract } from "../../src";
import { RepositoryTestItem } from "../storage.test";
import { STORE_CONTRACTS } from "../../src/repositories/indexedDB/schema";

const contractRepositoryImplementations: Array<
    RepositoryTestItem<ContractRepository>
> = [
    {
        name: "InMemoryContractRepository",
        factory: async () => new InMemoryContractRepository(),
    },
    {
        name: "IndexedDBContractRepository",
        factory: async () => {
            return new IndexedDBContractRepository(STORE_CONTRACTS);
        },
    },
];

describe.each(contractRepositoryImplementations)(
    "ContractRepository: $name",
    ({ factory }) => {
        let repository: ContractRepository;

        beforeEach(async () => {
            repository = await factory();
        });

        afterEach(async () => {
            repository?.clear();
            await repository?.[Symbol.asyncDispose]();
        });

        it("should save and retrieve contract", async () => {
            const contract: Contract = {
                type: "default",
                params: {},
                script: "script-hex",
                address: "address",
                state: "active",
                createdAt: Date.now(),
            };

            await repository.saveContract(contract);
            const contracts = await repository.getContracts({
                script: "script-hex",
            });

            expect(contracts).toHaveLength(1);
            expect(contracts[0]).toEqual(contract);
        });

        it("should get contracts by state", async () => {
            const activeContract: Contract = {
                type: "default",
                params: {},
                script: "script-1",
                address: "address-1",
                state: "active",
                createdAt: Date.now(),
            };

            const inactiveContract: Contract = {
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
            expect(activeContracts[0].script).toBe("script-1");
            expect(inactiveContracts).toHaveLength(1);
            expect(inactiveContracts[0].script).toBe("script-2");
        });

        it("should support array filters for script, state, and type", async () => {
            const contracts: Contract[] = [
                {
                    type: "default",
                    params: {},
                    script: "script-1",
                    address: "address-1",
                    state: "active",
                    createdAt: Date.now(),
                },
                {
                    type: "vhtlc",
                    params: {},
                    script: "script-2",
                    address: "address-2",
                    state: "inactive",
                    createdAt: Date.now(),
                },
                {
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

            const byScripts = await repository.getContracts({
                script: ["script-1", "script-3"],
            });
            const byStates = await repository.getContracts({
                state: ["inactive"],
            });
            const byTypes = await repository.getContracts({
                type: ["vhtlc"],
            });

            expect(byScripts.map((contract) => contract.script)).toEqual([
                "script-1",
                "script-3",
            ]);
            expect(byStates).toHaveLength(2);
            expect(byTypes).toHaveLength(1);
            expect(byTypes[0].script).toBe("script-2");
        });

        it("should update contract state via save", async () => {
            const contract: Contract = {
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

            const contracts = await repository.getContracts({
                script: "script-hex",
            });
            expect(contracts[0]?.state).toBe("inactive");
        });

        it("should update contract data via save", async () => {
            const contract: Contract = {
                type: "vhtlc",
                params: { hash: "abc", hashlock: "abc" },
                script: "script-hex",
                address: "address",
                state: "active",
                createdAt: Date.now(),
                metadata: { provider: "boltz" },
            };

            await repository.saveContract(contract);

            // Update data by saving with merged data
            await repository.saveContract({
                ...contract,
                params: { ...contract.params, preimage: "secret" },
            });

            const contracts = await repository.getContracts({
                script: "script-hex",
            });
            expect(contracts[0]?.params).toEqual({
                ...contract.params,
                preimage: "secret",
            });
        });

        it("should delete contract", async () => {
            const contract: Contract = {
                type: "default",
                params: {},
                script: "script-hex",
                address: "address",
                state: "active",
                createdAt: Date.now(),
            };

            await repository.saveContract(contract);
            await repository.deleteContract("script-hex");

            const contracts = await repository.getContracts({
                script: "script-hex",
            });
            expect(contracts).toHaveLength(0);
        });

        it("should get contract by script", async () => {
            const contract: Contract = {
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
            expect(contracts[0].script).toBe("unique-script-hex");
        });
    }
);
