import { describe, it, expect, vi } from "vitest";
import {
    ArkadeContractHandler,
    BoardingContractHandler,
    DefaultContractHandler,
    DelegateContractHandler,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    isContractGenericallySpendable,
    ProviderUnavailableError,
    ReadonlyWallet,
    VHTLCContractHandler,
    Wallet,
    type ArkProvider,
    type Contract,
    type IndexerProvider,
    type OnchainProvider,
} from "../src";
import type { ArkInfo } from "../src/providers/ark";
import { InMemoryIntentRepository } from "../src/repositories/inMemory/intentRepository";
import { ReadonlySingleKey, SingleKey } from "../src/identity/singleKey";
import { Ramps } from "../src/wallet/ramps";
import { VtxoManager } from "../src/wallet/vtxo-manager";
import {
    createMockExtendedVtxo,
    createDefaultContractParams,
    TEST_DEFAULT_ARK_ADDRESS,
} from "./contracts/helpers";

const serverKeyHex = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const privKeyHex = "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";

const ESCROW_SCRIPT = "51200000000000000000000000000000000000000000000000000000000000000001";
const MARKED_SCRIPT = "51200000000000000000000000000000000000000000000000000000000000000002";
const UNKNOWN_SCRIPT = "51200000000000000000000000000000000000000000000000000000000000000003";
const ASSET_ID = "aa".repeat(32);

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

// Offline: every indexer read fails retryably, so `getContractsWithVtxos`
// serves the seeded repository state instead of syncing it away.
const offlineIndexer = () =>
    ({
        getVtxos: async () => {
            throw new ProviderUnavailableError("operator down");
        },
        subscribeForScripts: async () => "sub-1",
        unsubscribeForScripts: async () => undefined,
        getSubscription: async function* () {},
    }) as Partial<IndexerProvider> as IndexerProvider;

const contract = (script: string, type: string, metadata?: Record<string, unknown>): Contract => ({
    type,
    params: type === "default" ? createDefaultContractParams() : {},
    script,
    address: `addr-${script.slice(-2)}`,
    state: "active",
    createdAt: 1,
    ...(metadata ? { metadata } : {}),
});

const vtxo = (script: string, value: number, assets?: { assetId: string; amount: bigint }[]) =>
    createMockExtendedVtxo({
        txid: script.slice(-2).repeat(32),
        vout: 0,
        value,
        script,
        virtualStatus: { state: "settled" },
        ...(assets ? { assets } : {}),
    });

/**
 * A wallet holding four VTXOs: its own default one, an unmarked `arkade`
 * contract (escrow), a marked `arkade` contract, and a contract whose type has
 * no handler at all.
 */
async function seededWallet(opts?: { intents?: InMemoryIntentRepository; signing?: boolean }) {
    const walletRepository = new InMemoryWalletRepository();
    const contractRepository = new InMemoryContractRepository();

    const rows = [
        contract(ESCROW_SCRIPT, "arkade"),
        contract(MARKED_SCRIPT, "arkade", { genericallySpendable: true }),
        contract(UNKNOWN_SCRIPT, "not-a-registered-type"),
    ];
    for (const row of rows) {
        await contractRepository.saveContract(row);
        await walletRepository.saveVtxos(row.address, [
            vtxo(row.script, 10_000, [{ assetId: ASSET_ID, amount: 5n }]),
        ]);
    }

    const config = {
        arkServerUrl: "http://localhost:7070",
        arkProvider: { getInfo: async () => arkInfo() } as Partial<ArkProvider> as ArkProvider,
        indexerProvider: offlineIndexer(),
        onchainProvider: {
            getCoins: async () => [],
            getTransactions: async () => [],
            getTxOutspends: async () => [],
        } as Partial<OnchainProvider> as OnchainProvider,
        storage: {
            walletRepository,
            contractRepository,
            ...(opts?.intents ? { intentRepository: opts.intents } : {}),
        },
    };

    const identity = SingleKey.fromHex(privKeyHex);
    const wallet = opts?.signing
        ? await Wallet.create({ ...config, identity })
        : await ReadonlyWallet.create({
              ...config,
              identity: ReadonlySingleKey.fromPublicKey(await identity.compressedPublicKey()),
          });

    // The wallet's own receive contract, funded, as the control.
    const defaultScript = wallet.defaultContractScript;
    await walletRepository.saveVtxos(await wallet.getAddress(), [
        vtxo(defaultScript, 40_000, [{ assetId: ASSET_ID, amount: 7n }]),
    ]);

    return { wallet, defaultScript, walletRepository, contractRepository };
}

