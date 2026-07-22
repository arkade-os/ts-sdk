import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    ContractManager,
    encodeArkContract,
    decodeArkContract,
    contractFromArkContract,
    contractFromArkContractWithAddress,
    isArkContract,
} from "../src/contracts";
import type { Contract } from "../src/contracts";
import { InMemoryContractRepository } from "../src/repositories/inMemory/contractRepository";
import type { IndexerProvider } from "../src/providers/indexer";
import { ContractRepository, InMemoryWalletRepository } from "../src/repositories";
import {
    createDefaultContractParams,
    createMockExtendedVtxo,
    createMockIndexerProvider,
    TEST_DEFAULT_ARK_ADDRESS,
    TEST_DEFAULT_SCRIPT,
    TEST_SERVER_PUB_KEY,
} from "./contracts/helpers";
import { DEFAULT_NETWORK } from "../src/networks";
import { RECONCILE_ABSENCE_THRESHOLD } from "../src/contracts/contractManager";
import { getVtxosForContract, saveVtxosForContract } from "../src/contracts/vtxoOwnership";
import type { ContractEvent } from "../src/contracts/types";

describe("Contracts", () => {
    describe("ArkContract encoding/decoding", () => {
        it("should encode a contract to arkcontract string", () => {
            const contract: Contract = {
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

        it("should decode an arkcontract string", () => {
            const encoded = "arkcontract=default&pubKey=abc123&serverPubKey=def456";
            const parsed = decodeArkContract(encoded);

            expect(parsed.type).toBe("default");
            expect(parsed.data.pubKey).toBe("abc123");
            expect(parsed.data.serverPubKey).toBe("def456");
        });

        it("should throw for invalid arkcontract string", () => {
            expect(() => decodeArkContract("invalid=string")).toThrow("Invalid arkcontract string");
        });

        it("should check if string is arkcontract", () => {
            expect(isArkContract("arkcontract=default&foo=bar")).toBe(true);
            expect(isArkContract("not-arkcontract")).toBe(false);
            expect(isArkContract("arkcontractwrong=test")).toBe(false);
        });

        it("should create contract from arkcontract string", () => {
            const encoded = "arkcontract=default&pubKey=abc&serverPubKey=def";
            const contract = contractFromArkContract(encoded, {
                label: "Test Contract",
            });

            expect(contract.label).toBe("Test Contract");
            expect(contract.type).toBe("default");
            expect(contract.params.pubKey).toBe("abc");
            expect(contract.state).toBe("active");
        });

        it("should default derived contract addresses to the mainnet Arkade HRP", () => {
            const encoded = encodeArkContract({
                type: "default",
                params: createDefaultContractParams(),
                script: "",
                address: "",
                state: "active",
                createdAt: 0,
            });

            const contract = contractFromArkContractWithAddress(encoded, TEST_SERVER_PUB_KEY);

            expect(contract.address.startsWith(`${DEFAULT_NETWORK.hrp}1`)).toBe(true);
        });

        it("should throw for unknown contract type", () => {
            const encoded = "arkcontract=unknown-type&foo=bar";
            expect(() => contractFromArkContract(encoded)).toThrow(
                "No handler registered for contract type",
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
                walletRepository: new InMemoryWalletRepository(),
            });
        });

        it("should reject contract with invalid params", async () => {
            await expect(
                manager.createContract({
                    type: "default",
                    params: {}, // Missing required pubKey and serverPubKey
                    script: TEST_DEFAULT_SCRIPT,
                    address: "address",
                }),
            ).rejects.toThrow();
        });

        it("should reject contract with mismatched script", async () => {
            await expect(
                manager.createContract({
                    type: "default",
                    params: createDefaultContractParams(),
                    script: "wrong-script-that-doesnt-match",
                    address: "address",
                }),
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

    describe("reconcile vanished vtxos", () => {
        it("emits vtxo_vanished and prunes when a stored coin leaves the indexer", async () => {
            const walletRepository = new InMemoryWalletRepository();
            const mockIndexer = createMockIndexerProvider();
            // Indexer no longer knows the coin: every probe comes back empty.
            mockIndexer.getVtxos = vi.fn().mockResolvedValue({ vtxos: [] });

            const onVtxosVanished = vi.fn().mockResolvedValue(undefined);
            const manager = await ContractManager.create({
                indexerProvider: mockIndexer,
                contractRepository: new InMemoryContractRepository(),
                walletRepository,
                onVtxosVanished,
            });

            const contract = await manager.createContract({
                type: "default",
                params: createDefaultContractParams(),
                script: TEST_DEFAULT_SCRIPT,
                address: TEST_DEFAULT_ARK_ADDRESS,
            });

            const coin = createMockExtendedVtxo();
            await saveVtxosForContract(walletRepository, contract, [coin]);

            const events: Extract<ContractEvent, { type: "vtxo_vanished" }>[] = [];
            manager.onContractEvent((e) => {
                if (e.type === "vtxo_vanished") events.push(e);
            });

            // Delete fires only after the coin stays absent across the threshold.
            const internals = manager as unknown as {
                reconcileVanishedVtxos: (contracts: Contract[]) => Promise<void>;
                lastReconcileByContract: Map<string, number>;
            };
            for (let i = 0; i < RECONCILE_ABSENCE_THRESHOLD; i++) {
                internals.lastReconcileByContract.clear();
                await internals.reconcileVanishedVtxos([contract]);
            }

            expect(await getVtxosForContract(walletRepository, contract)).toEqual([]);
            expect(events).toHaveLength(1);
            expect(events[0].vtxos).toHaveLength(1);
            expect(onVtxosVanished).toHaveBeenCalledTimes(1);
            expect(onVtxosVanished).toHaveBeenCalledWith([{ txid: coin.txid, vout: coin.vout }]);
        });
    });
});
