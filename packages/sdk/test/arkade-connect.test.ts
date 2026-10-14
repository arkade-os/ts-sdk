import { afterEach, describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import {
    arkade,
    BITCOIN_EMULATOR_PUBKEY,
    ContractManager,
    CSVMultisigTapscript,
    DEFAULT_ARKADE_EMULATOR_URL,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    ReadonlyWallet,
    RestArkProvider,
    RestEmulatorProvider,
    RestIndexerProvider,
    EsploraProvider,
    Wallet,
    type ArkadeInfo,
    type ContractEvent,
    type ContractEventCallback,
    type IContractManager,
} from "../src";
import { ReadonlySingleKey, SingleKey } from "../src/identity/singleKey";
import {
    createMockIndexerProvider,
    createMockVtxo,
    TEST_PUB_KEY,
    TEST_PUB_KEY_HEX,
    TEST_SERVER_PUB_KEY,
    TEST_SERVER_PUB_KEY_HEX,
} from "./contracts/helpers";

const privKeyHex = "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";

const checkpointTapscript = hex.encode(
    CSVMultisigTapscript.encode({
        timelock: { type: "blocks", value: 10n },
        pubkeys: [TEST_SERVER_PUB_KEY],
    }).script,
);

function info(network = "bitcoin"): ArkadeInfo {
    return {
        signerPubkey: "02" + TEST_SERVER_PUB_KEY_HEX,
        checkpointTapscript,
        network,
    } as ArkadeInfo;
}

function multisigProgram() {
    return {
        version: 0,
        params: ["server", "user"],
        functions: {
            cooperative: { tapscript: { signers: ["$user", "$server"] } },
        },
    } satisfies arkade.Program;
}

const identity = {
    async xOnlyPublicKey() {
        return TEST_PUB_KEY;
    },
} as any;

/** A manager double: captures the subscriber so tests can emit, and records calls. */
function fakeManager(opts: { onCreate?: (emit: (e: ContractEvent) => void) => void } = {}) {
    const callbacks = new Set<ContractEventCallback>();
    const emit = (e: ContractEvent) => callbacks.forEach((cb) => cb(e));
    const manager = {
        onContractEvent: vi.fn((cb: ContractEventCallback) => {
            callbacks.add(cb);
            return () => callbacks.delete(cb);
        }),
        createContract: vi.fn(async (params: any) => {
            opts.onCreate?.(emit);
            return { ...params, createdAt: 0, state: "active" };
        }),
        getContractsWithVtxos: vi.fn(async () => []),
        dispose: vi.fn(),
    };
    return { manager: manager as unknown as IContractManager, raw: manager, emit, callbacks };
}

function vtxoEvent(type: "vtxo_received" | "vtxo_spent", script: string): ContractEvent {
    return {
        type,
        contractScript: script,
        vtxos: [],
        contract: { script } as any,
        timestamp: 0,
    };
}

async function connectWith(contractManager?: IContractManager) {
    return arkade.Arkade.connect({
        arkade: { getInfo: async () => info("regtest") },
        identity,
        contractManager,
    });
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("resolveArkadeService", () => {
    it("network arm: default server, mainnet esplora and the default emulator", async () => {
        const getInfo = vi.spyOn(RestArkProvider.prototype, "getInfo").mockResolvedValue(info());
        const r = await arkade.resolveArkadeService({ network: "bitcoin" });

        expect(getInfo).toHaveBeenCalledTimes(1);
        expect((r.arkProvider as RestArkProvider).serverUrl).toBe("https://arkade.computer");
        expect((r.indexerProvider as RestIndexerProvider).serverUrl).toBe(
            "https://arkade.computer",
        );
        expect(r.onchainProvider).toBeInstanceOf(EsploraProvider);
        expect(r.emulator).toBeInstanceOf(RestEmulatorProvider);
        expect((r.emulator as RestEmulatorProvider).serverUrl).toBe(DEFAULT_ARKADE_EMULATOR_URL);
        expect(r.info.network).toBe("bitcoin");
    });

    it("network arm throws when the server reports another network", async () => {
        vi.spyOn(RestArkProvider.prototype, "getInfo").mockResolvedValue(info("mutinynet"));
        await expect(arkade.resolveArkadeService({ network: "bitcoin" })).rejects.toThrow(
            /network mismatch.*'bitcoin'.*'mutinynet'/,
        );
    });

    it("server arm yields an emulator only with emulatorUrl", async () => {
        vi.spyOn(RestArkProvider.prototype, "getInfo").mockResolvedValue(info("regtest"));
        const bare = await arkade.resolveArkadeService({ serverUrl: "http://localhost:7070" });
        expect(bare.emulator).toBeUndefined();
        expect((bare.indexerProvider as RestIndexerProvider).serverUrl).toBe(
            "http://localhost:7070",
        );

        const withEmu = await arkade.resolveArkadeService({
            serverUrl: "http://localhost:7070",
            emulatorUrl: "http://localhost:7073",
        });
        expect((withEmu.emulator as RestEmulatorProvider).serverUrl).toBe("http://localhost:7073");
    });

    it("reuses a passed arkProvider and info (no second getInfo)", async () => {
        const getInfo = vi.fn(async () => info());
        const arkProvider = { getInfo } as any;
        const r = await arkade.resolveArkadeService(
            { network: "bitcoin" },
            { arkProvider, info: info() },
        );
        expect(getInfo).not.toHaveBeenCalled();
        expect(r.arkProvider).toBe(arkProvider);
    });
});

describe("Arkade.connect with service", () => {
    it("network arm resolves the emulator and the pinned mainnet key", async () => {
        vi.spyOn(RestArkProvider.prototype, "getInfo").mockResolvedValue(info());
        const ark = await arkade.Arkade.connect({ service: { network: "bitcoin" } });
        expect((ark.emulator as RestEmulatorProvider).serverUrl).toBe(DEFAULT_ARKADE_EMULATOR_URL);
        expect(hex.encode(ark.emulatorKey!)).toBe(BITCOIN_EMULATOR_PUBKEY);
        expect(ark.contractManager).toBeUndefined();
    });

    it("storage builds and owns a manager, which dispose() stops", async () => {
        vi.spyOn(RestArkProvider.prototype, "getInfo").mockResolvedValue(info("regtest"));
        const { manager, raw } = fakeManager();
        const create = vi.spyOn(ContractManager, "create").mockResolvedValue(manager as any);
        const contractRepository = new InMemoryContractRepository();

        const ark = await arkade.Arkade.connect({
            service: { serverUrl: "http://localhost:7070" },
            storage: { contractRepository },
        });

        expect(ark.contractManager).toBe(manager);
        const cfg = create.mock.calls[0][0];
        expect(cfg.contractRepository).toBe(contractRepository);
        expect(cfg.walletRepository).toBeInstanceOf(InMemoryWalletRepository);
        expect(cfg.indexerProvider).toBeInstanceOf(RestIndexerProvider);
        expect(cfg.chainTip).toBeTypeOf("function");

        const tip = vi
            .spyOn(EsploraProvider.prototype, "getChainTip")
            .mockResolvedValue({ height: 900_000, time: 1_700_000_000, hash: "00" });
        await expect(cfg.chainTip!()).resolves.toEqual({ height: 900_000, time: 1_700_000_000 });
        expect(tip).toHaveBeenCalledTimes(1);

        ark.dispose();
        expect(raw.dispose).toHaveBeenCalledTimes(1);
    });

    it("dispose() leaves a caller-passed manager running", async () => {
        const { manager, raw } = fakeManager();
        const ark = await connectWith(manager);
        await ark.contract(multisigProgram()).on("vtxo_received", () => {});
        ark.dispose();
        expect(raw.dispose).not.toHaveBeenCalled();
    });

    it("storage together with contractManager throws", async () => {
        const { manager } = fakeManager();
        await expect(
            arkade.Arkade.connect({
                service: { network: "bitcoin" },
                storage: { contractRepository: new InMemoryContractRepository() },
                contractManager: manager,
            }),
        ).rejects.toThrow(/either `storage` or `contractManager`/);
    });
});

describe("ArkadeContract.on", () => {
    it("fans out by script and type", async () => {
        const { manager, raw, emit } = fakeManager();
        const ark = await connectWith(manager);
        const a = ark.contract(multisigProgram());
        const b = ark.contract(multisigProgram(), { user: new Uint8Array(32).fill(2) });
        const scriptA = hex.encode(a.pkScript);

        const receivedA = vi.fn();
        const spentA = vi.fn();
        const receivedB = vi.fn();
        await a.on("vtxo_received", receivedA);
        await a.on("vtxo_spent", spentA);
        await b.on("vtxo_received", receivedB);

        emit(vtxoEvent("vtxo_spent", scriptA));
        expect(spentA).toHaveBeenCalledTimes(1);
        expect(receivedA).not.toHaveBeenCalled();
        expect(receivedB).not.toHaveBeenCalled();
        // One manager subscription for every handle.
        expect(raw.onContractEvent).toHaveBeenCalledTimes(1);
        expect(raw.createContract).toHaveBeenCalledTimes(3);
    });

    it("connection_reset reaches reset handles only", async () => {
        const { manager, emit } = fakeManager();
        const ark = await connectWith(manager);
        const c = ark.contract(multisigProgram());
        const reset = vi.fn();
        const received = vi.fn();
        await c.on("connection_reset", reset);
        await c.on("vtxo_received", received);

        emit({ type: "connection_reset", timestamp: 1 });
        expect(reset).toHaveBeenCalledWith({ type: "connection_reset", timestamp: 1 });
        expect(received).not.toHaveBeenCalled();
    });

    it("a handler sees events emitted during registration", async () => {
        let script = "";
        const { manager } = fakeManager({
            onCreate: (emit) => emit(vtxoEvent("vtxo_received", script)),
        });
        const ark = await connectWith(manager);
        const c = ark.contract(multisigProgram());
        script = hex.encode(c.pkScript);
        const received = vi.fn();
        await c.on("vtxo_received", received);
        expect(received).toHaveBeenCalledTimes(1);
    });

    it("off() stops delivery; a throwing handler doesn't starve siblings", async () => {
        const { manager, emit } = fakeManager();
        const ark = await connectWith(manager);
        const c = ark.contract(multisigProgram());
        const script = hex.encode(c.pkScript);
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        const thrower = await c.on("vtxo_received", () => {
            throw new Error("boom");
        });
        const ok = vi.fn();
        const sub = await c.on("vtxo_received", ok);

        emit(vtxoEvent("vtxo_received", script));
        expect(ok).toHaveBeenCalledTimes(1);
        expect(errSpy).toHaveBeenCalled();

        sub.off();
        thrower.off();
        emit(vtxoEvent("vtxo_received", script));
        expect(ok).toHaveBeenCalledTimes(1);
    });

    it("without a manager throws", async () => {
        const ark = await connectWith();
        await expect(ark.contract(multisigProgram()).on("vtxo_spent", () => {})).rejects.toThrow(
            /requires a contract manager/,
        );
    });

    it("a failed registration leaves no handle behind", async () => {
        const { manager, raw, emit } = fakeManager();
        raw.createContract.mockRejectedValueOnce(new Error("repo down"));
        const ark = await connectWith(manager);
        const c = ark.contract(multisigProgram());
        const cb = vi.fn();
        await expect(c.on("vtxo_received", cb)).rejects.toThrow("repo down");
        emit(vtxoEvent("vtxo_received", hex.encode(c.pkScript)));
        expect(cb).not.toHaveBeenCalled();
    });
});

describe("ArkadeContract.getVtxos", () => {
    it("returns spent VTXOs that getUtxos hides", async () => {
        const indexerProvider = createMockIndexerProvider();
        const manager = await ContractManager.create({
            indexerProvider,
            contractRepository: new InMemoryContractRepository(),
            walletRepository: new InMemoryWalletRepository(),
        });
        const ark = await connectWith(manager);
        const c = ark.contract(multisigProgram());
        const script = hex.encode(c.pkScript);
        indexerProvider.getVtxos = vi.fn().mockResolvedValue({
            vtxos: [
                createMockVtxo({ script, value: 1000 }),
                createMockVtxo({
                    script,
                    value: 2000,
                    txid: "22".repeat(32),
                    isSpent: true,
                    spentBy: "33".repeat(32),
                }),
            ],
        });

        await c.register();
        expect((await c.getUtxos()).map((v) => v.value)).toEqual([1000]);
        const all = await c.getVtxos();
        expect(all.map((v) => v.value).sort()).toEqual([1000, 2000]);
        manager.dispose();
    });

    it("without a manager throws", async () => {
        const ark = await connectWith();
        await expect(ark.contract(multisigProgram()).getVtxos()).rejects.toThrow(
            /requires a contract manager/,
        );
    });
});

describe("ArkadeTransactionBuilder.to", () => {
    it("accepts a number amount (a coin's value)", async () => {
        const ark = await connectWith();
        const c = ark.contract(multisigProgram());
        const { arkTx } = await c.functions
            .cooperative()
            .from({ txid: "11".repeat(32), vout: 0, value: 5000 })
            .to(c.pkScript, 5000)
            .build();
        expect(arkTx.getOutput(0).amount).toBe(5000n);
    });
});

describe("Wallet.create spellings", () => {
    const walletInfo = () => ({
        ...info("mutinynet"),
        boardingExitDelay: 144n,
        unilateralExitDelay: 144n,
        dust: 1000n,
        forfeitPubkey: "02" + TEST_SERVER_PUB_KEY_HEX,
        forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
        deprecatedSigners: [],
    });

    it("service fetches getInfo once and wires its providers", async () => {
        const getInfo = vi
            .spyOn(RestArkProvider.prototype, "getInfo")
            .mockResolvedValue(walletInfo() as ArkadeInfo);
        const setup = await (ReadonlyWallet as any).setupWalletConfig(
            {
                identity: ReadonlySingleKey.fromPublicKey(hex.decode("02" + TEST_PUB_KEY_HEX)),
                service: { serverUrl: "http://localhost:7070" },
                storage: {
                    walletRepository: new InMemoryWalletRepository(),
                    contractRepository: new InMemoryContractRepository(),
                },
            },
            TEST_PUB_KEY,
        );

        expect(getInfo).toHaveBeenCalledTimes(1);
        expect(setup.arkProvider.serverUrl).toBe("http://localhost:7070");
        expect(setup.indexerProvider.serverUrl).toBe("http://localhost:7070");
        expect(setup.onchainProvider).toBeInstanceOf(EsploraProvider);
    });

    it("service with { network } rejects a server on another network", async () => {
        vi.spyOn(RestArkProvider.prototype, "getInfo").mockResolvedValue(
            walletInfo() as ArkadeInfo,
        );
        await expect(
            ReadonlyWallet.create({
                identity: ReadonlySingleKey.fromPublicKey(hex.decode("02" + TEST_PUB_KEY_HEX)),
                service: { network: "bitcoin" },
                storage: {
                    walletRepository: new InMemoryWalletRepository(),
                    contractRepository: new InMemoryContractRepository(),
                },
            }),
        ).rejects.toThrow(/network mismatch/);
    });

    it.each([
        ["arkProvider", { arkProvider: {} as any }],
        ["indexerProvider", { indexerProvider: {} as any }],
        ["onchainProvider", { onchainProvider: {} as any }],
    ])("service with %s throws", async (_, extra) => {
        await expect(
            ReadonlyWallet.create({
                identity: ReadonlySingleKey.fromPublicKey(hex.decode("02" + TEST_PUB_KEY_HEX)),
                service: { network: "bitcoin" },
                ...extra,
            }),
        ).rejects.toThrow(/either `service` or/);
    });

    it("mode with walletMode throws", async () => {
        await expect(
            Wallet.create({
                identity: SingleKey.fromHex(privKeyHex),
                mode: "static",
                walletMode: "static",
            }),
        ).rejects.toThrow(/either `mode` or `walletMode`/);
    });

    it("settlement with settlementConfig throws", async () => {
        await expect(
            Wallet.create({
                identity: SingleKey.fromHex(privKeyHex),
                settlement: false,
                settlementConfig: {},
            }),
        ).rejects.toThrow(/either `settlement` or `settlementConfig`/);
    });
});
