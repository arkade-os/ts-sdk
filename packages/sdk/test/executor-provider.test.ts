import { hex } from "@scure/base";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RestExecutorProvider } from "../src/providers/executor";
import { ExecutorRequestError } from "../src/providers/executor";
import { DEFAULT_TEMPLATE_IDS as ids } from "../src/script/executor/executorTemplate";
import { ExecutorManagerImpl, watchExecutorContracts } from "../src/wallet/executor";
import { rateGate } from "../src/providers/rateGate";
import { ContractManager, InMemoryContractRepository, InMemoryWalletRepository } from "../src";
import { ArkAddress } from "../src/script/address";
import { createMockIndexerProvider, createMockVtxo } from "./contracts/helpers";
import vectors from "./fixtures/executor/vectors.json";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock("../src/utils/fetch", () => ({
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

describe("RestExecutorProvider", () => {
    beforeEach(() => mockFetch.mockReset());

    it("fetches info without a query and ignores stale covenant fields", async () => {
        const info = makeInfo();
        respond({
            ...info,
            cosignerPubkey: info.cosignerPubkey,
            renewalWindow: 1024,
            arkadeScript: "00",
        });
        const provider = new RestExecutorProvider("https://executor.test/");

        await expect(provider.getInfo()).resolves.toEqual(info);
        expect(mockFetch).toHaveBeenCalledWith("https://executor.test/v1/info");
    });

    it("rejects info with a non-compressed key", async () => {
        respond({ ...makeInfo(), cosignerPubkey: hex.encode(ownerKey) });
        await expect(new RestExecutorProvider("https://executor.test").getInfo()).rejects.toThrow(
            "cosignerPubkey is not compressed",
        );
    });

    it("lists templates", async () => {
        respond({ templates: [template] });
        await expect(
            new RestExecutorProvider("https://executor.test").listTemplates(),
        ).resolves.toEqual([template]);
        expect(mockFetch).toHaveBeenCalledWith("https://executor.test/v1/templates");
    });

    it("posts templateId and variables and unwraps the delegation", async () => {
        const delegation = {
            id: "7",
            address: "tark1new",
            status: "active",
            templateId: "tpl-1",
            variables: { owner: "aa" },
        };
        respond({ delegation });
        await expect(
            new RestExecutorProvider("https://executor.test").registerDelegation("tpl-1", {
                owner: "aa",
            }),
        ).resolves.toEqual({
            id: 7,
            address: "tark1new",
            status: "active",
            templateId: "tpl-1",
            variables: { owner: "aa" },
            expiresAt: undefined,
        });
        expect(mockFetch).toHaveBeenCalledWith("https://executor.test/v1/delegation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ templateId: "tpl-1", variables: { owner: "aa" } }),
        });
    });

    it("includes expiresAt in the request when given, and omits it otherwise", async () => {
        const delegation = {
            id: "1",
            address: "tark1x",
            status: "active",
            templateId: "tpl-1",
        };
        respond({ delegation });
        await new RestExecutorProvider("https://executor.test").registerDelegation(
            "tpl-1",
            {},
            { expiresAt: 1700000000 },
        );
        expect(mockFetch).toHaveBeenCalledWith("https://executor.test/v1/delegation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ templateId: "tpl-1", variables: {}, expiresAt: 1700000000 }),
        });
    });

    it("surfaces the daemon's error body on a failed registration", async () => {
        respond("template disabled", 412);
        await expect(
            new RestExecutorProvider("https://executor.test").registerDelegation("tpl-1", {}),
        ).rejects.toThrow("template disabled");
    });

    it("parses a delegation's coins, rejecting an unknown status, bad variables and amounts", async () => {
        const provider = new RestExecutorProvider("https://executor.test");
        const delegation = { id: "5", address: "tark1x", status: "active", templateId: "t" };
        const coin = { outpoint: "aa:0", amount: "100000", due: "1699990000", status: "present" };
        const spent = { ...coin, outpoint: "bb:0", status: "spent" };
        const parsed = {
            amount: 100000,
            expiresAt: undefined,
            due: 1699990000,
            spentBy: undefined,
        };
        respond({ delegation, coins: [coin, spent] });
        await expect(provider.getDelegation("tark1x")).resolves.toEqual({
            delegation: { ...delegation, id: 5, variables: {}, expiresAt: undefined },
            coins: [
                { ...parsed, outpoint: "aa:0", status: "present" },
                { ...parsed, outpoint: "bb:0", status: "spent" },
            ],
        });
        expect(mockFetch).toHaveBeenCalledWith(
            "https://executor.test/v1/delegation?address=tark1x",
        );
        for (const [body, error] of [
            [{ delegation: { ...delegation, status: "paused" } }, "unknown status paused"],
            [{ delegation: { ...delegation, variables: { a: 1 } } }, "variables are not strings"],
            [{ delegation: { ...delegation, id: "1.5" } }, "id is not an integer"],
            [{ delegation, coins: [{ outpoint: "aa:0" }] }, "missing amount"],
            [{ delegation, coins: [{ ...coin, status: "gone" }] }, "coin status"],
            [{ delegation, coins: [{ outpoint: "aa:0", amount: -5 }] }, "amount is negative"],
        ] as const) {
            respond(body);
            await expect(provider.getDelegation("tark1x")).rejects.toThrow(error);
        }
    });

    it("tells an unknown watch from an unrouted path, both 404", async () => {
        const provider = new RestExecutorProvider("https://executor.test");

        respond({ code: 5, message: "delegation not found", details: [] }, 404);
        await expect(provider.getDelegation("tark1x")).rejects.toMatchObject({ status: 404 });

        for (const body of [{ code: 5, message: "Not Found", details: [] }, "<html>404</html>"]) {
            respond(body, 404);
            const error = await provider.getDelegation("tark1x").catch((e) => e);
            expect(error).toBeInstanceOf(ExecutorRequestError);
            expect(error.status).toBeUndefined();
        }

        respond("boom", 500);
        await expect(provider.getDelegation("tark1x")).rejects.toMatchObject({ status: 500 });
    });
    it("reports a rate-limited registration to the shared gate", async () => {
        const report = vi.spyOn(rateGate, "reportRateLimited");
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 429,
            headers: { get: () => "3" },
            text: () => Promise.resolve("slow down"),
        });
        await expect(
            new RestExecutorProvider("https://executor.test").registerDelegation("tpl-1", {}),
        ).rejects.toMatchObject({ status: 429 });
        expect(report).toHaveBeenCalledWith("https://executor.test/v1/delegation", "3");
        report.mockRestore();
        rateGate.reset();
    });
});

