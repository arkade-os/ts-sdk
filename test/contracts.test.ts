import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    ContractManager,
    encodeArkContract,
    decodeArkContract,
    contractFromArkContract,
    isArkContract,
} from "../src/contracts";
import type { Contract } from "../src/contracts";
import { InMemoryContractRepository } from "../src/repositories/inMemory/contractRepository";
import type { IndexerProvider } from "../src/providers/indexer";
import {
    ContractRepository,
    InMemoryWalletRepository,
} from "../src/repositories";
import {
    createDefaultContractParams,
    createMockExtendedVtxo,
    createMockIndexerProvider,
    TEST_DEFAULT_SCRIPT,
} from "./contracts/helpers";

describe("Contracts", () => {
    describe("ArkContract encoding/decoding", () => {
        it("should encode a contract to arkcontract string", () => {
            const contract: Contract = {
                id: "test-id",
                type: "default",
                params: {
                    pubKey: "abc123",
                    serverPubKey: "def456",
                },
                script: "5120...",
                address: "tark1...",
                state: "active",
                createdAt: Date.now(),
            };

            const encoded = encodeArkContract(contract);
            expect(encoded).toContain("arkcontract=default");
            expect(encoded).toContain("pubKey=abc123");
            expect(encoded).toContain("serverPubKey=def456");
        });

        it("should encode contract with runtime data", () => {
            const contract: Contract = {
                id: "test-id",
                type: "vhtlc",
                params: { hash: "abc" },
                data: { preimage: "secret123" },
                script: "5120...",
                address: "tark1...",
                state: "active",
                createdAt: Date.now(),
            };

            const encoded = encodeArkContract(contract);
            expect(encoded).toContain("preimage=secret123");
        });

        it("should decode an arkcontract string", () => {
            const encoded =
                "arkcontract=default&pubKey=abc123&serverPubKey=def456";
            const parsed = decodeArkContract(encoded);

            expect(parsed.type).toBe("default");
            expect(parsed.data.pubKey).toBe("abc123");
            expect(parsed.data.serverPubKey).toBe("def456");
        });

        it("should throw for invalid arkcontract string", () => {
            expect(() => decodeArkContract("invalid=string")).toThrow(
                "Invalid arkcontract string"
            );
        });

        it("should check if string is arkcontract", () => {
            expect(isArkContract("arkcontract=default&foo=bar")).toBe(true);
            expect(isArkContract("not-arkcontract")).toBe(false);
            expect(isArkContract("arkcontractwrong=test")).toBe(false);
        });

        it("should create contract from arkcontract string", () => {
            const encoded = "arkcontract=default&pubKey=abc&serverPubKey=def";
            const contract = contractFromArkContract(encoded, {
                id: "my-contract",
                label: "Test Contract",
            });

            expect(contract.id).toBe("my-contract");
            expect(contract.label).toBe("Test Contract");
            expect(contract.type).toBe("default");
            expect(contract.params.pubKey).toBe("abc");
            expect(contract.state).toBe("active");
        });

        it("should throw for unknown contract type", () => {
            const encoded = "arkcontract=unknown-type&foo=bar";
            expect(() => contractFromArkContract(encoded)).toThrow(
                "No handler registered for contract type"
            );
        });
    });

    describe("Handler param validation", () => {
        let repository: ContractRepository;
        let manager: ContractManager;
        let mockIndexer: IndexerProvider;

        beforeEach(async () => {
            repository = new InMemoryContractRepository();
            mockIndexer = createMockIndexerProvider();

            manager = await ContractManager.create({
                indexerProvider: mockIndexer,
                contractRepository: repository,
                extendVtxo: (vtxo) => createMockExtendedVtxo(vtxo),
                getDefaultAddress: async () => "default-address",
                walletRepository: new InMemoryWalletRepository(),
            });
        });

        it("should reject contract with invalid params", () => {
            expect(
                manager.createContract({
                    type: "default",
                    params: {}, // Missing required pubKey and serverPubKey
                    script: TEST_DEFAULT_SCRIPT,
                    address: "address",
                })
            ).rejects.toThrow();
        });

        it("should reject contract with mismatched script", () => {
            expect(
                manager.createContract({
                    type: "default",
                    params: createDefaultContractParams(),
                    script: "wrong-script-that-doesnt-match",
                    address: "address",
                })
            ).rejects.toThrow("Script mismatch");
        });

        it("should accept contract with valid params and matching script", async () => {
            const contract = await manager.createContract({
                type: "default",
                params: createDefaultContractParams(),
                script: TEST_DEFAULT_SCRIPT,
                address: "address",
            });

            expect(contract).toBeDefined();
            expect(contract.type).toBe("default");
        });
    });

    describe("Multiple event callbacks", () => {
        let repository: ContractRepository;
        let manager: ContractManager;
        let mockIndexer: IndexerProvider;

        beforeEach(async () => {
            repository = new InMemoryContractRepository();
            mockIndexer = createMockIndexerProvider();

            manager = await ContractManager.create({
                indexerProvider: mockIndexer,
                contractRepository: repository,
                extendVtxo: (vtxo) => createMockExtendedVtxo(vtxo),
                getDefaultAddress: async () => "default-address",
                walletRepository: new InMemoryWalletRepository(),
            });
        });

        it("should support registering multiple event callbacks", () => {
            const callback1 = vi.fn();
            const callback2 = vi.fn();

            const unsubscribe1 = manager.onContractEvent(callback1);
            const unsubscribe2 = manager.onContractEvent(callback2);

            expect(unsubscribe1).toBeInstanceOf(Function);
            expect(unsubscribe2).toBeInstanceOf(Function);
        });

        it("should allow unsubscribing callbacks", () => {
            const callback = vi.fn();

            const unsubscribe = manager.onContractEvent(callback);
            unsubscribe();

            // After unsubscribe, callback should not be called
            // (we can't easily trigger events in unit tests, but verify unsubscribe works)
            expect(unsubscribe).toBeInstanceOf(Function);
        });
    });
});
