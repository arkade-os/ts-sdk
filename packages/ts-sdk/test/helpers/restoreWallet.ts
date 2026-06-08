import { vi } from "vitest";
import {
    Wallet,
    MnemonicIdentity,
    SingleKey,
    InMemoryWalletRepository,
    InMemoryContractRepository,
} from "../../src";
import type { IndexerProvider } from "../../src/providers/indexer";
import type { OnchainProvider } from "../../src/providers/onchain";
import type { VirtualCoin } from "../../src";
import { HDDescriptorProvider } from "../../src/wallet/hdDescriptorProvider";

/**
 * Test harness for the `Wallet.restore()` suite.
 *
 * Mirrors the construction pattern in `test/walletHdRotation.test.ts`
 * (in-memory repos, the standard test mnemonic, mocked `fetch` for the
 * ark `/info` + subscribe calls, mocked `EventSource`) but injects the
 * `indexerProvider` and `onchainProvider` directly via `Wallet.create`
 * config so a test can declare exactly which scripts the indexer reports
 * as "used" (drives both the discovery scan and the inline VTXO pull).
 */

const TEST_MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const SINGLEKEY_HEX = "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";

const SERVER_PUBKEY_HEX = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

const mockArkInfo = {
    signerPubkey: SERVER_PUBKEY_HEX,
    forfeitPubkey: SERVER_PUBKEY_HEX,
    batchExpiry: BigInt(144),
    unilateralExitDelay: BigInt(144),
    boardingExitDelay: BigInt(144),
    roundInterval: BigInt(144),
    network: "mutinynet",
    dust: BigInt(1000),
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    checkpointTapscript:
        "5ab27520e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
};

/**
 * Install the shared `fetch` / `EventSource` stubs used by every wallet
 * built through this harness. The ark provider still resolves its
 * `/info` over `fetch`; the indexer and onchain providers are injected
 * objects, so `fetch` only ever needs to answer `/info` + subscribe.
 *
 * Call from a `beforeEach`; pair with {@link teardownRestoreHarness} in
 * `afterEach`.
 */
export function installRestoreHarness(): void {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
        const reply = (body: unknown) =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve(body),
            });
        if (url.includes("/info")) return reply(mockArkInfo);
        if (url.includes("subscribe") || url.includes("subscriptions"))
            return reply({ subscriptionId: "sub-1" });
        return reply([]);
    });
    const MockEventSource = vi.fn().mockImplementation((url: string) => ({
        url,
        onmessage: null,
        onerror: null,
        close: vi.fn(),
    }));
    vi.stubGlobal("fetch", mockFetch);
    vi.stubGlobal("EventSource", MockEventSource);
}

export function teardownRestoreHarness(): void {
    vi.unstubAllGlobals();
}

/**
 * Monotonic counter so every {@link makeVtxo} call yields a distinct
 * outpoint even for the same `script` — a constant txid/vout would make
 * multiple mocked VTXOs collide/dedupe and silently understate balances.
 */
let vtxoCounter = 0;

/**
 * Derive a deterministic, unique 64-hex txid from `script` + an
 * incrementing counter. FNV-1a over the seed string, then expand the
 * 32-bit digest into 32 bytes so the result is always a valid
 * lowercase-hex txid string.
 */