describe("ExecutorManagerImpl.register", () => {
    beforeEach(() => {
        contractManager.createContract.mockClear();
        contractManager.updateContract.mockClear();
    });

    it("registers the boarding variables and returns the address both sides agree on", async () => {
        const provider = makeProvider({ expiresAt: 9 });
        const manager = new ExecutorManagerImpl(provider, wallet);

        await expect(manager.registerBoarding(params, { expiresAt: 9 })).resolves.toEqual({
            address: vectors.boarding.address,
            templateId: BOARDING_ID,
            variables: vectors.boarding.variables,
            keys: {
                cosignerPubkey: vectors.cosignerPubkey,
                serverPubkey: vectors.serverPubkey,
                emulatorPubkey: vectors.emulatorPubkey,
            },
            delegation: expect.objectContaining({ address: vectors.boarding.address }),
        });
        expect(provider.registerDelegation).toHaveBeenCalledWith(
            BOARDING_ID,
            vectors.boarding.variables,
            { expiresAt: 9 },
        );
        // the wallet watches the boarding contract and the renewal contract it boards to
        expect(contractManager.createContract.mock.calls.map(([c]) => c.script)).toEqual([
            vectors.renewal.pkScript,
            vectors.boarding.pkScript,
        ]);
        expect(contractManager.createContract.mock.calls.map(([c]) => c.metadata)).toEqual([
            { delegationStatus: "local" },
            {
                delegationStatus: "active",
                delegationExpiresAt: 9,
                delegationAddress: vectors.boarding.address,
            },
        ]);
        expect(contractManager.updateContract).toHaveBeenCalledWith(vectors.boarding.pkScript, {
            metadata: {
                delegationStatus: "active",
                delegationExpiresAt: 9,
                delegationAddress: vectors.boarding.address,
            },
        });
    });

    it("defaults the exit delays to the operator's", async () => {
        const provider = makeProvider();
        const manager = new ExecutorManagerImpl(provider, wallet);
        await manager.registerBoarding({
            renewalWindow: params.renewalWindow,
            maxFee: params.maxFee,
        });
        expect(provider.registerDelegation).toHaveBeenCalledWith(
            BOARDING_ID,
            vectors.boarding.variables,
            { expiresAt: undefined },
        );
        expect(wallet.getOperatorInfo).toHaveBeenCalledWith({ requireLive: true });
    });

    it("drops a stale expiry when the service answers without one", async () => {
        contractManager.createContract.mockImplementationOnce(async (c: { script: string }) => ({
            ...c,
            state: "active",
            createdAt: 0,
        }));
        contractManager.createContract.mockImplementationOnce(async (c: { script: string }) => ({
            ...c,
            metadata: { delegationStatus: "active", delegationExpiresAt: 5, note: "kept" },
            state: "active",
            createdAt: 0,
        }));
        await new ExecutorManagerImpl(makeProvider(), wallet).registerBoarding(params);
        expect(contractManager.updateContract).toHaveBeenCalledWith(vectors.boarding.pkScript, {
            metadata: {
                note: "kept",
                delegationStatus: "active",
                delegationAddress: vectors.boarding.address,
            },
        });
    });

    it("refuses a watch the service returns as no longer active", async () => {
        const manager = new ExecutorManagerImpl(makeProvider({ status: "expired" }), wallet);
        await expect(manager.registerBoarding(params)).rejects.toThrow(
            `Executor watch ${vectors.boarding.address} is expired`,
        );
        // the row carries what the service said, so the wallet stops advertising the address
        expect(contractManager.updateContract).toHaveBeenCalledWith(vectors.boarding.pkScript, {
            metadata: {
                delegationStatus: "expired",
                delegationAddress: vectors.boarding.address,
            },
        });
    });

    it("refuses an address the service derived differently, persisting nothing", async () => {
        const manager = new ExecutorManagerImpl(
            makeProvider({ address: "bcrt1pother", status: "cancelled" }),
            wallet,
        );
        await expect(manager.registerBoarding(params)).rejects.toThrow(
            `Executor derived a different address: expected ${vectors.boarding.address}, got bcrt1pother`,
        );
        expect(contractManager.createContract).not.toHaveBeenCalled();
        expect(contractManager.updateContract).not.toHaveBeenCalled();
    });

    it("refuses a service whose operator key is not the wallet's", async () => {
        const provider = makeProvider();
        provider.getInfo.mockResolvedValue({ ...makeInfo(), serverPubkey: vectors.owner });
        const manager = new ExecutorManagerImpl(provider, wallet);
        await expect(manager.registerBoarding(params)).rejects.toThrow("wallet's operator");
        expect(provider.registerDelegation).not.toHaveBeenCalled();
    });

    it("refuses a service on another network than the wallet's operator", async () => {
        const provider = makeProvider();
        provider.getInfo.mockResolvedValue({
            ...(await provider.getInfo()),
            network: "bitcoin",
        });
        const manager = new ExecutorManagerImpl(provider, wallet);
        await expect(manager.registerBoarding(params)).rejects.toThrow(
            "Executor runs on bitcoin, the wallet's operator on regtest",
        );
        expect(provider.registerDelegation).not.toHaveBeenCalled();
    });
});

