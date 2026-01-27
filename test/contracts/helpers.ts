import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
    ContractVtxo,
    DefaultContractHandler,
    DefaultVtxo,
    ExtendedVirtualCoin,
    IndexerProvider,
    VirtualCoin,
} from "../../src";
import { hex } from "@scure/base";

// Mock IndexerProvider
export const createMockIndexerProvider = (): IndexerProvider => ({
    getVtxoTree: vi.fn(),
    getVtxoTreeLeaves: vi.fn(),
    getBatchSweepTransactions: vi.fn(),
    getCommitmentTx: vi.fn(),
    getCommitmentTxConnectors: vi.fn(),
    getCommitmentTxForfeitTxs: vi.fn(),
    getSubscription: vi.fn(),
    getVirtualTxs: vi.fn(),
    getVtxoChain: vi.fn(),
    getVtxos: vi.fn().mockResolvedValue({ vtxos: [] }),
    subscribeForScripts: vi.fn().mockResolvedValue("mock-subscription-id"),
    unsubscribeForScripts: vi.fn().mockResolvedValue(undefined),
});

// Test keys for creating valid contracts
export const TEST_PUB_KEY = new Uint8Array(32).fill(1);
export const TEST_SERVER_PUB_KEY = new Uint8Array(32).fill(2);

// Helper to create valid default contract params
export const createDefaultContractParams = () =>
    DefaultContractHandler.serializeParams({
        pubKey: TEST_PUB_KEY,
        serverPubKey: TEST_SERVER_PUB_KEY,
        csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
    });

// Create a valid default contract script
export const testDefaultScript = new DefaultVtxo.Script({
    pubKey: TEST_PUB_KEY,
    serverPubKey: TEST_SERVER_PUB_KEY,
});
export const TEST_DEFAULT_SCRIPT = hex.encode(testDefaultScript.pkScript);

// Helper to create a mock VTXO
export const createMockVtxo = (
    overrides: Partial<VirtualCoin> = {}
): VirtualCoin => ({
    txid: hex.encode(new Uint8Array(32).fill(1)),
    vout: 0,
    value: 100000,
    status: { confirmed: true },
    virtualStatus: { state: "settled" },
    createdAt: new Date(),
    isUnrolled: false,
    isSpent: false,
    ...overrides,
});

// Helper to create a mock ExtendedVirtualCoin
export const createMockExtendedVtxo = (
    overrides: Partial<ExtendedVirtualCoin> = {}
): ExtendedVirtualCoin =>
    ({
        ...createMockVtxo(),
        forfeitTapLeafScript: [new Uint8Array(32), new Uint8Array(33)],
        intentTapLeafScript: [new Uint8Array(32), new Uint8Array(34)],
        tapTree: new Uint8Array(64),
        ...overrides,
    }) as ExtendedVirtualCoin;

// Helper to create a mock ContractVtxo
export const createMockContractVtxo = (
    contractId: string,
    overrides: Partial<ContractVtxo> = {}
): ContractVtxo => ({
    ...createMockExtendedVtxo(),
    contractId,
    ...overrides,
});