const scriptsOf = (vtxos: { script: string }[]) => vtxos.map((v) => v.script).sort();

describe("ContractHandler.isGenericallySpendable", () => {
    it("answers true for every built-in wallet-owned type", () => {
        const row = contract("s", "default");
        expect(DefaultContractHandler.isGenericallySpendable?.(row)).toBe(true);
        expect(DelegateContractHandler.isGenericallySpendable?.(row)).toBe(true);
        expect(BoardingContractHandler.isGenericallySpendable?.(row)).toBe(true);
        // Today's behaviour verbatim — Phase 0 changes nothing for VHTLC.
        expect(VHTLCContractHandler.isGenericallySpendable?.(row)).toBe(true);
    });

    it("makes arkade opt-in, never opt-out", () => {
        const answer = (metadata?: Record<string, unknown>) =>
            ArkadeContractHandler.isGenericallySpendable?.(contract("s", "arkade", metadata));
        expect(answer({ genericallySpendable: true })).toBe(true);
        expect(answer()).toBe(false);
        expect(answer({})).toBe(false);
        // Malformed markers must not open the gate.
        expect(answer({ genericallySpendable: "true" })).toBe(false);
        expect(answer({ genericallySpendable: 1 })).toBe(false);
    });

    it("closes a type no handler declares (D1a)", () => {
        expect(isContractGenericallySpendable(contract("s", "not-a-registered-type"))).toBe(false);
    });
});

describe("getSpendableVtxos", () => {
    it("drops gated contracts while getVtxos keeps them", async () => {
        const { wallet, defaultScript } = await seededWallet();

        expect(scriptsOf(await wallet.getVtxos())).toEqual(
            [defaultScript, ESCROW_SCRIPT, MARKED_SCRIPT, UNKNOWN_SCRIPT].sort(),
        );
        expect(scriptsOf(await wallet.getSpendableVtxos())).toEqual(
            [defaultScript, MARKED_SCRIPT].sort(),
        );
    });

    it("passes its filter through unchanged", async () => {
        const { wallet } = await seededWallet();
        const spy = vi.spyOn(wallet, "getVtxos");
        // Same filter, same result set modulo the gate: the accessor is
        // gate(getVtxos(filter)), so a site's migration cannot change its filter.
        for (const filter of [
            undefined,
            { withRecoverable: false },
            { withRecoverable: true },
            { withRecoverable: true, withUnrolled: false },
        ]) {
            const raw = await wallet.getVtxos(filter);
            const gated = await wallet.getSpendableVtxos(filter);
            expect(scriptsOf(gated)).toEqual(
                scriptsOf(
                    raw.filter((v) => v.script !== ESCROW_SCRIPT && v.script !== UNKNOWN_SCRIPT),
                ),
            );
        }
        spy.mockRestore();
    });

    it("excludes intent-locked outpoints", async () => {
        const intents = new InMemoryIntentRepository();
        const { wallet, defaultScript } = await seededWallet({ intents });
        await intents.saveIntent({
            intentTxId: "i",
            createdAt: 1,
            updatedAt: 1,
            registerProof: "",
            registerProofMessage: "",
            deleteProof: "",
            deleteProofMessage: "",
            partialForfeits: [],
            state: "batch_in_progress",
            intentVtxos: [{ txid: defaultScript.slice(-2).repeat(32), vout: 0 }],
        });

        expect(scriptsOf(await wallet.getSpendableVtxos())).toEqual([MARKED_SCRIPT]);
        // Still reported as owned.
        expect(scriptsOf(await wallet.getVtxos())).toContain(defaultScript);
    });

    it("takes exactly one contract snapshot per call", async () => {
        const { wallet } = await seededWallet();
        const manager = await wallet.getContractManager();
        const spy = vi.spyOn(manager, "getContractsWithVtxos");

        await wallet.getSpendableVtxos();

        // getContractsWithVtxos syncs against the indexer, so a second read
        // would cost a round-trip AND evaluate the two exclusion sets against
        // two different points in time.
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });
});

describe("getBalance", () => {
    it("counts gated funds as owned but not as available (D1c)", async () => {
        const { wallet } = await seededWallet();
        const balance = await wallet.getBalance();

        // 40k own + 10k escrow + 10k marked + 10k unknown-type
        expect(balance.settled).toBe(70_000);
        expect(balance.total).toBe(70_000);
        // …minus the escrowed and the unknown-type contract.
        expect(balance.available).toBe(50_000);
    });

    it("gives assets the same owned/spendable split (D1e)", async () => {
        const { wallet } = await seededWallet();
        const balance = await wallet.getBalance();

        const amount = (assets: { assetId: string; amount: bigint }[]) =>
            assets.find((a) => a.assetId === ASSET_ID)?.amount ?? 0n;

        expect(amount(balance.assets)).toBe(22n); // 7 + 5 + 5 + 5
        expect(amount(balance.availableAssets)).toBe(12n); // 7 + 5
        // The escrowed asset amount, without a new balance bucket.
        expect(amount(balance.assets) - amount(balance.availableAssets)).toBe(10n);
    });
});

