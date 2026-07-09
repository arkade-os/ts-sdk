import { describe, it, expect } from "vitest";
import {
    Wallet,
    ReadonlyWallet,
    InMemoryWalletRepository,
    InMemoryContractRepository,
    ProviderUnavailableError,
    isRetryableProviderError,
    type ArkProvider,
    type IndexerProvider,
    type OnchainProvider,
} from "../src";
import type { ArkInfo } from "../src/providers/ark";
import { FetchError } from "../src/utils/fetch";
import { ReadonlySingleKey } from "../src/identity/singleKey";
import { SingleKey } from "../src/identity/singleKey";
import {
    ARK_INFO_SNAPSHOT_KEY,
    MalformedArkInfoSnapshotError,
    hydrateArkInfo,
    loadArkInfoSnapshot,
    parseStoredArkInfoSnapshot,
    resolveArkInfo,
    saveArkInfoSnapshot,
    saveValidatedArkInfoSnapshot,
    serializeArkInfoSnapshot,
} from "../src/wallet/arkInfoSnapshot";

// 33-byte compressed key (setupWalletConfig slices the parity byte off).
const serverKeyHex = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const privKeyHex = "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";

function makeArkInfo(overrides: Partial<ArkInfo> = {}): ArkInfo {
    return {
        boardingExitDelay: 144n,
        checkpointTapscript:
            "5ab27520e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
        deprecatedSigners: [{ cutoffDate: 1_700_000_000n, pubkey: "02" + "ab".repeat(32) }],
        digest: "digest-abc",
        dust: 1000n,
        fees: { intentFee: { offchainInput: "1", onchainOutput: "2" }, txFeeRate: "3" },
        forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
        forfeitPubkey: serverKeyHex,
        network: "mutinynet",
        scheduledSession: {
            duration: 10n,
            fees: { intentFee: {}, txFeeRate: "0" },
            nextEndTime: 20n,
            nextStartTime: 15n,
            period: 30n,
        },
        serviceStatus: { round: "ok" },
        sessionDuration: 3600n,
        signerPubkey: serverKeyHex,
        unilateralExitDelay: 144n,
        utxoMaxAmount: -1n,
        utxoMinAmount: 0n,
        version: "1.2.3",
        vtxoMaxAmount: -1n,
        vtxoMinAmount: 0n,
        ...overrides,
    };
}

describe("serializeArkInfoSnapshot / hydrateArkInfo", () => {
    it("round-trips every field except serviceStatus (reset to {})", () => {
        const info = makeArkInfo();
        const snapshot = serializeArkInfoSnapshot(info, 111);
        const hydrated = hydrateArkInfo(snapshot);
        expect(hydrated).toEqual({ ...info, serviceStatus: {} });
    });

    it("produces a JSON-safe snapshot (no bigints survive)", () => {
        const snapshot = serializeArkInfoSnapshot(makeArkInfo(), 111);
        expect(() => JSON.stringify(snapshot)).not.toThrow();
        // bigints are stringified
        expect(snapshot.arkInfo.unilateralExitDelay).toBe("144");
        expect(snapshot.arkInfo.utxoMaxAmount).toBe("-1");
        expect(snapshot.arkInfo.deprecatedSigners[0].cutoffDate).toBe("1700000000");
        expect(snapshot.arkInfo.scheduledSession?.period).toBe("30");
        expect(snapshot.version).toBe(1);
        expect(snapshot.savedAt).toBe(111);
        expect(snapshot.source).toBe("arkade.getInfo");
    });

    it("round-trips when scheduledSession is absent", () => {
        const info = makeArkInfo({ scheduledSession: undefined });
        const hydrated = hydrateArkInfo(serializeArkInfoSnapshot(info, 1));
        expect(hydrated.scheduledSession).toBeUndefined();
        expect(hydrated).toEqual({ ...info, serviceStatus: {} });
    });
});

