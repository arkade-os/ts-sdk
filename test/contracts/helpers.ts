import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
    ContractVtxo,
    DefaultContractHandler,
    DelegateContractHandler,
    DefaultVtxo,
    DelegateVtxo,
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
// Real-looking x-only pubkey (needed for 3-key multisig in DelegateVtxo)
export const TEST_DELEGATE_PUB_KEY = hex.decode(
    "f8352deebdf5658d95875d89656112b1dd150f176c702eea4f91a91527e48e26"
);

// Helper to create valid default contract params
export const createDefaultContractParams = () =>
    DefaultContractHandler.serializeParams({
        pubKey: TEST_PUB_KEY,
        serverPubKey: TEST_SERVER_PUB_KEY,
        csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
    });

// Helper to create valid delegate contract params
export const createDelegateContractParams = () =>
    DelegateContractHandler.serializeParams({
        pubKey: TEST_PUB_KEY,
        serverPubKey: TEST_SERVER_PUB_KEY,
        delegatePubKey: TEST_DELEGATE_PUB_KEY,
        csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
    });

// Create a valid default contract script
export const testDefaultScript = new DefaultVtxo.Script({
    pubKey: TEST_PUB_KEY,
    serverPubKey: TEST_SERVER_PUB_KEY,
});
export const TEST_DEFAULT_SCRIPT = hex.encode(testDefaultScript.pkScript);

// Create a valid delegate contract script
export const testDelegateScript = new DelegateVtxo.Script({
    pubKey: TEST_PUB_KEY,
    serverPubKey: TEST_SERVER_PUB_KEY,
    delegatePubKey: TEST_DELEGATE_PUB_KEY,
});
export const TEST_DELEGATE_SCRIPT = hex.encode(testDelegateScript.pkScript);

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
    contractScript: string,
    overrides: Partial<ContractVtxo> = {}
): ContractVtxo => ({
    ...createMockExtendedVtxo(),
    contractScript,
    ...overrides,
});