describe("gated reads stay ungated (D1b/D1d)", () => {
    it("keeps escrowed funds in the recovery and history reads", async () => {
        const { wallet } = await seededWallet();

        expect(scriptsOf(await wallet.getVtxos({ withRecoverable: true }))).toContain(
            ESCROW_SCRIPT,
        );
        const history = await wallet.getTransactionHistory();
        expect(history.length).toBeGreaterThan(0);
    });

    it("settles a gated VTXO when it is named explicitly (D1d)", async () => {
        // The escape hatch that keeps an escrowed deposit recoverable once
        // generic selection — and with it background renewal — stops covering it.
        const escrowed = vtxo(ESCROW_SCRIPT, 10_000);
        const getSpendableVtxos = vi.fn();
        const registerInputs = vi.fn().mockResolvedValue({
            proof: "register-proof",
            message: { type: "register" },
        });

        const thisArg: any = {
            network: "mutinynet",
            arkProvider: {
                getEventStream: vi.fn().mockReturnValue({
                    next: vi.fn().mockResolvedValue({ done: false, value: { type: "x" } }),
                    return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
                    [Symbol.asyncIterator]() {
                        return this;
                    },
                }),
                deleteIntent: vi.fn().mockResolvedValue(undefined),
            },
            getSpendableVtxos,
            _addPendingSpends: vi.fn(),
            _removePendingSpends: vi.fn(),
            getAddress: vi.fn().mockResolvedValue(TEST_DEFAULT_ARK_ADDRESS),
            makeRegisterIntentSignature: registerInputs,
            makeDeleteIntentSignature: vi.fn().mockResolvedValue({
                proof: "delete-proof",
                message: { type: "delete", expire_at: 0 },
            }),
            logUngatedInputs: vi.fn().mockResolvedValue(undefined),
            safeRegisterIntent: vi.fn().mockRejectedValue(new Error("stop-after-selection")),
            persistIntentSnapshot: vi.fn(),
        };

        await expect(
            (Wallet.prototype as any)._settleImpl.call(thisArg, {
                inputs: [escrowed],
                outputs: [],
            }),
        ).rejects.toThrow("stop-after-selection");

        expect(registerInputs.mock.calls[0][0]).toEqual([escrowed]);
        expect(getSpendableVtxos).not.toHaveBeenCalled();
        expect(thisArg.logUngatedInputs).toHaveBeenCalledWith("settle({ inputs })", [escrowed]);
    });
});

describe("spending sites consume the accessor", () => {
    const mockWallet = (raw: unknown[], spendable: unknown[]) => ({
        getVtxos: vi.fn().mockResolvedValue(raw),
        getSpendableVtxos: vi.fn().mockResolvedValue(spendable),
        getAddress: vi.fn().mockResolvedValue("ark1address"),
        getDelegateManager: vi.fn().mockResolvedValue(undefined),
        getContractManager: vi.fn().mockResolvedValue({
            onContractEvent: vi.fn().mockReturnValue(() => {}),
            refreshOutpoints: vi.fn().mockResolvedValue(undefined),
        }),
        dustAmount: 1000n,
        arkProvider: { getInfo: vi.fn().mockResolvedValue(arkInfo()) },
    });

    it("renewal does not see gated VTXOs", async () => {
        const escrowed = vtxo(ESCROW_SCRIPT, 10_000);
        const wallet = mockWallet([escrowed], []);
        const manager = new VtxoManager(wallet as never);

        await expect(manager.getExpiringVtxos()).resolves.toEqual([]);
        expect(wallet.getSpendableVtxos).toHaveBeenCalled();
    });

    it("offboard does not see gated VTXOs", async () => {
        const escrowed = vtxo(ESCROW_SCRIPT, 10_000);
        const wallet = mockWallet([escrowed], []);
        const ramps = new Ramps(wallet as never);

        await expect(
            ramps.offboard("bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080", {
                intentFee: {},
                txFeeRate: "1",
            }),
        ).rejects.toThrow();
        expect(wallet.getSpendableVtxos).toHaveBeenCalled();
    });
});