describe("parseStoredArkInfoSnapshot", () => {
    it("accepts a well-formed snapshot", () => {
        const snapshot = serializeArkInfoSnapshot(makeArkInfo(), 1);
        expect(parseStoredArkInfoSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    });

    it.each([
        ["non-object", 42],
        ["wrong version", { version: 2 }],
        ["missing savedAt", { version: 1, source: "arkade.getInfo", arkInfo: {} }],
        ["wrong source", { version: 1, savedAt: 1, source: "x", arkInfo: {} }],
    ])("rejects %s", (_label, raw) => {
        expect(() => parseStoredArkInfoSnapshot(raw)).toThrow(MalformedArkInfoSnapshotError);
    });

    it("rejects a non-decimal bigint field", () => {
        const snapshot = serializeArkInfoSnapshot(makeArkInfo(), 1);
        (snapshot.arkInfo as any).dust = "not-a-number";
        expect(() => parseStoredArkInfoSnapshot(snapshot)).toThrow(MalformedArkInfoSnapshotError);
    });

    it("rejects a missing string field", () => {
        const snapshot = serializeArkInfoSnapshot(makeArkInfo(), 1);
        delete (snapshot.arkInfo as any).signerPubkey;
        expect(() => parseStoredArkInfoSnapshot(snapshot)).toThrow(MalformedArkInfoSnapshotError);
    });

    it("rejects a malformed deprecatedSigners entry", () => {
        const snapshot = serializeArkInfoSnapshot(makeArkInfo(), 1);
        (snapshot.arkInfo as any).deprecatedSigners = [{ pubkey: "02ab" }];
        expect(() => parseStoredArkInfoSnapshot(snapshot)).toThrow(MalformedArkInfoSnapshotError);
    });

    it("rejects a malformed scheduledSession", () => {
        const snapshot = serializeArkInfoSnapshot(makeArkInfo(), 1);
        (snapshot.arkInfo.scheduledSession as any).period = 30; // number, not decimal string
        expect(() => parseStoredArkInfoSnapshot(snapshot)).toThrow(MalformedArkInfoSnapshotError);
    });
});

describe("loadArkInfoSnapshot / saveArkInfoSnapshot", () => {
    it("returns null when nothing has been persisted", async () => {
        const repo = new InMemoryWalletRepository();
        expect(await loadArkInfoSnapshot(repo)).toBeNull();
    });

    it("round-trips through the repository", async () => {
        const repo = new InMemoryWalletRepository();
        const info = makeArkInfo();
        await saveArkInfoSnapshot(repo, info, 999);
        const loaded = await loadArkInfoSnapshot(repo);
        expect(loaded).toEqual(serializeArkInfoSnapshot(info, 999));
    });

    it("preserves unrelated settings keys", async () => {
        const repo = new InMemoryWalletRepository();
        await repo.saveWalletState({ settings: { hasPendingTx: true }, lastSyncTime: 42 });
        await saveArkInfoSnapshot(repo, makeArkInfo(), 1);
        const state = await repo.getWalletState();
        expect(state?.settings?.hasPendingTx).toBe(true);
        expect(state?.lastSyncTime).toBe(42);
        expect(state?.settings?.[ARK_INFO_SNAPSHOT_KEY]).toBeDefined();
    });

    it("throws terminally when the stored snapshot is malformed", async () => {
        const repo = new InMemoryWalletRepository();
        await repo.saveWalletState({ settings: { [ARK_INFO_SNAPSHOT_KEY]: { version: 2 } } });
        await expect(loadArkInfoSnapshot(repo)).rejects.toThrow(MalformedArkInfoSnapshotError);
    });
});

describe("resolveArkInfo", () => {
    const live = (info: ArkInfo) => ({ getInfo: async () => info });
    const failing = (err: unknown) => ({
        getInfo: async () => {
            throw err;
        },
    });

    it("returns live info WITHOUT writing the cache (persistence is deferred)", async () => {
        const repo = new InMemoryWalletRepository();
        const info = makeArkInfo();
        const resolved = await resolveArkInfo(live(info), repo);
        expect(resolved.source).toBe("live");
        expect(resolved.info).toEqual(info);
        // resolve must not persist — that only happens post-validation.
        expect(await loadArkInfoSnapshot(repo)).toBeNull();
    });

    it("falls back to the cached snapshot on a retryable failure", async () => {
        const repo = new InMemoryWalletRepository();
        const info = makeArkInfo();
        await saveArkInfoSnapshot(repo, info, 700);
        const resolved = await resolveArkInfo(
            failing(new ProviderUnavailableError("arkade", "503")),
            repo,
        );
        expect(resolved.source).toBe("cache");
        expect(resolved.info).toEqual({ ...info, serviceStatus: {} });
    });

    it("treats a transport FetchError as retryable", async () => {
        const repo = new InMemoryWalletRepository();
        await saveArkInfoSnapshot(repo, makeArkInfo(), 1);
        const resolved = await resolveArkInfo(
            failing(new FetchError("Network request failed", { url: "x" })),
            repo,
        );
        expect(resolved.source).toBe("cache");
    });

    it("throws a typed unavailable error on retryable failure with no cache", async () => {
        const repo = new InMemoryWalletRepository();
        await expect(
            resolveArkInfo(failing(new ProviderUnavailableError("arkade", "503")), repo),
        ).rejects.toBeInstanceOf(ProviderUnavailableError);
    });

    it("propagates a terminal failure unchanged (no cache fallback)", async () => {
        const repo = new InMemoryWalletRepository();
        await saveArkInfoSnapshot(repo, makeArkInfo(), 1); // cache present, but must be ignored
        const terminal = new Error("400 bad request");
        await expect(resolveArkInfo(failing(terminal), repo)).rejects.toBe(terminal);
    });

    it("surfaces a malformed cache as terminal on retryable failure", async () => {
        const repo = new InMemoryWalletRepository();
        await repo.saveWalletState({ settings: { [ARK_INFO_SNAPSHOT_KEY]: { version: 9 } } });
        await expect(
            resolveArkInfo(failing(new ProviderUnavailableError("arkade", "503")), repo),
        ).rejects.toThrow(MalformedArkInfoSnapshotError);
    });
});

describe("saveValidatedArkInfoSnapshot", () => {
    it("persists the snapshot", async () => {
        const repo = new InMemoryWalletRepository();
        const info = makeArkInfo();
        await saveValidatedArkInfoSnapshot(repo, info, 321);
        expect(await loadArkInfoSnapshot(repo)).toEqual(serializeArkInfoSnapshot(info, 321));
    });

    it("swallows storage failures (best-effort — must not fail boot)", async () => {
        const repo = new InMemoryWalletRepository();
        repo.saveWalletState = async () => {
            throw new Error("disk full");
        };
        await expect(saveValidatedArkInfoSnapshot(repo, makeArkInfo(), 1)).resolves.toBeUndefined();
    });
});

describe("isRetryableProviderError", () => {
    it("classifies unavailable + transport errors as retryable, others terminal", () => {
        expect(isRetryableProviderError(new ProviderUnavailableError("indexer", "x"))).toBe(true);
        expect(isRetryableProviderError(new FetchError("x", { url: "y" }))).toBe(true);
        expect(isRetryableProviderError(new Error("400"))).toBe(false);
        expect(isRetryableProviderError(new MalformedArkInfoSnapshotError("x"))).toBe(false);
    });
});

describe("wallet boot: cache fallback derives identical construction metadata", () => {
    const readonlyIdentity = async () =>
        ReadonlySingleKey.fromPublicKey(await SingleKey.fromHex(privKeyHex).compressedPublicKey());

    const indexerStub = () =>
        ({
            subscribeForScripts: async () => "sub-1",
            unsubscribeForScripts: async () => undefined,
            getSubscription: async function* () {},
        }) as Partial<IndexerProvider> as IndexerProvider;

    async function createWallet(
        getInfo: ArkProvider["getInfo"],
        repos: {
            walletRepository: InMemoryWalletRepository;
            contractRepository: InMemoryContractRepository;
        },
    ) {
        return ReadonlyWallet.create({
            identity: await readonlyIdentity(),
            arkServerUrl: "http://localhost:7070",
            arkProvider: { getInfo } as Partial<ArkProvider> as ArkProvider,
            indexerProvider: indexerStub(),
            onchainProvider: {} as OnchainProvider,
            storage: repos,
        });
    }

    it("online boot marks source=live and persists a snapshot; offline boot reuses it", async () => {
        const repos = {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        };
        const info = makeArkInfo();

        const online = await createWallet(async () => info, repos);
        expect(online.serverInfoSource).toBe("live");
        const onlineAddress = online.arkAddress.encode();

        // Operator now unreachable → construct from the snapshot written above.
        const offline = await createWallet(async () => {
            throw new ProviderUnavailableError("arkade", "operator down");
        }, repos);
        expect(offline.serverInfoSource).toBe("cache");
        expect(offline.arkAddress.encode()).toBe(onlineAddress);
        expect(offline.network).toEqual(online.network);
        expect(offline.dustAmount).toBe(online.dustAmount);
    });

    it("fails with the typed unavailable error when offline with no cache", async () => {
        const repos = {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        };
        await expect(
            createWallet(async () => {
                throw new ProviderUnavailableError("arkade", "operator down");
            }, repos),
        ).rejects.toBeInstanceOf(ProviderUnavailableError);
    });

    it("keeps network validation terminal even on the cached path", async () => {
        const repos = {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        };
        // Seed a cached snapshot for an unsupported network.
        await saveArkInfoSnapshot(repos.walletRepository, makeArkInfo({ network: "bogusnet" }), 1);
        await expect(
            createWallet(async () => {
                throw new ProviderUnavailableError("arkade", "operator down");
            }, repos),
        ).rejects.toThrow(/Unsupported network/);
    });

    it("does NOT cache a live response that fails construction validation", async () => {
        const repos = {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        };
        // Live getInfo succeeds but returns an unsupported network, so
        // construction throws after resolveArkInfo returned. The cache must
        // stay empty — a terminal live response must never poison it.
        await expect(
            createWallet(async () => makeArkInfo({ network: "bogusnet" }), repos),
        ).rejects.toThrow(/Unsupported network/);
        expect(await loadArkInfoSnapshot(repos.walletRepository)).toBeNull();
    });

    it("full Wallet.create does not cache a live response with invalid checkpoint metadata", async () => {
        const walletRepository = new InMemoryWalletRepository();
        const contractRepository = new InMemoryContractRepository();
        // Network/signer pass in setupWalletConfig, but Wallet.create parses
        // checkpointTapscript later and throws — the cache must stay empty.
        await expect(
            Wallet.create({
                identity: SingleKey.fromHex(privKeyHex),
                arkServerUrl: "http://localhost:7070",
                arkProvider: {
                    getInfo: async () => makeArkInfo({ checkpointTapscript: "zz" }),
                } as Partial<ArkProvider> as ArkProvider,
                indexerProvider: indexerStub(),
                onchainProvider: {} as OnchainProvider,
                storage: { walletRepository, contractRepository },
            }),
        ).rejects.toThrow(/checkpointTapscript/);
        expect(await loadArkInfoSnapshot(walletRepository)).toBeNull();
    });
});
