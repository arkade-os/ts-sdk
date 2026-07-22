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
import type { ReadonlyWalletConfig } from "../src";
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
    opts?: {
        getInfo?: ArkProvider["getInfo"];
        storage?: Storage;
        contractManagerConfig?: ReadonlyWalletConfig["contractManagerConfig"];
    },
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
        // Boarding reads stay network-backed (a different provider, out of the
        // offline-first scope); stubbed empty so they don't mask the assertions.
        onchainProvider: {
            getCoins: async () => [],
            getTransactions: async () => [],
        } as Partial<OnchainProvider> as OnchainProvider,
        storage: opts?.storage ?? freshStorage(),
        contractManagerConfig: opts?.contractManagerConfig,
    });
}

describe("background sweep is wallet-configurable", () => {
    // Reads no longer sync, so the sweep is what keeps the repository fresh —
    // an embedder that can't reach the knob can't tune or disable it.
    const sweepInterval = async (wallet: ReadonlyWallet) => {
        const manager = (await wallet.getContractManager()) as unknown as {
            config: { periodicSyncIntervalMs?: number };
        };
        return manager.config.periodicSyncIntervalMs;
    };

    it("defaults to the ContractManager default when unset", async () => {
        expect(await sweepInterval(await createWallet(healthyIndexer()))).toBeUndefined();
    });

    it("forwards an explicit interval", async () => {
        const wallet = await createWallet(healthyIndexer(), {
            contractManagerConfig: { periodicSyncIntervalMs: 5_000 },
        });
        expect(await sweepInterval(wallet)).toBe(5_000);
    });

    it("forwards a zero interval, disabling the sweep", async () => {
        const wallet = await createWallet(healthyIndexer(), {
            contractManagerConfig: { periodicSyncIntervalMs: 0 },
        });
        expect(await sweepInterval(wallet)).toBe(0);
    });
});

describe("wallet offline-first reads (Scope 4)", () => {
    it("getVtxos returns repository state instead of throwing when the indexer is down", async () => {
        const wallet = await createWallet(downIndexer());
        await expect(wallet.getVtxos()).resolves.toEqual([]);
    });

    // The invariant from AGENTS.md: reads come from repositories only. Asserted
    // against an indexer whose every offchain call is terminal — a read that
    // touches it at all propagates the failure rather than resolving.
    describe("read paths never query the indexer", () => {
        const deadIndexer = () =>
            ({
                getVtxos: async () => {
                    throw new Error("schema violation");
                },
                subscribeForScripts: async () => "sub-1",
                unsubscribeForScripts: async () => undefined,
                getSubscription: async function* () {},
            }) as Partial<IndexerProvider> as IndexerProvider;

        // Boot syncs once (ContractManager.initialize), so the manager has to be
        // up before the indexer turns terminal — otherwise construction throws
        // and the test proves nothing about the read itself.
        const bootedWallet = async () => {
            const indexer = healthyIndexer();
            const wallet = await createWallet(indexer);
            await wallet.getContractManager();
            Object.assign(indexer, deadIndexer());
            return wallet;
        };

        it("getVtxos", async () => {
            await expect((await bootedWallet()).getVtxos()).resolves.toEqual([]);
        });

        it("getTransactionHistory", async () => {
            await expect((await bootedWallet()).getTransactionHistory()).resolves.toEqual([]);
        });

        // Seeded with a deprecated signer so it gets past its empty fast-path
        // and actually reaches the contract read.
        it("pendingRecoveryOutpoints", async () => {
            const indexer = healthyIndexer();
            const wallet = await createWallet(indexer, {
                getInfo: async () => ({
                    ...arkInfo(),
                    deprecatedSigners: [{ pubkey: serverKeyHex, cutoffDate: 1n }],
                }),
            });
            await wallet.getContractManager();
            Object.assign(indexer, deadIndexer());

            await expect(wallet.pendingRecoveryOutpoints()).resolves.toEqual(new Set());
        });
    });

    it("reads return repository state even when the indexer holds different data", async () => {
        const indexer = healthyIndexer();
        const wallet = await createWallet(indexer);
        const manager = await wallet.getContractManager();
        const [contract] = await manager.getContracts();

        // The indexer now reports funds the repository has never seen. A
        // repository-only read must not surface them; only an explicit
        // refresh may.
        indexer.getVtxos = async () => ({
            vtxos: [
                {
                    txid: "a".repeat(64),
                    vout: 0,
                    value: 21_000,
                    script: contract.script,
                    createdAt: new Date(),
                    isPreconfirmed: false,
                    isSwept: false,
                    isUnrolled: false,
                    isSpent: false,
                },
            ],
        });

        await expect(wallet.getVtxos()).resolves.toEqual([]);

        await manager.refreshVtxos();
        expect(await wallet.getVtxos()).toHaveLength(1);
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

    // Reads are repository-only, so they no longer report on the indexer at
    // all; the boot sync inside the manager's lazy initialization does.
    it("reports degraded on indexer/repository once a sync hits a down indexer", async () => {
        const wallet = await createWallet(downIndexer());
        // The contract manager isn't initialized until first used.
        expect(wallet.getProviderConnectionState().mode).toBe("online");

        await wallet.getContractManager();
        expect(wallet.getProviderConnectionState()).toMatchObject({
            mode: "degraded",
            source: "repository",
            provider: "indexer",
        });
    });
});
