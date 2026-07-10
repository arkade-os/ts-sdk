import { describe, it, expect } from "vitest";
import {
    ReadonlyWallet,
    InMemoryWalletRepository,
    InMemoryContractRepository,
    ProviderUnavailableError,
    type ArkProvider,
    type IndexerProvider,
    type OnchainProvider,
} from "../src";
import type { ArkInfo } from "../src/providers/ark";
import { ReadonlySingleKey, SingleKey } from "../src/identity/singleKey";

const serverKeyHex = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const privKeyHex = "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";

const arkInfo = (): ArkInfo => ({
    boardingExitDelay: 144n,
    checkpointTapscript:
        "5ab27520e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
    deprecatedSigners: [],
    digest: "d",
    dust: 1000n,
    fees: { intentFee: {}, txFeeRate: "0" },
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    forfeitPubkey: serverKeyHex,
    network: "mutinynet",
    serviceStatus: {},
    sessionDuration: 3600n,
    signerPubkey: serverKeyHex,
    unilateralExitDelay: 144n,
    utxoMaxAmount: -1n,
    utxoMinAmount: 0n,
    version: "1",
    vtxoMaxAmount: -1n,
    vtxoMinAmount: 0n,
});

// Indexer with every offchain read failing as a retryable unavailable error,
// plus the watcher subscription stubs the ContractManager needs to start.
const downIndexer = () =>
    ({
        getVtxos: async () => {
            throw new ProviderUnavailableError("operator down");
        },
        subscribeForScripts: async () => "sub-1",
        unsubscribeForScripts: async () => undefined,
        getSubscription: async function* () {},
    }) as Partial<IndexerProvider> as IndexerProvider;

type Storage = {
    walletRepository: InMemoryWalletRepository;
    contractRepository: InMemoryContractRepository;
};

const freshStorage = (): Storage => ({
    walletRepository: new InMemoryWalletRepository(),
    contractRepository: new InMemoryContractRepository(),
});

const healthyIndexer = () =>
    ({
        getVtxos: async () => ({ vtxos: [] }),
        subscribeForScripts: async () => "sub-1",
        unsubscribeForScripts: async () => undefined,
        getSubscription: async function* () {},
    }) as Partial<IndexerProvider> as IndexerProvider;

async function createWallet(
    indexerProvider: IndexerProvider,
    opts?: { getInfo?: ArkProvider["getInfo"]; storage?: Storage },
) {
    const identity = ReadonlySingleKey.fromPublicKey(
        await SingleKey.fromHex(privKeyHex).compressedPublicKey(),
    );
    return ReadonlyWallet.create({
        identity,
        arkServerUrl: "http://localhost:7070",
        arkProvider: {
            getInfo: opts?.getInfo ?? (async () => arkInfo()),
        } as Partial<ArkProvider> as ArkProvider,
        indexerProvider,
        onchainProvider: {} as OnchainProvider,
        storage: opts?.storage ?? freshStorage(),
    });
}

describe("wallet offline-first reads (Scope 4)", () => {
    it("getVtxos returns repository state instead of throwing when the indexer is down", async () => {
        const wallet = await createWallet(downIndexer());
        await expect(wallet.getVtxos()).resolves.toEqual([]);
    });

    it("getVtxos still rethrows a terminal (non-retryable) indexer failure", async () => {
        const indexer = {
            getVtxos: async () => {
                throw new Error("schema violation");
            },
            subscribeForScripts: async () => "sub-1",
            unsubscribeForScripts: async () => undefined,
            getSubscription: async function* () {},
        } as Partial<IndexerProvider> as IndexerProvider;
        const wallet = await createWallet(indexer);
        await expect(wallet.getVtxos()).rejects.toThrow("schema violation");
    });
});

describe("provider connection state (Scope 5)", () => {
    it("reports online when booted live with a healthy indexer", async () => {
        const wallet = await createWallet(healthyIndexer());
        const state = wallet.getProviderConnectionState();
        expect(state).toMatchObject({ mode: "online", source: "live" });
        expect(typeof state.lastOnlineAt).toBe("number");
    });

    it("reports degraded on arkade/cache when booted from a cached snapshot", async () => {
        const storage = freshStorage();
        // An online boot persists the snapshot...
        await createWallet(healthyIndexer(), { storage });
        // ...then the operator is unreachable, so the next boot falls back to it.
        const offline = await createWallet(healthyIndexer(), {
            storage,
            getInfo: async () => {
                throw new ProviderUnavailableError("operator down");
            },
        });
        expect(offline.getProviderConnectionState()).toMatchObject({
            mode: "degraded",
            source: "cache",
            provider: "arkade",
        });
    });

    it("reports degraded on indexer/repository after a read hits a down indexer", async () => {
        const wallet = await createWallet(downIndexer());
        // The contract manager isn't initialized until the first read.
        expect(wallet.getProviderConnectionState().mode).toBe("online");

        await wallet.getVtxos();
        expect(wallet.getProviderConnectionState()).toMatchObject({
            mode: "degraded",
            source: "repository",
            provider: "indexer",
        });
    });
});
