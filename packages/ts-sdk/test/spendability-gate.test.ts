import { describe, it, expect, vi } from "vitest";
import {
    ArkadeContractHandler,
    BoardingContractHandler,
    DefaultContractHandler,
    DelegateContractHandler,
    gateExclusion,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    isContractGenericallySpendable,
    outpointReasons,
    UnannotatableInputError,
    ProviderUnavailableError,
    ReadonlyWallet,
    VHTLCContractHandler,
    Wallet,
    type ArkProvider,
    type Contract,
    type GetVtxosFilter,
    type IndexerProvider,
    type OnchainProvider,
} from "../src";
import type { ArkInfo } from "../src/providers/ark";
import { InMemoryIntentRepository } from "../src/repositories/inMemory/intentRepository";
import {
    DEFAULT_MESSAGE_TAG,
    WalletMessageHandler,
} from "../src/wallet/serviceWorker/wallet-message-handler";
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

// Online: answers every script query from a fixed set, so `getContractsWithVtxos`
// actually syncs and annotates what comes back.
const onlineIndexer = (vtxos: { script: string }[]) =>
    ({
        getVtxos: async (opts?: { scripts?: string[] }) => ({
            vtxos: vtxos.filter((v) => opts?.scripts?.includes(v.script)),
        }),
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
async function seededWallet(opts?: {
    intents?: InMemoryIntentRepository;
    signing?: boolean;
    indexerProvider?: IndexerProvider;
}) {
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
        indexerProvider: opts?.indexerProvider ?? offlineIndexer(),
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
const txidsOf = (vtxos: { txid: string }[]) => vtxos.map((v) => v.txid).sort();

/** Every `[spendability]` debug line the call emitted, in order. */
const captureDebug = async (run: () => Promise<void>): Promise<string[]> => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "debug").mockImplementation((...args: unknown[]) => {
        lines.push(args.join(" "));
    });
    await run();
    spy.mockRestore();
    return lines.filter((l) => l.startsWith("[spendability]"));
};

describe("ContractHandler.isGenericallySpendable", () => {
    it("answers true for every built-in wallet-owned type", () => {
        const row = contract("s", "default");
        expect(DefaultContractHandler.isGenericallySpendable?.(row)).toBe(true);
        expect(DelegateContractHandler.isGenericallySpendable?.(row)).toBe(true);
        expect(BoardingContractHandler.isGenericallySpendable?.(row)).toBe(true);
    });

    /**
     * This assertion used to read `true`, pinned as "today's behaviour
     * verbatim" and deferred on the grounds that narrowing it would stop
     * in-flight swaps from being selected.
     *
     * That premise did not hold. The `vhtlc` handler had no `deriveTapscripts`
     * and no VHTLC script defines `forfeit()`, so `deriveContractTapscripts`
     * threw for every `vhtlc` row, `annotatableIn` dropped its VTXOs, and they
     * never reached this gate — there was no selection to preserve. The
     * handler now derives its annotation leaf, so those VTXOs DO arrive here,
     * and a VHTLC is escrow rather than wallet-owned money: it must not be
     * credited to `available`, nor swept by an unprompted renewal.
     */
    it("answers false for vhtlc — escrow, not wallet-owned money", () => {
        const row = contract("s", "vhtlc");
        expect(VHTLCContractHandler.isGenericallySpendable?.(row)).toBe(false);
        expect(isContractGenericallySpendable(row)).toBe(false);
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
        const { wallet, walletRepository, defaultScript } = await seededWallet();
        // Two more of the wallet's own coins, each visible under exactly one
        // filter flag, so an accessor that ignored the filter would show up.
        const recoverableTxid = "e1".repeat(32);
        const unrolledTxid = "e2".repeat(32);
        await walletRepository.saveVtxos(await wallet.getAddress(), [
            createMockExtendedVtxo({
                txid: recoverableTxid,
                vout: 0,
                value: 10_000,
                script: defaultScript,
                isSwept: true,
            }),
            createMockExtendedVtxo({
                txid: unrolledTxid,
                vout: 0,
                value: 10_000,
                script: defaultScript,
                isSpent: false,
                isUnrolled: true,
            }),
        ]);

        const ownTxid = defaultScript.slice(-2).repeat(32);
        const markedTxid = MARKED_SCRIPT.slice(-2).repeat(32);
        const cases: [GetVtxosFilter | undefined, string[]][] = [
            // The default filter is { withRecoverable: true, withUnrolled: false }.
            [undefined, [ownTxid, markedTxid, recoverableTxid]],
            [{ withRecoverable: false }, [ownTxid, markedTxid]],
            [{ withRecoverable: true }, [ownTxid, markedTxid, recoverableTxid]],
            [
                { withRecoverable: true, withUnrolled: false },
                [ownTxid, markedTxid, recoverableTxid],
            ],
            [
                { withRecoverable: true, withUnrolled: true },
                [ownTxid, markedTxid, recoverableTxid, unrolledTxid],
            ],
        ];

        // Same filter, same result set modulo the gate: the accessor is
        // gate(getVtxos(filter)), so a site's migration cannot change its filter.
        for (const [filter, expected] of cases) {
            const raw = await wallet.getVtxos(filter);
            const gated = await wallet.getSpendableVtxos(filter);
            expect(txidsOf(gated)).toEqual(expected.sort());
            expect(txidsOf(gated)).toEqual(
                txidsOf(
                    raw.filter((v) => v.script !== ESCROW_SCRIPT && v.script !== UNKNOWN_SCRIPT),
                ),
            );
        }
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

    it("survives a stored contract whose handler this runtime never registered", async () => {
        // A persisted plugin row outliving its handler is the case the gate is
        // meant to close, so the read that applies the gate must reach it: the
        // sync annotates whatever the indexer returns, and no handler means no
        // tapscripts to annotate with.
        const { wallet, defaultScript } = await seededWallet({
            indexerProvider: onlineIndexer([vtxo(UNKNOWN_SCRIPT, 10_000)]),
        });

        expect(scriptsOf(await wallet.getSpendableVtxos())).toEqual(
            [defaultScript, MARKED_SCRIPT].sort(),
        );
        await expect(wallet.getBalance()).resolves.toMatchObject({
            total: 70_000,
            available: 50_000,
        });
        // Its already-persisted funds stay owned and reported — only the
        // refresh of them is skipped.
        expect(scriptsOf(await wallet.getVtxos())).toContain(UNKNOWN_SCRIPT);
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
    /**
     * `settled + preconfirmed === available + gated + intentLocked`, and the
     * five owned buckets sum to `total` — which is what catches a bucket added
     * without being counted, or counted twice.
     */
    const expectSplit = (balance: {
        settled: number;
        preconfirmed: number;
        available: number;
        gated: number;
        intentLocked: number;
        recoverable: number;
        pendingRecovery: number;
        unrolled: number;
        total: number;
        boarding: { total: number };
    }) => {
        expect(balance.settled + balance.preconfirmed).toBe(
            balance.available + balance.gated + balance.intentLocked,
        );
        expect(balance.total).toBe(
            balance.boarding.total +
                balance.settled +
                balance.preconfirmed +
                balance.recoverable +
                balance.pendingRecovery +
                balance.unrolled,
        );
    };

    const lockOutpoint = async (intents: InMemoryIntentRepository, txid: string) =>
        intents.saveIntent({
            intentTxId: `i-${txid.slice(0, 4)}`,
            createdAt: 1,
            updatedAt: 1,
            registerProof: "",
            registerProofMessage: "",
            deleteProof: "",
            deleteProofMessage: "",
            partialForfeits: [],
            state: "batch_in_progress",
            intentVtxos: [{ txid, vout: 0 }],
        });

    it("counts gated funds as owned but not as available (D1c)", async () => {
        const { wallet } = await seededWallet();
        const balance = await wallet.getBalance();

        // 40k own + 10k escrow + 10k marked + 10k unknown-type
        expect(balance.settled).toBe(70_000);
        expect(balance.total).toBe(70_000);
        // …minus the escrowed and the unknown-type contract.
        expect(balance.available).toBe(50_000);
        expect(balance.gated).toBe(20_000);
        expect(balance.intentLocked).toBe(0);
        expectSplit(balance);
    });

    it("buckets an unrolled VTXO as unrolled — visible in total, in no spendable bucket", async () => {
        const { wallet, walletRepository, defaultScript } = await seededWallet();
        const unrolledTxid = "f1".repeat(32);
        await walletRepository.saveVtxos(await wallet.getAddress(), [
            createMockExtendedVtxo({
                txid: unrolledTxid,
                vout: 0,
                value: 25_000,
                script: defaultScript,
                virtualStatus: { state: "settled" },
                isSpent: false,
                isUnrolled: true,
                assets: [{ assetId: ASSET_ID, amount: 3n }],
            }),
        ]);

        expect(txidsOf(await wallet.getVtxos())).not.toContain(unrolledTxid);
        expect(txidsOf(await wallet.getVtxos({ withUnrolled: true }))).toContain(unrolledTxid);

        const balance = await wallet.getBalance();
        // The 70k baseline is untouched; the exited 25k shows up only under
        // `unrolled`, and `total` still accounts for every sat.
        expect(balance.unrolled).toBe(25_000);
        expect(balance.total).toBe(95_000);
        expect(balance.settled).toBe(70_000);
        expect(balance.preconfirmed).toBe(0);
        expect(balance.available).toBe(50_000);
        expect(balance.recoverable).toBe(0);
        expect(balance.pendingRecovery).toBe(0);
        expectSplit(balance);

        // Assets follow the value: owned, never offered to generic spending.
        expect(balance.assets).toContainEqual({ assetId: ASSET_ID, amount: 25n });
        expect(balance.availableAssets).toContainEqual({ assetId: ASSET_ID, amount: 12n });
    });

    it("keeps an unrolled-AND-swept VTXO out of recoverable", async () => {
        const { wallet, walletRepository, defaultScript } = await seededWallet();
        await walletRepository.saveVtxos(await wallet.getAddress(), [
            createMockExtendedVtxo({
                txid: "f2".repeat(32),
                vout: 0,
                value: 25_000,
                script: defaultScript,
                isSwept: true,
                isUnrolled: true,
            }),
        ]);

        const balance = await wallet.getBalance();
        expect(balance.recoverable).toBe(0);
        expect(balance.unrolled).toBe(25_000);
        expectSplit(balance);
    });

    it("drops an unrolled-AND-spent VTXO from every bucket", async () => {
        // The `hasTerminalSpend` guard in the bucketer is what does this: the
        // filter now hands unrolled coins over WITHOUT testing spend first.
        const { wallet, walletRepository, defaultScript } = await seededWallet();
        await walletRepository.saveVtxos(await wallet.getAddress(), [
            createMockExtendedVtxo({
                txid: "f3".repeat(32),
                vout: 0,
                value: 25_000,
                script: defaultScript,
                isSpent: true,
                spentBy: "ab".repeat(32),
                isUnrolled: true,
            }),
        ]);

        const balance = await wallet.getBalance();
        expect(balance.unrolled).toBe(0);
        expect(balance.total).toBe(70_000);
        expectSplit(balance);
    });

    it("never selects an unrolled VTXO for a send or a settlement", async () => {
        const { wallet, walletRepository, defaultScript } = await seededWallet();
        const unrolledTxid = "f4".repeat(32);
        await walletRepository.saveVtxos(await wallet.getAddress(), [
            createMockExtendedVtxo({
                txid: unrolledTxid,
                vout: 0,
                value: 500_000,
                script: defaultScript,
                isUnrolled: true,
            }),
        ]);

        // Big enough to be picked first by any value-ordered selector, so its
        // absence is the selector refusing it rather than not needing it.
        for (const filter of [undefined, { withRecoverable: true }, { withRecoverable: false }]) {
            expect(txidsOf(await wallet.getSpendableVtxos(filter))).not.toContain(unrolledTxid);
        }
    });

    it("counts a gated-and-locked VTXO once, as gated", async () => {
        const intents = new InMemoryIntentRepository();
        const { wallet } = await seededWallet({ intents });
        const escrowTxid = ESCROW_SCRIPT.slice(-2).repeat(32);
        await lockOutpoint(intents, escrowTxid);

        // Without this the case passes for the wrong reason: no overlap gives
        // the same buckets as an overlap counted once.
        expect(await intents.getLockedVtxoOutpoints()).toContainEqual({
            txid: escrowTxid,
            vout: 0,
        });

        const balance = await wallet.getBalance();
        expect(balance.gated).toBe(20_000);
        expect(balance.intentLocked).toBe(0);
        expect(balance.available).toBe(50_000);
        expectSplit(balance);
    });

    it("reports an ungated intent-locked VTXO as intentLocked", async () => {
        const intents = new InMemoryIntentRepository();
        const { wallet, defaultScript } = await seededWallet({ intents });
        await lockOutpoint(intents, defaultScript.slice(-2).repeat(32));

        const balance = await wallet.getBalance();
        expect(balance.intentLocked).toBe(40_000);
        expect(balance.gated).toBe(20_000);
        expect(balance.available).toBe(10_000); // only MARKED_SCRIPT survives
        expectSplit(balance);
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
            // Gated, but still annotatable — the pre-submission check must let
            // the deliberate recovery spend through.
            getContractManager: vi.fn().mockResolvedValue({
                assertAnnotatable: vi.fn().mockResolvedValue(undefined),
            }),
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

describe("gateExclusion", () => {
    const GATED_SCRIPT = "51200000000000000000000000000000000000000000000000000000000000000006";

    it("names the ordinary refusal for a type this build has a handler for", () => {
        // vhtlc-v2 is a real registered handler (see handlers/index.ts) that
        // simply declines: the gate is working as designed here.
        const exclusion = gateExclusion(new Map([[GATED_SCRIPT, "vhtlc-v2"]]));
        expect(exclusion({ txid: "a", vout: 0, script: GATED_SCRIPT })).toBe(
            `at ${GATED_SCRIPT} (contract type 'vhtlc-v2') is not generically spendable`,
        );
    });

    it("names the missing handler for a type this build never registered", () => {
        const exclusion = gateExclusion(new Map([[GATED_SCRIPT, "not-a-registered-type"]]));
        expect(exclusion({ txid: "a", vout: 0, script: GATED_SCRIPT })).toBe(
            `at ${GATED_SCRIPT} (contract type 'not-a-registered-type') has no handler registered in this build`,
        );
    });

    it("returns undefined for a vtxo the gate does not cover", () => {
        const exclusion = gateExclusion(new Map([[GATED_SCRIPT, "vhtlc-v2"]]));
        expect(exclusion({ txid: "a", vout: 0, script: "not-gated" })).toBeUndefined();
        expect(exclusion({ txid: "a", vout: 0 })).toBeUndefined();
    });
});

describe("outpointReasons", () => {
    const reasons = outpointReasons(new Map([["a:0", "not yet"]]));

    it("returns the reason recorded for that outpoint", () => {
        expect(reasons({ txid: "a", vout: 0 })).toBe("not yet");
    });

    it("returns undefined for anything else", () => {
        expect(reasons({ txid: "a", vout: 1 })).toBeUndefined();
        expect(reasons({ txid: "b", vout: 0 })).toBeUndefined();
    });
});

describe("logUngatedInputs", () => {
    // A real point: the contract manager builds a script from every stored row.
    const DEPRECATED_KEY = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    const EXPIRED_SCRIPT = "51200000000000000000000000000000000000000000000000000000000000000004";

    it("reports all three exclusions, not just the contract gate", async () => {
        const intents = new InMemoryIntentRepository();
        const { wallet, contractRepository, defaultScript } = await seededWallet({ intents });

        // A contract on a deprecated signer whose cutoff has passed: the
        // operator will not co-sign a spend of it.
        await contractRepository.saveContract({
            ...contract(EXPIRED_SCRIPT, "default"),
            params: { ...createDefaultContractParams(), serverPubKey: DEPRECATED_KEY },
        });
        wallet.refreshDeprecatedSigners({
            deprecatedSigners: [{ pubkey: DEPRECATED_KEY, cutoffDate: 1n }],
        });

        const lockedTxid = "e3".repeat(32);
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
            intentVtxos: [{ txid: lockedTxid, vout: 0 }],
        });

        const inputs = [
            vtxo(ESCROW_SCRIPT, 10_000),
            vtxo(EXPIRED_SCRIPT, 10_000),
            { ...vtxo(defaultScript, 10_000), txid: lockedTxid },
            vtxo(MARKED_SCRIPT, 10_000),
        ];

        const lines = await captureDebug(() =>
            wallet.logUngatedInputs("settle({ inputs })", inputs),
        );

        expect(lines).toHaveLength(3);
        expect(lines[0]).toContain("is not generically spendable");
        expect(lines[1]).toContain("rotation cutoff");
        expect(lines[2]).toContain("in-flight settlement intent");
        // The one input generic selection would have picked stays silent.
        expect(lines.join("\n")).not.toContain(MARKED_SCRIPT.slice(-2).repeat(32));
    });

    it("says nothing about inputs generic selection would have picked", async () => {
        const { wallet, defaultScript } = await seededWallet();
        const lines = await captureDebug(() =>
            wallet.logUngatedInputs("buildAndSubmitOffchainTx", [vtxo(defaultScript, 10_000)]),
        );
        expect(lines).toEqual([]);
    });
});

describe("getSpendableVtxos reports the exited coins it dropped", () => {
    const UNROLLED_TXID = "e7".repeat(32);

    /** The seeded wallet plus one exited coin of its own. */
    const withExitedCoin = async (over?: { isSpent?: boolean }) => {
        const seeded = await seededWallet();
        await seeded.walletRepository.saveVtxos(await seeded.wallet.getAddress(), [
            createMockExtendedVtxo({
                txid: UNROLLED_TXID,
                vout: 0,
                value: 12_000,
                script: seeded.defaultScript,
                virtualStatus: { state: "settled" },
                isSpent: over?.isSpent ?? false,
                isUnrolled: true,
            }),
        ]);
        return seeded;
    };

    const linesFor = async (filter?: GetVtxosFilter) => {
        const { wallet } = await withExitedCoin();
        return captureDebug(async () => {
            await wallet.getSpendableVtxos(filter);
        });
    };

    it("names the outpoint and the remedy that reaches it", async () => {
        const lines = await linesFor();
        const line = lines.find((l) => l.includes(UNROLLED_TXID));
        expect(line).toContain(`${UNROLLED_TXID}:0`);
        expect(line).toContain("unilaterally exited");
        expect(line).toContain("Unroll.completeUnroll");
    });

    it("stays quiet when the caller asked for unrolled coins", async () => {
        // Nothing was excluded, so describing it as excluded would be wrong.
        const lines = await linesFor({ withRecoverable: true, withUnrolled: true });
        expect(lines.join("\n")).not.toContain(UNROLLED_TXID);
    });

    it("stays quiet about a completed unroll", async () => {
        // The exit output is already spent: `completeUnroll` does not reach it
        // either, so the line would name a remedy that throws.
        const { wallet } = await withExitedCoin({ isSpent: true });
        const lines = await captureDebug(async () => {
            await wallet.getSpendableVtxos();
        });
        expect(lines.join("\n")).not.toContain(UNROLLED_TXID);
    });

    it("says nothing on the reads that are not spending", async () => {
        // The other placement the design rejects: logging inside
        // `filterSnapshotVtxos` would make `getVtxos` — a raw reporting read
        // where an exited coin is out of scope, not excluded — and `getBalance`,
        // which asks for them on purpose, both report one as excluded.
        const { wallet } = await withExitedCoin();
        const lines = await captureDebug(async () => {
            await wallet.getVtxos();
            await wallet.getVtxos({ withUnrolled: true });
            await wallet.getBalance();
        });
        expect(lines.join("\n")).not.toContain(UNROLLED_TXID);
    });

    it("does not report a terminally-spent coin under a gated contract as gated", async () => {
        // The regression the separate call exists to prevent: reporting the raw
        // snapshot through the gate exclusion would emit a `gated` line for every
        // spent coin under an escrow contract, none of which was ever a candidate.
        const spentEscrowTxid = "e8".repeat(32);
        const { wallet, walletRepository } = await seededWallet();
        await walletRepository.saveVtxos(contract(ESCROW_SCRIPT, "arkade").address, [
            createMockExtendedVtxo({
                txid: spentEscrowTxid,
                vout: 0,
                value: 9_000,
                script: ESCROW_SCRIPT,
                virtualStatus: { state: "settled" },
                isSpent: true,
            }),
        ]);

        const lines = await captureDebug(async () => {
            await wallet.getSpendableVtxos();
        });

        // The live escrow coin is still reported — the gate line is not gone,
        // just not extended to coins that are already spent.
        expect(lines.join("\n")).toContain("is not generically spendable");
        expect(lines.join("\n")).not.toContain(spentEscrowTxid);
    });
});

describe("a contract whose handler rejects its stored params", () => {
    // The upgrade shape: `arkade` params written before `program` became
    // required. The handler is registered and `createScript` throws.
    const BROKEN_SCRIPT = "51200000000000000000000000000000000000000000000000000000000000000005";

    const withBrokenContract = async () => {
        const seeded = await seededWallet({
            indexerProvider: onlineIndexer([vtxo(BROKEN_SCRIPT, 10_000)]),
        });
        await seeded.contractRepository.saveContract(contract(BROKEN_SCRIPT, "arkade"));
        return seeded;
    };

    it("does not fail the reads of every other contract", async () => {
        const { wallet, defaultScript } = await withBrokenContract();

        await expect(wallet.getBalance()).resolves.toMatchObject({ available: 50_000 });
        expect(scriptsOf(await wallet.getSpendableVtxos())).toEqual(
            [defaultScript, MARKED_SCRIPT].sort(),
        );
    });

    it("reports itself through the sync state instead of going quiet", async () => {
        const { wallet } = await withBrokenContract();
        await wallet.getBalance();

        const state = wallet.getContractSyncState();
        expect(state.mode).toBe("degraded");
        expect(state.mode === "degraded" && state.reason).toContain(BROKEN_SCRIPT);
        expect(state.mode === "degraded" && state.reason).toContain("not being synced");
    });

    it("refuses the spend before it is submitted, naming the contract", async () => {
        const { wallet } = await withBrokenContract();
        const manager = await wallet.getContractManager();

        // Stored coins keep working tapscripts, so the spend would otherwise
        // build and broadcast and only fail in the bookkeeping afterwards.
        await expect(
            manager.assertAnnotatable([{ txid: "ff".repeat(32), vout: 0, script: BROKEN_SCRIPT }]),
        ).rejects.toThrow(UnannotatableInputError);
        await expect(
            manager.assertAnnotatable([{ txid: "ff".repeat(32), vout: 0, script: BROKEN_SCRIPT }]),
        ).rejects.toThrow(/missing 'program'/);
    });

    it("lets a spendable contract through", async () => {
        const { wallet, defaultScript } = await withBrokenContract();
        const manager = await wallet.getContractManager();
        await expect(
            manager.assertAnnotatable([{ txid: "aa".repeat(32), vout: 0, script: defaultScript }]),
        ).resolves.toBeUndefined();
    });

    it("refuses a vtxo with no contract row at all, for the same reason", async () => {
        const { wallet } = await withBrokenContract();
        const manager = await wallet.getContractManager();
        await expect(
            manager.assertAnnotatable([
                { txid: "ab".repeat(32), vout: 0, script: "5120" + "cd".repeat(32) },
            ]),
        ).rejects.toThrow(/no contract registered/);
    });
});

describe("main-thread / worker balance parity", () => {
    /**
     * The worker hands `computeOffchainBalance` an unfiltered repository read,
     * so its `unrolled` bucket fills itself; the main thread has to ask for
     * unrolled coins explicitly. Comparing the two is the only assertion that
     * catches `Wallet.getBalance` going back to the default filter, which
     * silently drops them and reports `unrolled: 0` forever.
     *
     * Scoped to `unrolled` and `total` on purpose. `_pendingSpendOutpoints` is
     * main-thread-only state — written around `settle`/`sendBitcoin` by the
     * instance driving the spend — so mid-send the two sides legitimately
     * disagree, and an all-buckets assertion would trip on it. Not a bug to
     * repair by widening the worker's balance read: the fix for a consumer that
     * ever needs agreement mid-send is a `SPEND_STARTED`/`SPEND_SETTLED` event on
     * the existing bus, not a balance-read change.
     *
     * `unrolled` is not exempt from that wedge either, only out of its reach in
     * practice: generic selection refuses exited coins, but the explicit-input
     * paths are ungated, so a caller *naming* one puts it in the set. Accepted
     * because it is bounded and self-inflicted — such a spend is doomed at the
     * server, and the wedge lasts until it rejects.
     */
    const workerBalance = async (seeded: Awaited<ReturnType<typeof seededWallet>>) => {
        // Same wallet, same repository as the main-thread read — two stubs
        // would agree with each other and prove nothing.
        const handler = new WalletMessageHandler();
        (handler as any).readonlyWallet = seeded.wallet;
        (handler as any).walletRepository = seeded.walletRepository;
        (handler as any).indexerProvider = offlineIndexer();
        (handler as any).arkProvider = {};

        const response = await handler.handleMessage({
            id: "1",
            tag: DEFAULT_MESSAGE_TAG,
            type: "GET_BALANCE",
        } as any);
        expect(response.error).toBeUndefined();
        return (response as any).payload as Awaited<ReturnType<Wallet["getBalance"]>>;
    };

    it("reports the same unrolled bucket on both sides of the bus", async () => {
        const seeded = await seededWallet();
        await seeded.walletRepository.saveVtxos(await seeded.wallet.getAddress(), [
            createMockExtendedVtxo({
                txid: "f5".repeat(32),
                vout: 0,
                value: 25_000,
                script: seeded.defaultScript,
                virtualStatus: { state: "settled" },
                isSpent: false,
                isUnrolled: true,
            }),
        ]);

        const main = await seeded.wallet.getBalance();
        const worker = await workerBalance(seeded);

        // Non-zero first: two paths both reporting 0 must not pass as parity.
        expect(worker.unrolled).toBe(25_000);
        expect(main.unrolled).toBe(worker.unrolled);
        expect(main.total).toBe(worker.total);
        expect(main.total).toBe(95_000);
    });

    it("agrees when there is no unrolled coin at all", async () => {
        const seeded = await seededWallet();

        const main = await seeded.wallet.getBalance();
        const worker = await workerBalance(seeded);

        expect(worker.unrolled).toBe(0);
        expect(main.unrolled).toBe(0);
        expect(main.total).toBe(worker.total);
        expect(main.total).toBe(70_000);
    });
});
