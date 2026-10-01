import { describe, it, expect, vi } from "vitest";
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

/** Spin until `predicate` holds, so a test never races the microtask queue. */
const until = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !predicate(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
};

const serverKeyHex = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const privKeyHex = "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";

const arkInfo = (): ArkInfo => ({
    boardingExitDelay: 144n,
    checkpointTapscript:
        "039d0440b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac",
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
    opts?: { getInfo?: ArkProvider["getInfo"]; storage?: Storage; lazyInitialization?: boolean },
) {
    const identity = ReadonlySingleKey.fromPublicKey(
        await SingleKey.fromHex(privKeyHex).compressedPublicKey(),
    );
    return ReadonlyWallet.create({
        identity,
        lazyInitialization: opts?.lazyInitialization,
        arkServerUrl: "http://localhost:7070",
        arkProvider: {
            getInfo: opts?.getInfo ?? (async () => arkInfo()),
        } as Partial<ArkProvider> as ArkProvider,
        indexerProvider,
        onchainProvider: {
            getCoins: async () => [],
            getTransactions: async () => [],
        } as unknown as OnchainProvider,
        storage: opts?.storage ?? freshStorage(),
    });
}

describe("wallet offline-first reads (Scope 4)", () => {
    it.each(["getVtxos", "getBalance", "getTransactionHistory"] as const)(
        "%s still awaits synchronization and propagates terminal errors",
        async (method) => {
            const indexer = healthyIndexer();
            const wallet = await createWallet(indexer);
            await wallet.getVtxos();
            let reject!: (error: Error) => void;
            indexer.getVtxos = vi.fn(
                () =>
                    new Promise((_, fail) => {
                        reject = fail;
                    }),
            );
            let settled = false;
            const read = wallet[method]().finally(() => {
                settled = true;
            });
            const rejected = expect(read).rejects.toThrow("schema violation");
            await until(() => !!reject);
            expect(settled).toBe(false);
            reject(new Error("schema violation"));
            await rejected;
            await wallet.dispose();
        },
    );

    it("a warm wallet can read cached coins and balance while lazy boot is parked", async () => {
        const storage = freshStorage();
        const first = await createWallet(healthyIndexer(), { storage });
        await first.getVtxos();
        await first.dispose();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const indexer = healthyIndexer();
        indexer.getVtxos = vi.fn(async () => {
            await gate;
            return { vtxos: [] };
        });
        const wallet = await createWallet(indexer, { storage, lazyInitialization: true });
        try {
            expect(await wallet.getStoredVtxos()).toEqual([]);
            expect((await wallet.getStoredBalance()).boarding.loaded).toBe(false);
            expect(wallet.getProviderConnectionState().syncing).toBe(true);
        } finally {
            release();
            await (await wallet.getContractManager()).whenBooted();
            await wallet.dispose();
        }
    });

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

    it("reports syncing while a spend read's indexer sync is in flight", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const indexer = {
            getVtxos: async () => ({ vtxos: [] }),
            subscribeForScripts: async () => "sub-1",
            unsubscribeForScripts: async () => undefined,
            getSubscription: async function* () {},
        };
        const wallet = await createWallet(indexer as Partial<IndexerProvider> as IndexerProvider);
        await wallet.getVtxos();
        await until(() => wallet.getProviderConnectionState().syncing === false);

        indexer.getVtxos = async () => {
            await gate;
            return { vtxos: [] };
        };

        const read = wallet.getSpendableVtxos();
        await until(() => wallet.getProviderConnectionState().syncing === true);
        expect(wallet.getProviderConnectionState().syncing).toBe(true);

        release();
        await read;
        expect(wallet.getProviderConnectionState().syncing).toBe(false);
    });

    it("answers an explicit stored read without waiting on the indexer", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const indexer = {
            getVtxos: async () => ({ vtxos: [] }),
            subscribeForScripts: async () => "sub-1",
            unsubscribeForScripts: async () => undefined,
            getSubscription: async function* () {},
        };
        const wallet = await createWallet(indexer as Partial<IndexerProvider> as IndexerProvider);
        await wallet.getVtxos();
        await until(() => wallet.getProviderConnectionState().syncing === false);

        indexer.getVtxos = async () => {
            await gate;
            return { vtxos: [] };
        };

        await expect(wallet.getStoredVtxos()).resolves.toEqual([]);
        expect(wallet.getProviderConnectionState().syncing).toBe(true);

        release();
        await until(() => wallet.getProviderConnectionState().syncing === false);
    });
});
