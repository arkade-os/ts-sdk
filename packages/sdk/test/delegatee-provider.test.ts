import { hex } from "@scure/base";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RestDelegateeProvider } from "../src/providers/delegatee";
import { DelegateeRequestError } from "../src/providers/delegatee";
import { DEFAULT_TEMPLATE_IDS as ids } from "../src/script/delegatee/delegateeTemplate";
import { DelegateeManagerImpl } from "../src/wallet/delegatee";
import { DelegateeContractHandler } from "../src/contracts/handlers/delegatee";
import vectors from "./fixtures/delegatee/vectors.json";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock("../src/utils/fetch", () => ({
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

describe("RestDelegateeProvider", () => {
    beforeEach(() => mockFetch.mockReset());

    it("fetches info without a query and ignores stale covenant fields", async () => {
        const info = makeInfo();
        respond({ ...info, renewalWindow: 1024, arkadeScript: "00" });
        const provider = new RestDelegateeProvider("https://delegatee.test/");

        await expect(provider.getInfo()).resolves.toEqual(info);
        expect(mockFetch).toHaveBeenCalledWith("https://delegatee.test/v1/info");
    });

    it("rejects info with a non-compressed key", async () => {
        respond({ ...makeInfo(), delegatePubkey: hex.encode(ownerKey) });
        await expect(new RestDelegateeProvider("https://delegatee.test").getInfo()).rejects.toThrow(
            "delegatePubkey is not compressed",
        );
    });

    it("lists templates", async () => {
        respond({ templates: [template] });
        await expect(
            new RestDelegateeProvider("https://delegatee.test").listTemplates(),
        ).resolves.toEqual([template]);
        expect(mockFetch).toHaveBeenCalledWith("https://delegatee.test/v1/template");
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
            new RestDelegateeProvider("https://delegatee.test").registerDelegation("tpl-1", {
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
        expect(mockFetch).toHaveBeenCalledWith("https://delegatee.test/v1/delegate", {
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
        await new RestDelegateeProvider("https://delegatee.test").registerDelegation(
            "tpl-1",
            {},
            { expiresAt: 1700000000 },
        );
        expect(mockFetch).toHaveBeenCalledWith("https://delegatee.test/v1/delegate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ templateId: "tpl-1", variables: {}, expiresAt: 1700000000 }),
        });
    });

    it("surfaces the daemon's error body on a failed registration", async () => {
        respond("template disabled", 412);
        await expect(
            new RestDelegateeProvider("https://delegatee.test").registerDelegation("tpl-1", {}),
        ).rejects.toThrow("template disabled");
    });

    it("parses a delegation's coins, rejecting an unknown status, bad variables and amounts", async () => {
        const provider = new RestDelegateeProvider("https://delegatee.test");
        const delegation = { id: "5", address: "tark1x", status: "active", templateId: "t" };
        const coin = { outpoint: "aa:0", amount: "100000", renewableAt: "1699990000" };
        respond({ delegation, vtxos: [coin] });
        await expect(provider.getDelegation("tark1x")).resolves.toEqual({
            delegation: { ...delegation, id: 5, variables: {}, expiresAt: undefined },
            vtxos: [{ ...coin, amount: 100000, expiresAt: undefined, renewableAt: 1699990000 }],
        });
        for (const [body, error] of [
            [{ delegation: { ...delegation, status: "paused" } }, "unknown status paused"],
            [{ delegation: { ...delegation, variables: { a: 1 } } }, "variables are not strings"],
            [{ delegation: { ...delegation, id: "1.5" } }, "id is not an integer"],
            [{ delegation, vtxos: [{ outpoint: "aa:0" }] }, "missing amount"],
            [{ delegation, vtxos: [{ outpoint: "aa:0", amount: -5 }] }, "amount is negative"],
        ] as const) {
            respond(body);
            await expect(provider.getDelegation("tark1x")).rejects.toThrow(error);
        }
    });
});

describe("DelegateeManagerImpl.register", () => {
    it("registers the boarding variables and returns the address both sides agree on", async () => {
        const provider = makeProvider({ expiresAt: 9 });
        contractManager.createContract.mockClear();
        contractManager.updateContract.mockClear();
        const manager = new DelegateeManagerImpl(provider, wallet);

        await expect(manager.registerBoarding(params, { expiresAt: 9 })).resolves.toEqual({
            address: vectors.boarding.address,
            templateId: BOARDING_ID,
            variables: vectors.boarding.variables,
            keys: {
                delegatePubkey: vectors.delegatePubkey,
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
        expect(contractManager.updateContract).toHaveBeenCalledWith(vectors.boarding.pkScript, {
            metadata: {
                delegationStatus: "active",
                delegationExpiresAt: 9,
                delegationAddress: vectors.boarding.address,
            },
        });
    });

    it("refuses a watch the service returns as no longer active", async () => {
        contractManager.createContract.mockClear();
        contractManager.updateContract.mockClear();
        const manager = new DelegateeManagerImpl(makeProvider({ status: "expired" }), wallet);
        await expect(manager.registerBoarding(params)).rejects.toThrow(
            `delegatee watch ${vectors.boarding.address} is expired`,
        );
        // the row carries what the service said, so the wallet stops advertising the address
        expect(contractManager.createContract.mock.calls.map(([c]) => c.script)).toEqual([
            vectors.renewal.pkScript,
            vectors.boarding.pkScript,
        ]);
        expect(contractManager.updateContract).toHaveBeenCalledWith(vectors.boarding.pkScript, {
            metadata: {
                delegationStatus: "expired",
                delegationAddress: vectors.boarding.address,
            },
        });
    });

    it("refuses an address the service derived differently, e.g. under another delegate key", async () => {
        const manager = new DelegateeManagerImpl(makeProvider({ address: "bcrt1pother" }), wallet);
        await expect(manager.registerBoarding(params)).rejects.toThrow(
            `delegatee derived a different address: expected ${vectors.boarding.address}, got bcrt1pother`,
        );
    });

    it("persists nothing for an ended watch the service derived differently", async () => {
        contractManager.createContract.mockClear();
        contractManager.updateContract.mockClear();
        const manager = new DelegateeManagerImpl(
            makeProvider({ address: "bcrt1pother", status: "cancelled" }),
            wallet,
        );
        await expect(manager.registerBoarding(params)).rejects.toThrow(
            "delegatee derived a different address",
        );
        // a row must never carry an address that does not derive from its script
        expect(contractManager.createContract).not.toHaveBeenCalled();
        expect(contractManager.updateContract).not.toHaveBeenCalled();
    });

    it("refuses a service whose server key is not the wallet's", async () => {
        const provider = makeProvider();
        provider.getInfo.mockResolvedValue({ ...makeInfo(), serverPubkey: vectors.owner });
        const manager = new DelegateeManagerImpl(provider, wallet);
        await expect(manager.registerBoarding(params)).rejects.toThrow("wallet's server");
        expect(provider.registerDelegation).not.toHaveBeenCalled();
    });

    it("needs a boarding exit delay for boarding", async () => {
        const { boardingExitDelay: _, ...renewalOnly } = params;
        const manager = new DelegateeManagerImpl(makeProvider(), wallet);
        await expect(manager.registerBoarding(renewalOnly)).rejects.toThrow(
            "boarding needs an exit delay",
        );
    });
});

describe("DelegateeManagerImpl.defaultTemplates", () => {
    const listed = (...names: ("renewal" | "boarding")[]) =>
        names.map((n) => ({ id: ids[n], status: "active" }));

    it("returns the default ids when the service lists them active", async () => {
        const provider = makeProvider();
        provider.listTemplates.mockResolvedValue(listed("boarding", "renewal"));
        await expect(
            new DelegateeManagerImpl(provider, wallet).defaultTemplates(),
        ).resolves.toEqual({ renewal: ids.renewal, boarding: ids.boarding });
    });

    it("refuses a service that does not list one of them", async () => {
        const provider = makeProvider();
        provider.listTemplates.mockResolvedValue(listed("boarding"));
        await expect(new DelegateeManagerImpl(provider, wallet).defaultTemplates()).rejects.toThrow(
            `renewal ${ids.renewal}`,
        );
    });
});

describe("DelegateeManagerImpl.delegateVtxos", () => {
    const RENEWAL_ID = ids.renewal;
    const renewalProvider = () =>
        makeProvider({
            address: vectors.renewal.address,
            templateId: RENEWAL_ID,
            variables: vectors.renewal.variables,
        });

    it("registers the renewal watch and sends every spendable VTXO to it", async () => {
        const provider = renewalProvider();
        contractManager.createContract.mockClear();
        const vtxos = [
            { txid: "aa", vout: 0, value: 1000, assets: [{ assetId: "x", amount: 5n }] },
            { txid: "bb", vout: 1, value: 2500, assets: [{ assetId: "x", amount: 2n }] },
            // already delegated: stays
            { txid: "cc", vout: 0, value: 9000, script: vectors.renewal.pkScript },
        ];
        const w = {
            ...wallet,
            getSpendableVtxos: vi.fn().mockResolvedValue(vtxos),
            send: vi.fn().mockResolvedValue("txid"),
        };
        const got = await new DelegateeManagerImpl(provider, w).delegateVtxos(params);
        expect(w.getSpendableVtxos).toHaveBeenCalledWith({
            withRecoverable: false,
            genericallySpendableOnly: true,
        });
        expect(got).toMatchObject({
            address: vectors.renewal.address,
            templateId: RENEWAL_ID,
            variables: vectors.renewal.variables,
            txid: "txid",
        });
        expect(provider.registerDelegation).toHaveBeenCalledWith(
            RENEWAL_ID,
            vectors.renewal.variables,
            {},
        );
        expect(contractManager.createContract.mock.calls.map(([c]) => c.script)).toEqual([
            vectors.renewal.pkScript,
        ]);
        expect(w.send).toHaveBeenCalledWith({
            recipients: [
                {
                    address: vectors.renewal.address,
                    amount: 3500,
                    assets: [{ assetId: "x", amount: 7n }],
                },
            ],
            selectedVtxos: vtxos.slice(0, 2),
        });
    });

    it("only registers when there is nothing to send", async () => {
        const w = { ...wallet, getSpendableVtxos: vi.fn().mockResolvedValue([]), send: vi.fn() };
        const got = await new DelegateeManagerImpl(renewalProvider(), w).delegateVtxos(params);
        expect(got.txid).toBeUndefined();
        expect(w.send).not.toHaveBeenCalled();
    });

    it("retires the wallet's own receive contracts, which stay watched", async () => {
        contractManager.setContractState.mockClear();
        const w = { ...wallet, getSpendableVtxos: vi.fn().mockResolvedValue([]), send: vi.fn() };
        await new DelegateeManagerImpl(renewalProvider(), w).delegateVtxos(params);
        expect(contractManager.getContracts).toHaveBeenCalledWith({
            type: ["default", "delegate"],
            state: "active",
        });
        expect(contractManager.setContractState.mock.calls).toEqual([
            ["51default", "inactive"],
            ["51delegate", "inactive"],
        ]);
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
        delegatePubkey: hex.encode(compressedKey),
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
const wallet = {
    identity,
    // any Ark address of the vectors' server
    getAddress: async () => vectors.renewal.address,
    getSpendableVtxos: vi.fn(),
    send: vi.fn(),
    getContractManager: async () => contractManager,
} as any;
const contractManager = {
    createContract: vi.fn(async (c: { script: string }) => ({
        ...c,
        state: "active",
        createdAt: 0,
    })),
    // the wallet's own receive contracts, which migration retires
    getContracts: vi.fn(async () => [{ script: "51default" }, { script: "51delegate" }]),
    setContractState: vi.fn(),
    updateContract: vi.fn(),
};

function makeProvider(overrides: Record<string, unknown> = {}) {
    return {
        getInfo: vi.fn().mockResolvedValue({
            ...makeInfo(),
            delegatePubkey: vectors.delegatePubkey,
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

describe("DelegateeManagerImpl.refreshStatus", () => {
    /** A delegatee row as the repository holds it: the renewal watch of the wallet's key. */
    async function makeRow(metadata: Record<string, unknown> = {}) {
        const params = DelegateeContractHandler.serializeParams({
            template: "renewal",
            owner: hex.decode(vectors.owner),
            exitDelay: 0x400001,
            renewalWindow: 86400,
            maxFee: 500,
            delegatePubKey: hex.decode(vectors.delegatePubkey),
            serverPubKey: hex.decode(vectors.serverPubkey),
            emulatorPubKey: hex.decode(vectors.emulatorPubkey),
        });
        const script = DelegateeContractHandler.createScript(params);
        return {
            type: "delegatee",
            params,
            script: hex.encode(script.pkScript),
            address: script.address("tark", hex.decode(vectors.serverPubkey).subarray(1)).encode(),
            state: "active" as const,
            createdAt: 0,
            metadata,
        };
    }

    function makeRefreshManager(rows: unknown[]) {
        const repo = {
            getContracts: vi.fn(async () => rows),
            updateContract: vi.fn(),
        };
        return { repo, w: { ...wallet, getContractManager: async () => repo } };
    }

    it("persists the status the service reports", async () => {
        const row = await makeRow({
            delegationStatus: "active",
            delegationAddress: vectors.renewal.address,
        });
        const { repo, w } = makeRefreshManager([row]);
        const provider = makeProvider();
        provider.getDelegation.mockResolvedValue({
            delegation: {
                id: 1,
                address: vectors.renewal.address,
                status: "expired",
                variables: {},
                expiresAt: undefined,
            },
            vtxos: [],
        });

        const got = await new DelegateeManagerImpl(provider, w).refreshStatus();

        expect(got).toEqual([
            { script: row.script, address: vectors.renewal.address, status: "expired" },
        ]);
        expect(repo.updateContract).toHaveBeenCalledWith(row.script, {
            metadata: {
                delegationStatus: "expired",
                delegationAddress: vectors.renewal.address,
            },
        });
    });

    it("ends a watch the service does not know anymore", async () => {
        const row = await makeRow({
            delegationStatus: "active",
            delegationAddress: vectors.renewal.address,
        });
        const { repo, w } = makeRefreshManager([row]);
        const provider = makeProvider();
        provider.getDelegation.mockRejectedValue(
            new DelegateeRequestError("Failed to get delegatee delegation (404): not found", 404),
        );

        const got = await new DelegateeManagerImpl(provider, w).refreshStatus();

        expect(got).toEqual([
            { script: row.script, address: vectors.renewal.address, status: "gone" },
        ]);
        expect(repo.updateContract).toHaveBeenCalledWith(row.script, {
            metadata: {
                delegationStatus: "gone",
                delegationAddress: vectors.renewal.address,
            },
        });
    });

    it("keeps the persisted status on a 404 the service itself did not answer", async () => {
        const row = await makeRow({
            delegationStatus: "active",
            delegationAddress: vectors.renewal.address,
        });
        const { repo, w } = makeRefreshManager([row]);
        const provider = makeProvider();
        // a wrong base URL: every path 404s, info included
        provider.getInfo.mockRejectedValue(
            new DelegateeRequestError("Failed to get delegatee info (404): not found", 404),
        );
        provider.getDelegation.mockRejectedValue(
            new DelegateeRequestError("Failed to get delegatee delegation (404): not found", 404),
        );

        const got = await new DelegateeManagerImpl(provider, w).refreshStatus();

        expect(got).toEqual([
            {
                script: row.script,
                address: vectors.renewal.address,
                status: "active",
                error: "Failed to get delegatee delegation (404): not found",
            },
        ]);
        expect(repo.updateContract).not.toHaveBeenCalled();
    });

    it("keeps the persisted status when the service cannot be reached", async () => {
        const row = await makeRow({
            delegationStatus: "active",
            delegationAddress: vectors.renewal.address,
        });
        const { repo, w } = makeRefreshManager([row]);
        const provider = makeProvider();
        provider.getDelegation.mockRejectedValue(new Error("connection refused"));

        const got = await new DelegateeManagerImpl(provider, w).refreshStatus();

        expect(got).toEqual([
            {
                script: row.script,
                address: vectors.renewal.address,
                status: "active",
                error: "connection refused",
            },
        ]);
        // a network failure never moves the wallet's addresses
        expect(repo.updateContract).not.toHaveBeenCalled();
    });

    it("does not ask the service about a row it never registered", async () => {
        const row = await makeRow({ delegationStatus: "local" });
        const { repo, w } = makeRefreshManager([row]);
        const provider = makeProvider();

        const got = await new DelegateeManagerImpl(provider, w).refreshStatus();

        expect(got).toEqual([]);
        expect(provider.getDelegation).not.toHaveBeenCalled();
        expect(repo.updateContract).not.toHaveBeenCalled();
    });

    it("asks about a row written before the watch address was persisted", async () => {
        const row = await makeRow({ delegationStatus: "active" });
        const { repo, w } = makeRefreshManager([row]);
        const provider = makeProvider();
        provider.getDelegation.mockResolvedValue({
            delegation: {
                id: 1,
                address: vectors.renewal.address,
                status: "active",
                variables: {},
                expiresAt: undefined,
            },
            vtxos: [],
        });

        await new DelegateeManagerImpl(provider, w).refreshStatus();

        expect(provider.getDelegation).toHaveBeenCalledWith(vectors.renewal.address);
        expect(repo.updateContract).toHaveBeenCalledWith(row.script, {
            metadata: {
                delegationStatus: "active",
                delegationAddress: vectors.renewal.address,
            },
        });
    });

    it("asks about a row a restore re-derived, which carries no status", async () => {
        const row = await makeRow({});
        const { repo, w } = makeRefreshManager([row]);
        const provider = makeProvider();
        provider.getDelegation.mockResolvedValue({
            delegation: {
                id: 1,
                address: vectors.renewal.address,
                status: "active",
                variables: {},
                expiresAt: 4102444800,
            },
            vtxos: [],
        });

        const got = await new DelegateeManagerImpl(provider, w).refreshStatus();

        expect(provider.getDelegation).toHaveBeenCalledWith(vectors.renewal.address);
        expect(got).toEqual([
            {
                script: row.script,
                address: vectors.renewal.address,
                status: "active",
                expiresAt: 4102444800,
            },
        ]);
        expect(repo.updateContract).toHaveBeenCalledWith(row.script, {
            metadata: {
                delegationStatus: "active",
                delegationExpiresAt: 4102444800,
                delegationAddress: vectors.renewal.address,
            },
        });
    });
});