function uniqueTxid(script: string): string {
    const seed = `${script}:${vtxoCounter++}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    let txid = "";
    for (let b = 0; b < 32; b++) {
        h ^= b;
        h = Math.imul(h, 0x01000193) >>> 0;
        txid += (h & 0xff).toString(16).padStart(2, "0");
    }
    return txid;
}

/** A settled, unspent, confirmed VTXO of `value` sats locked by `script`. */
function makeVtxo(script: string, value: number): VirtualCoin {
    return {
        txid: uniqueTxid(script),
        vout: 0,
        value,
        status: { confirmed: true },
        createdAt: new Date(),
        script,
        isUnrolled: false,
        isSpent: false,
        virtualStatus: { state: "settled" },
    };
}

/**
 * Controllable mock indexer.
 *
 * `getVtxos({ scripts })` returns one settled VTXO for every requested
 * script present in `usedScripts` — this is the single signal both the
 * discovery scan (`Discoverable.discoverAt`) and the inline
 * `refreshVtxos` pull read off. `getVtxos({ outpoints })` is always
 * empty. The remaining `IndexerProvider` surface is stubbed because the
 * restore path never touches it.
 *
 * `getVtxosCalls` counts the `scripts`-shaped probes so a test can
 * assert the scan ran exactly once when calls coalesce.
 */
export interface MockIndexer extends IndexerProvider {
    usedScripts: Set<string>;
    getVtxosCalls: { scripts: string[] }[];
}

function makeMockIndexer(usedScripts: Set<string>): MockIndexer {
    const getVtxosCalls: { scripts: string[] }[] = [];
    const indexer = {
        usedScripts,
        getVtxosCalls,
        async getVtxos(opts?: { scripts?: string[]; outpoints?: unknown[] }) {
            const scripts = opts?.scripts;
            if (!scripts) return { vtxos: [] };
            getVtxosCalls.push({ scripts });
            const vtxos = scripts.filter((s) => usedScripts.has(s)).map((s) => makeVtxo(s, 50_000));
            return { vtxos };
        },
        async getAssetDetails() {
            throw new Error("getAssetDetails not used by restore");
        },
        async subscribeForScripts() {
            return "sub-1";
        },
        async unsubscribeForScripts() {
            /* no-op */
        },
        // Idle stream: never emits, resolves when the watcher aborts.
        // Mirrors the MockEventSource (never fires onmessage) used by
        // test/walletHdRotation.test.ts so the watcher stays quiet and
        // the restore path drives discovery via getVtxos alone.
        async *getSubscription(_subscriptionId: string, abortSignal: AbortSignal) {
            await new Promise<void>((resolve) => {
                if (abortSignal.aborted) return resolve();
                abortSignal.addEventListener("abort", () => resolve(), {
                    once: true,
                });
            });
        },
        async getVtxoTree() {
            throw new Error("getVtxoTree not used by restore");
        },
        async getVtxoTreeLeaves() {
            throw new Error("getVtxoTreeLeaves not used by restore");
        },
        async getBatchSweepTransactions() {
            throw new Error("getBatchSweepTransactions not used by restore");
        },
        async getCommitmentTx() {
            throw new Error("getCommitmentTx not used by restore");
        },
        async getVirtualTxs() {
            throw new Error("getVirtualTxs not used by restore");
        },
    } as unknown as MockIndexer;
    return indexer;
}

/**
 * Mock onchain provider. `fundedOnchain` is the set of on-chain (P2TR)
 * addresses the provider reports as holding an unspent coin — the single
 * signal the boarding discovery probe (`OnchainProvider.getCoins`) reads.
 * Empty by default (no boarding funds), so existing restore tests are
 * unaffected.
 */
function makeMockOnchain(fundedOnchain: Set<string> = new Set()): OnchainProvider {
    return {
        async getCoins(address: string) {
            if (!fundedOnchain.has(address)) return [];
            return [
                {
                    txid: uniqueTxid(address),
                    vout: 0,
                    value: 25_000,
                    status: { confirmed: true },
                },
            ];
        },
        async getTxOutspends() {
            return [];
        },
        async getTransactions() {
            return [];
        },
        async getTxStatus() {
            return { confirmed: false };
        },
        async getChainTip() {
            return { height: 0, hash: "", time: 0 };
        },
        async broadcastTransaction() {
            throw new Error("broadcastTransaction not used by restore");
        },
        async watchAddresses() {
            return () => {
                /* no-op unsubscribe */
            };
        },
    } as unknown as OnchainProvider;
}

export interface RestoreWalletHandle {
    wallet: Wallet;
    indexer: MockIndexer;
    /** On-chain (P2TR) addresses the mock onchain provider reports as funded. */
    fundedOnchain: Set<string>;
    walletRepository: InMemoryWalletRepository;
    contractRepository: InMemoryContractRepository;
}

/**
 * Build a static / non-HD wallet (SingleKey identity → no descriptor
 * provider). `usedScripts` is the set of pkScripts the mock indexer
 * treats as having on-chain history; pass the wallet's
 * `defaultContractScript` after construction to model a funded baseline.
 */
export async function makeStaticWalletForTest(
    usedScripts: Set<string> = new Set(),
    fundedOnchain: Set<string> = new Set(),
): Promise<RestoreWalletHandle> {
    const indexer = makeMockIndexer(usedScripts);
    const walletRepository = new InMemoryWalletRepository();
    const contractRepository = new InMemoryContractRepository();
    const wallet = await Wallet.create({
        identity: SingleKey.fromHex(SINGLEKEY_HEX),
        walletMode: "static",
        arkServerUrl: "http://localhost:7070",
        indexerProvider: indexer,
        onchainProvider: makeMockOnchain(fundedOnchain),
        storage: { walletRepository, contractRepository },
    });
    return { wallet, indexer, fundedOnchain, walletRepository, contractRepository };
}

export interface HdRestoreWalletHandle extends RestoreWalletHandle {
    hdProvider: HDDescriptorProvider;
}

/**
 * Build an HD-mode wallet on the standard test mnemonic. Returns the
 * resolved {@link HDDescriptorProvider} (the wallet's private
 * `_descriptorProvider`) so a test can drive
 * `materializeDescriptorAt(i)` to discover which pkScript a funded HD
 * index maps to and assert the post-restore watermark.
 */
export async function makeHdWalletForTest(
    usedScripts: Set<string> = new Set(),
    fundedOnchain: Set<string> = new Set(),
): Promise<HdRestoreWalletHandle> {
    const indexer = makeMockIndexer(usedScripts);
    const walletRepository = new InMemoryWalletRepository();
    const contractRepository = new InMemoryContractRepository();
    const wallet = await Wallet.create({
        identity: MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
            isMainnet: false,
        }),
        walletMode: "hd",
        arkServerUrl: "http://localhost:7070",
        indexerProvider: indexer,
        onchainProvider: makeMockOnchain(fundedOnchain),
        storage: { walletRepository, contractRepository },
    });
    const resolved = (wallet as unknown as { _descriptorProvider?: unknown })._descriptorProvider;
    if (
        !resolved ||
        typeof (resolved as Partial<HDDescriptorProvider>).materializeDescriptorAt !== "function" ||
        typeof (resolved as Partial<HDDescriptorProvider>).advanceLastIndexUsed !== "function"
    ) {
        throw new Error(
            "makeHdWalletForTest: expected wallet._descriptorProvider to be an " +
                "HDDescriptorProvider exposing materializeDescriptorAt/" +
                "advanceLastIndexUsed — wallet internals may have changed.",
        );
    }
    const hdProvider = resolved as HDDescriptorProvider;
    return {
        wallet,
        indexer,
        fundedOnchain,
        walletRepository,
        contractRepository,
        hdProvider,
    };
}
