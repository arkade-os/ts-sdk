import { hex } from "@scure/base";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DelegateeNotFoundError, RestDelegateeProvider } from "../src/providers/delegatee";
import { defaultTemplateIds } from "../src/script/delegateeTemplate";
import { DelegateeManagerImpl } from "../src/wallet/delegatee";
import vectors from "./fixtures/delegatee/vectors.json";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock("../src/utils/fetch", () => ({
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

const ids = defaultTemplateIds();

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
            slots: [{ name: "funds", onchain: false, tapscripts: ["aa", "bb"] }],
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
            parentId: undefined,
            slots: [
                { name: "funds", onchain: false, tapscripts: ["aa", "bb"], outpoint: undefined },
            ],
            expiresAt: undefined,
            createdAt: undefined,
            updatedAt: undefined,
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
            slots: [],
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

    it("returns a typed delegation lookup with parsed slots", async () => {
        const body = {
            delegation: {
                id: "5",
                address: "tark1x",
                status: "active",
                templateId: "tpl-1",
                slots: [{ name: "funds", onchain: false, tapscripts: ["aa"] }],
            },
            vtxos: [],
            renewals: [],
        };
        respond(body);
        const details = await new RestDelegateeProvider("https://delegatee.test").getDelegation(
            "tark1x",
        );
        expect(details.delegation).toEqual({
            id: 5,
            address: "tark1x",
            status: "active",
            templateId: "tpl-1",
            variables: {},
            parentId: undefined,
            expiresAt: undefined,
            slots: [{ name: "funds", onchain: false, tapscripts: ["aa"], outpoint: undefined }],
            createdAt: undefined,
            updatedAt: undefined,
        });
        expect(details.vtxos).toEqual([]);
        expect(details.renewals).toEqual([]);
    });

    it("accepts a successor, which has no address", async () => {
        respond({
            delegation: { id: "2", status: "active", parentId: "1", templateId: "tpl-1" },
        });
        await expect(
            new RestDelegateeProvider("https://delegatee.test").getDelegation("tark1x"),
        ).resolves.toMatchObject({
            delegation: { address: "", parentId: 1, slots: [] },
        });
    });

    it("rejects a delegation with an unknown status", async () => {
        respond({ delegation: { id: "1", status: "paused", templateId: "t" } });
        await expect(
            new RestDelegateeProvider("https://delegatee.test").getDelegation("tark1x"),
        ).rejects.toThrow("unknown status paused");
    });

    it("parses the coins and renewals of a delegation", async () => {
        respond({
            delegation: {
                id: "5",
                address: "tark1x",
                status: "active",
                templateId: "t",
            },
            vtxos: [
                {
                    outpoint: "aa:0",
                    amount: "100000",
                    expiresAt: "1700000000",
                    assets: [{ assetId: "bb", amount: "18446744073709551615" }],
                    renewableAt: "1699990000",
                },
            ],
            renewals: [
                { outpoints: ["aa:0"], commitmentTxid: "cc", success: true, attemptedAt: "1" },
            ],
        });
        const details = await new RestDelegateeProvider("https://delegatee.test").getDelegation(
            "tark1x",
        );
        expect(details.vtxos).toEqual([
            {
                outpoint: "aa:0",
                amount: 100000,
                expiresAt: 1700000000,
                preconfirmed: false,
                assets: [{ assetId: "bb", amount: 18446744073709551615n }],
                createdAt: undefined,
                renewableAt: 1699990000,
                onchain: false,
            },
        ]);
        expect(details.renewals).toEqual([
            {
                outpoints: ["aa:0"],
                commitmentTxid: "cc",
                success: true,
                error: undefined,
                attemptedAt: 1,
            },
        ]);
    });

    it("rejects non-string variables and a coin without an amount", async () => {
        const provider = new RestDelegateeProvider("https://delegatee.test");
        const delegation = { id: "1", status: "active", templateId: "t" };
        respond({ delegation: { ...delegation, variables: { exit_delay: 512 } } });
        await expect(provider.getDelegation("tark1x")).rejects.toThrow("variables are not strings");
        respond({ delegation, vtxos: [{ outpoint: "aa:0" }] });
        await expect(provider.getDelegation("tark1x")).rejects.toThrow("missing amount");
    });

    it("returns a typed not-found error for an unregistered address", async () => {
        respond("not found", 404);
        await expect(
            new RestDelegateeProvider("https://delegatee.test").getDelegation("tark1missing"),
        ).rejects.toBeInstanceOf(DelegateeNotFoundError);
    });
});

describe("DelegateeManagerImpl.register", () => {
    it("registers the boarding variables and returns the address both sides agree on", async () => {
        const provider = makeProvider();
        contractManager.createContract.mockClear();
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
    });

    it("refuses an address the service derived differently, e.g. under another delegate key", async () => {
        const manager = new DelegateeManagerImpl(makeProvider({ address: "bcrt1pother" }), wallet);
        await expect(manager.registerBoarding(params)).rejects.toThrow(
            `delegatee derived a different address: expected ${vectors.boarding.address}, got bcrt1pother`,
        );
    });

    it("refuses tapscripts the service derived differently", async () => {
        const manager = new DelegateeManagerImpl(
            makeProvider({ slots: [{ name: "deposit", onchain: true, tapscripts: ["00"] }] }),
            wallet,
        );
        await expect(manager.registerBoarding(params)).rejects.toThrow("different tapscripts");
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
            slots: [{ name: "funds", onchain: false, tapscripts: vectors.renewal.tapscripts }],
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
            slots: [{ name: "deposit", onchain: true, tapscripts: vectors.boarding.tapscripts }],
            ...overrides,
        }),
        getDelegation: vi.fn(),
        listTemplates: vi.fn(),
    };
}
