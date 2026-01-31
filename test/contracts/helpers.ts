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

// Valid secp256k1 x-only public keys for testing
// These are the generator point (G) and 2G
export const TEST_PUB_KEY_HEX =
    "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
export const TEST_SERVER_PUB_KEY_HEX =
    "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

// Uint8Array versions for script creation
export const TEST_PUB_KEY = hex.decode(TEST_PUB_KEY_HEX);
export const TEST_SERVER_PUB_KEY = hex.decode(TEST_SERVER_PUB_KEY_HEX);

// Helper to create valid default contract params (using descriptors)
export const createDefaultContractParams = () =>
    DefaultContractHandler.serializeParams({
        pubKey: `tr(${TEST_PUB_KEY_HEX})`,
        serverPubKey: `tr(${TEST_SERVER_PUB_KEY_HEX})`,
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
    contractScript: string,
    overrides: Partial<ContractVtxo> = {}
): ContractVtxo => ({
    ...createMockExtendedVtxo(),
    contractScript,
    ...overrides,
});