describe("ExecutorManagerImpl.defaultTemplates", () => {
    const listed = (...names: ("renewal" | "boarding")[]) =>
        names.map((n) => ({ id: ids[n], status: "active" }));

    it("returns the default ids when the service lists them active", async () => {
        const provider = makeProvider();
        provider.listTemplates.mockResolvedValue(listed("boarding", "renewal"));
        await expect(new ExecutorManagerImpl(provider, wallet).defaultTemplates()).resolves.toEqual(
            { renewal: ids.renewal, boarding: ids.boarding },
        );
    });

    it("refuses a service that does not list one of them", async () => {
        const provider = makeProvider();
        provider.listTemplates.mockResolvedValue(listed("boarding"));
        await expect(new ExecutorManagerImpl(provider, wallet).defaultTemplates()).rejects.toThrow(
            `renewal ${ids.renewal}`,
        );
    });
});

describe("watchExecutorContracts", () => {
    it("registers the wallet's renewal and boarding contracts, which then hold its virtual outputs", async () => {
        const indexerProvider = createMockIndexerProvider();
        const delegated = createMockVtxo({ script: vectors.renewal.pkScript, value: 4321 });
        indexerProvider.getVtxos = vi
            .fn()
            .mockImplementation(async ({ scripts }: { scripts?: string[] }) => ({
                vtxos: scripts?.includes(vectors.renewal.pkScript) ? [delegated] : [],
            }));
        const manager = await ContractManager.create({
            indexerProvider,
            contractRepository: new InMemoryContractRepository(),
            walletRepository: new InMemoryWalletRepository(),
        });
        const serverXOnly = hex.decode(vectors.serverPubkey).subarray(1);
        const restored = {
            identity,
            getAddress: async () =>
                new ArkAddress(serverXOnly, new Uint8Array(32).fill(1), "tark").encode(),
            getContractManager: async () => manager,
        } as unknown as Parameters<typeof watchExecutorContracts>[0];
        const keys = {
            cosignerPubkey: vectors.cosignerPubkey,
            serverPubkey: vectors.serverPubkey,
            emulatorPubkey: vectors.emulatorPubkey,
        };

        const contracts = await watchExecutorContracts(restored, keys, params);
        expect(contracts.map((c) => c.script)).toEqual([
            vectors.renewal.pkScript,
            vectors.boarding.pkScript,
        ]);
        expect(contracts[0].address).toBe(vectors.renewal.address);
        // a restore cannot tell a companion from a registered watch: it claims neither
        expect(contracts.map((c) => c.metadata?.delegationStatus)).toEqual([undefined, undefined]);
        await expect(watchExecutorContracts(restored, keys, params)).resolves.toHaveLength(2);
        const { boardingExitDelay: _, ...renewalOnly } = params;
        await expect(watchExecutorContracts(restored, keys, renewalOnly)).resolves.toHaveLength(1);

        const held = await manager.getContractsWithVtxos({ script: vectors.renewal.pkScript });
        expect(held[0].vtxos.map((v) => v.value)).toEqual([4321]);
        manager.dispose();
    });
});

// the variables of the vectors: 512 s and 1024 s in BIP 68, a day, 500 sats
const params = {
    exitDelay: 0x400001,
    renewalWindow: 86400,
    maxFee: 500,
    boardingExitDelay: 0x400002,
};

const compressedKey = hex.decode(
    "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
);
const ownerKey = hex.decode("c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5");

function makeInfo() {
    return {
        version: "test",
        network: "regtest",
        cosignerPubkey: hex.encode(compressedKey),
        serverPubkey: hex.encode(compressedKey),
        emulatorPubkey: hex.encode(compressedKey),
    };
}

const template = { id: "tpl-1", status: "active" };

const respond = (body: unknown, status = 200) =>
    mockFetch.mockResolvedValueOnce({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    });

const BOARDING_ID = ids.boarding;
const identity = { compressedPublicKey: async () => hex.decode(vectors.owner) };
const contractManager = {
    createContract: vi.fn(async (c: { script: string; metadata?: Record<string, unknown> }) => ({
        ...c,
        state: "active",
        createdAt: 0,
    })),
    updateContract: vi.fn(),
};
const wallet = {
    identity,
    // any Arkade address of the vectors' operator
    getAddress: async () => vectors.renewal.address,
    getContractManager: async () => contractManager,
    // the vectors' delays: 512 s and 1024 s
    getOperatorInfo: vi.fn(async () => ({
        network: "regtest",
        unilateralExitDelay: 512n,
        boardingExitDelay: 1024n,
    })),
} as any;

function makeProvider(overrides: Record<string, unknown> = {}) {
    return {
        getInfo: vi.fn().mockResolvedValue({
            ...makeInfo(),
            cosignerPubkey: vectors.cosignerPubkey,
            serverPubkey: vectors.serverPubkey,
            emulatorPubkey: vectors.emulatorPubkey,
        }),
        registerDelegation: vi.fn().mockResolvedValue({
            id: 2,
            address: vectors.boarding.address,
            status: "active",
            templateId: BOARDING_ID,
            variables: vectors.boarding.variables,
            ...overrides,
        }),
        getDelegation: vi.fn(),
        listTemplates: vi.fn(),
    };
}
