import { hex } from "@scure/base";
import { ScriptNum } from "@scure/btc-signer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RestExecutorProvider } from "../src/providers/executor";
import { ExecutorRequestError } from "../src/providers/executor";
import { DEFAULT_TEMPLATE_IDS as ids } from "../src/script/executor/executorTemplate";
import { ExecutorManagerImpl, watchExecutorContracts } from "../src/wallet/executor";
import { ExecutorContractHandler } from "../src/contracts/handlers/executor";
import { WALLET_RECEIVE_SOURCE } from "../src/contracts/metadata";
import { rateGate } from "../src/providers/rateGate";
import { ContractManager, InMemoryContractRepository, InMemoryWalletRepository } from "../src";
import { ArkAddress } from "../src/script/address";
import { REGTEST_EMULATOR_PUBKEY, networks } from "../src/networks";
import { createMockIndexerProvider, createMockVtxo } from "./contracts/helpers";
import vectors from "./fixtures/executor/vectors.json";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock("../src/utils/fetch", async (importActual) => ({
    ...(await importActual<typeof import("../src/utils/fetch")>()),
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

describe("RestExecutorProvider", () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

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
        const input = { name: "board", onchain: true, script: "51", address: "tark1new" };
        const delegation = {
            id: "7",
            inputs: [input],
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
            inputs: [input],
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

    it("rejects a registration whose signal aborts", async () => {
        mockFetch.mockImplementation(
            (_url: string, init: RequestInit) =>
                new Promise((_, reject) =>
                    init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
                ),
        );
        const controller = new AbortController();
        const pending = new RestExecutorProvider("https://executor.test").registerDelegation(
            "tpl-1",
            {},
            { signal: controller.signal },
        );
        controller.abort(new Error("timed out"));
        await expect(pending).rejects.toThrow("timed out");
    });

    it("parses a delegation's coins, rejecting an unknown status, bad variables and amounts", async () => {
        const provider = new RestExecutorProvider("https://executor.test");
        const input = { name: "board", script: "51", address: "tark1x" };
        const delegation = {
            id: "5",
            inputs: [input],
            status: "active",
            templateId: "t",
        };
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
            delegation: {
                ...delegation,
                id: 5,
                // the gateway omits onchain: false
                inputs: [{ ...input, onchain: false }],
                variables: {},
                expiresAt: undefined,
            },
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
            [
                { delegation: { ...delegation, inputs: [{ ...input, address: "" }] } },
                "input: missing address",
            ],
            [{ delegation: { ...delegation, inputs: {} } }, "inputs is not an array"],
            [{ delegation, coins: [{ outpoint: "aa:0" }] }, "missing amount"],
            [{ delegation, coins: [{ ...coin, status: "gone" }] }, "coin status"],
            [{ delegation, coins: [{ outpoint: "aa:0", amount: -5 }] }, "amount is negative"],
        ] as const) {
            respond(body);
            await expect(provider.getDelegation("tark1x")).rejects.toThrow(error);
        }
    });

    it("parses a delegation without inputs as having none", async () => {
        respond({ delegation: { id: "5", status: "active", templateId: "t" } });
        const { delegation } = await new RestExecutorProvider(
            "https://executor.test",
        ).getDelegation("tark1x");
        expect(delegation.inputs).toEqual([]);
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
    // the vectors' emulator is not regtest's pinned one
    const trusted = { emulatorPubkey: vectors.emulatorPubkey };

    beforeEach(() => {
        contractManager.createContract.mockClear();
        contractManager.updateContract.mockClear();
    });

    it("registers the boarding variables and returns the address both sides agree on", async () => {
        const provider = makeProvider({ expiresAt: 9 });
        const manager = new ExecutorManagerImpl(provider, wallet);

        await expect(
            manager.registerBoarding(params, { expiresAt: 9, ...trusted }),
        ).resolves.toEqual({
            address: vectors.boarding.address,
            templateId: BOARDING_ID,
            variables: vectors.boarding.variables,
            keys: {
                cosignerPubkey: vectors.cosignerPubkey,
                serverPubkey: vectors.serverPubkey,
                emulatorPubkey: vectors.emulatorPubkey,
            },
            params,
            delegation: expect.objectContaining({
                inputs: [expect.objectContaining({ address: vectors.boarding.address })],
            }),
        });
        expect(provider.registerDelegation).toHaveBeenCalledWith(
            BOARDING_ID,
            vectors.boarding.variables,
            { expiresAt: 9, signal: expect.any(AbortSignal) },
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
                delegationRegisteredAt: expect.any(Number),
                delegationExpiresAt: 9,
            },
        ]);
        expect(contractManager.updateContract).toHaveBeenCalledWith(vectors.boarding.pkScript, {
            metadata: {
                delegationStatus: "active",
                delegationRegisteredAt: expect.any(Number),
                delegationExpiresAt: 9,
            },
        });
    });

    it("defaults the exit delays to the operator's", async () => {
        const provider = makeProvider();
        const manager = new ExecutorManagerImpl(provider, wallet);
        const registration = await manager.registerBoarding(
            { renewalWindow: params.renewalWindow, maxFee: params.maxFee },
            trusted,
        );
        expect(provider.registerDelegation).toHaveBeenCalledWith(
            BOARDING_ID,
            vectors.boarding.variables,
            { expiresAt: undefined, signal: expect.any(AbortSignal) },
        );
        expect(wallet.getOperatorInfo).toHaveBeenCalledWith({ requireLive: true });
        // resolved, so watchExecutorContracts restores the watch without the operator
        expect(registration.params).toEqual(params);
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
        await new ExecutorManagerImpl(makeProvider(), wallet).registerBoarding(params, trusted);
        expect(contractManager.updateContract).toHaveBeenCalledWith(vectors.boarding.pkScript, {
            metadata: {
                note: "kept",
                delegationStatus: "active",
                delegationRegisteredAt: expect.any(Number),
            },
        });
    });

    it("refuses a watch the service returns as no longer active", async () => {
        const manager = new ExecutorManagerImpl(makeProvider({ status: "expired" }), wallet);
        await expect(manager.registerBoarding(params, trusted)).rejects.toThrow(
            `Executor watch ${vectors.boarding.address} is expired`,
        );
        // the row carries what the service said, so the wallet stops advertising the address
        expect(contractManager.updateContract).toHaveBeenCalledWith(vectors.boarding.pkScript, {
            metadata: {
                delegationStatus: "expired",
                delegationRegisteredAt: expect.any(Number),
            },
        });
    });

    it("refuses an address the service derived differently, persisting nothing", async () => {
        const manager = new ExecutorManagerImpl(
            makeProvider({
                inputs: [{ ...boardingInput, address: "bcrt1pother" }],
                status: "cancelled",
            }),
            wallet,
        );
        await expect(manager.registerBoarding(params, trusted)).rejects.toThrow(
            `Executor derived a different address: expected ${vectors.boarding.address}, got bcrt1pother`,
        );
        expect(contractManager.createContract).not.toHaveBeenCalled();
        expect(contractManager.updateContract).not.toHaveBeenCalled();
    });

    it("refuses a delegation without exactly one onchain input, persisting nothing", async () => {
        for (const inputs of [
            [boardingInput, { ...boardingInput, name: "other" }],
            [{ ...boardingInput, onchain: false }],
            [],
        ]) {
            const manager = new ExecutorManagerImpl(makeProvider({ inputs }), wallet);
            await expect(manager.registerBoarding(params, trusted)).rejects.toThrow(
                `has ${inputs.length} inputs, expected one onchain input`,
            );
        }
        expect(contractManager.createContract).not.toHaveBeenCalled();
        expect(contractManager.updateContract).not.toHaveBeenCalled();
    });

    it("refuses a service whose operator key is not the wallet's", async () => {
        const provider = makeProvider();
        provider.getInfo.mockResolvedValue({ ...makeInfo(), serverPubkey: vectors.owner });
        const manager = new ExecutorManagerImpl(provider, wallet);
        await expect(manager.registerBoarding(params, trusted)).rejects.toThrow(
            "wallet's operator",
        );
        expect(provider.registerDelegation).not.toHaveBeenCalled();
    });

    it("refuses a renewal window as long as the operator's VTXO expiry", async () => {
        const provider = makeProvider();
        const operator = { ...(await wallet.getOperatorInfo()), vtxoTreeExpiry: 86400n };
        const manager = new ExecutorManagerImpl(provider, {
            ...wallet,
            getOperatorInfo: async () => operator,
        });
        await expect(manager.registerBoarding(params, trusted)).rejects.toThrow(
            "renewalWindow 86400s must be shorter than the operator's VTXO expiry of 86400s",
        );
        expect(provider.registerDelegation).not.toHaveBeenCalled();
        // a block-typed expiry has no duration to compare against
        operator.vtxoTreeExpiry = 144n;
        await expect(manager.registerBoarding(params, trusted)).resolves.toBeDefined();
    });

    it("refuses an emulator key other than the network's pinned one", async () => {
        const provider = makeProvider();
        const manager = new ExecutorManagerImpl(provider, wallet);
        await expect(manager.registerBoarding(params)).rejects.toThrow(
            `Executor's emulator key ${vectors.emulatorPubkey} is not the trusted ${REGTEST_EMULATOR_PUBKEY}`,
        );
        expect(provider.registerDelegation).not.toHaveBeenCalled();
    });

    it("registers the key of the displayed rotated boarding address", async () => {
        // the x-only key of 3G, the newest boarding key the wallet rotated to
        const rotated = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
        const descriptor = `tr(${rotated})`;
        const server = hex.encode(ArkAddress.decode(vectors.renewal.address).serverPubKey);
        contractManager.getContracts.mockResolvedValueOnce([
            {
                type: "boarding",
                params: { pubKey: "11".repeat(32), serverPubKey: server },
                metadata: { source: WALLET_RECEIVE_SOURCE, signingDescriptor: "tr(old)" },
                createdAt: 1,
            },
            {
                type: "boarding",
                params: { pubKey: rotated, serverPubKey: server },
                metadata: { source: WALLET_RECEIVE_SOURCE, signingDescriptor: descriptor },
                createdAt: 2,
            },
        ]);
        const script = ExecutorContractHandler.createScript(
            ExecutorContractHandler.serializeParams({
                template: "boarding",
                owner: hex.decode(`02${rotated}`),
                ...params,
                cosignerPubKey: hex.decode(vectors.cosignerPubkey),
                serverPubKey: hex.decode(vectors.serverPubkey),
                emulatorPubKey: hex.decode(vectors.emulatorPubkey),
            }),
        );
        const address = script.onchainAddress(networks.regtest);
        const provider = makeProvider({ inputs: [{ ...boardingInput, address }] });

        const registration = await new ExecutorManagerImpl(provider, wallet).registerBoarding(
            params,
            trusted,
        );
        expect(registration.address).toBe(address);
        expect(registration.variables.owner).toBe(`02${rotated}`);
        // its rows carry the descriptor, so the wallet signs for them
        expect(contractManager.createContract.mock.calls.map(([c]) => c.metadata)).toEqual([
            { signingDescriptor: descriptor, delegationStatus: "local" },
            {
                signingDescriptor: descriptor,
                delegationStatus: "active",
                delegationRegisteredAt: expect.any(Number),
            },
        ]);
    });

    it("refuses a service on another network than the wallet's operator", async () => {
        const provider = makeProvider();
        provider.getInfo.mockResolvedValue({
            ...(await provider.getInfo()),
            network: "bitcoin",
        });
        const manager = new ExecutorManagerImpl(provider, wallet);
        await expect(manager.registerBoarding(params, trusted)).rejects.toThrow(
            "Executor runs on bitcoin, the wallet's operator on regtest",
        );
        expect(provider.registerDelegation).not.toHaveBeenCalled();
    });
});

describe("ExecutorManagerImpl.registerRenewal", () => {
    const trusted = { emulatorPubkey: vectors.emulatorPubkey };
    const renewalInput = {
        name: "renew",
        onchain: false,
        script: vectors.renewal.pkScript,
        address: vectors.renewal.address,
    };
    // a rotated boarding key the wallet still holds, and a second one
    const heldKeys = [
        "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
        "2f8bde4d1a07209355b4a7250a5c5128e88b84bddc619ab7cba8d569b240efe4",
    ];

    beforeEach(() => {
        contractManager.createContract.mockClear();
        contractManager.updateContract.mockClear();
    });

    /**
     * A provider that answers each registration with the address of the variables it received.
     * `fail` lists the owners and template ids it refuses, read at call time.
     */
    function derivingProvider({ fail = [] }: { fail?: string[] } = {}) {
        const server = hex.decode(vectors.serverPubkey).subarray(1);
        const num = (variables: Record<string, string>, name: string) =>
            Number(ScriptNum().decode(hex.decode(variables[name])));
        return {
            getInfo: vi.fn().mockResolvedValue({
                ...makeInfo(),
                cosignerPubkey: vectors.cosignerPubkey,
                serverPubkey: vectors.serverPubkey,
                emulatorPubkey: vectors.emulatorPubkey,
            }),
            registerDelegation: vi.fn(
                async (templateId: string, variables: Record<string, string>) => {
                    if (fail.includes(variables.owner) || fail.includes(templateId)) {
                        throw new Error("Executor unavailable");
                    }
                    const template = templateId === ids.boarding ? "boarding" : "renewal";
                    const script = ExecutorContractHandler.createScript(
                        ExecutorContractHandler.serializeParams({
                            template,
                            owner: hex.decode(variables.owner),
                            exitDelay: num(variables, "exit_delay"),
                            renewalWindow: num(variables, "renewal_window"),
                            maxFee: num(variables, "max_fee"),
                            ...(template === "boarding"
                                ? { boardingExitDelay: num(variables, "boarding_exit_delay") }
                                : {}),
                            cosignerPubKey: hex.decode(vectors.cosignerPubkey),
                            serverPubKey: hex.decode(vectors.serverPubkey),
                            emulatorPubKey: hex.decode(vectors.emulatorPubkey),
                        }),
                    );
                    return {
                        id: 1,
                        templateId,
                        variables,
                        status: "active" as const,
                        inputs: [
                            template === "boarding"
                                ? {
                                      name: "board",
                                      onchain: true,
                                      script: hex.encode(script.pkScript),
                                      address: script.onchainAddress(networks.regtest),
                                  }
                                : {
                                      name: "renew",
                                      onchain: false,
                                      script: hex.encode(script.pkScript),
                                      address: script.address("tark", server).encode(),
                                  },
                        ],
                    };
                },
            ),
            listTemplates: vi.fn(),
            getDelegation: vi.fn(),
        };
    }

    /** A wallet whose contracts persist, so the registration writes are visible. */
    async function managedWallet(fail: string[] = []) {
        const manager = await ContractManager.create({
            indexerProvider: createMockIndexerProvider(),
            contractRepository: new InMemoryContractRepository(),
            walletRepository: new InMemoryWalletRepository(),
        });
        return {
            wallet: {
                identity,
                getAddress: async () => vectors.renewal.address,
                getContractManager: async () => manager,
                getOperatorInfo: vi.fn(async () => ({
                    network: "regtest",
                    unilateralExitDelay: 512n,
                    boardingExitDelay: 1024n,
                })),
            } as any,
            manager,
            provider: derivingProvider({ fail }),
        };
    }

    /**
     * Persist a live boarding watch for `descriptor`'s key (the identity's when undefined), as an
     * earlier registration would, under other params or an older Executor key if given.
     */
    async function holdBoardingWatch(
        wallet: any,
        descriptor: string | undefined,
        held: { params?: typeof params; keys?: Partial<Record<string, string>> } = {},
    ) {
        await watchExecutorContracts(
            wallet,
            {
                cosignerPubkey: vectors.cosignerPubkey,
                serverPubkey: vectors.serverPubkey,
                emulatorPubkey: vectors.emulatorPubkey,
                ...held.keys,
            },
            held.params ?? params,
            { template: "boarding", status: "active", expiresAt: 0 },
            descriptor,
        );
    }

    /** The renewal calls the provider received, as `owner/maxFee`. */
    const renewalCalls = (provider: ReturnType<typeof derivingProvider>) =>
        provider.registerDelegation.mock.calls
            .filter(([id]) => id === ids.renewal)
            .map(([, v]) => `${v.owner.slice(2, 6)}/${v.max_fee}`);

    /** The rows of `template` as `owner/maxFee/status`, sorted. */
    async function rowsOf(manager: ContractManager, template: "renewal" | "boarding") {
        return (await manager.getContracts({ type: ["executor"] }))
            .filter((c) => c.params.template === template)
            .map(
                (c) =>
                    `${c.params.owner.slice(2, 6)}/${c.params.maxFee}/${c.metadata?.delegationStatus}`,
            )
            .sort();
    }

    // maxFee 500 and 501, as the service's ScriptNum variables
    const FEE = "f401";
    const CHANGED_FEE = "f501";
    const changed = { ...params, maxFee: params.maxFee + 1 };
    const OWNER = vectors.owner.slice(2, 6);
    const HELD = heldKeys.map((k) => k.slice(0, 4));

    /** A wallet whose displayed key has boarding and renewal both live under `params`. */
    async function renewingWallet(fail: string[] = []) {
        const ctx = await managedWallet(fail);
        const executor = new ExecutorManagerImpl(ctx.provider, ctx.wallet);
        await executor.registerBoarding(params, trusted);
        await executor.registerRenewal(params, trusted);
        ctx.provider.registerDelegation.mockClear();
        return { ...ctx, executor };
    }

    it("accepts an offchain input addressed as the v0 Ark address of (hrp, server key, tap key)", async () => {
        // the Executor's addressOf encodes offchain inputs as a version-0 Ark address
        const server = hex.decode(vectors.serverPubkey).subarray(1);
        const script = ExecutorContractHandler.createScript(
            ExecutorContractHandler.serializeParams({
                template: "renewal",
                owner: hex.decode(vectors.owner),
                exitDelay: params.exitDelay,
                renewalWindow: params.renewalWindow,
                maxFee: params.maxFee,
                cosignerPubKey: hex.decode(vectors.cosignerPubkey),
                serverPubKey: hex.decode(vectors.serverPubkey),
                emulatorPubKey: hex.decode(vectors.emulatorPubkey),
            }),
        );
        const address = new ArkAddress(server, script.tweakedPublicKey, "tark").encode();
        expect(address).toBe(vectors.renewal.address);
        await expect(
            new ExecutorManagerImpl(
                makeProvider({ inputs: [{ ...renewalInput, address }] }),
                wallet,
            ).registerRenewal(params, trusted),
        ).resolves.toMatchObject({ address });
    });

    it("refuses a delegation without exactly one offchain input, persisting nothing", async () => {
        for (const inputs of [
            [renewalInput, { ...renewalInput, name: "other" }],
            [{ ...renewalInput, onchain: true }],
            [],
        ]) {
            const manager = new ExecutorManagerImpl(makeProvider({ inputs }), wallet);
            await expect(manager.registerRenewal(params, trusted)).rejects.toThrow(
                `has ${inputs.length} inputs, expected one offchain input`,
            );
        }
        expect(contractManager.createContract).not.toHaveBeenCalled();
        expect(contractManager.updateContract).not.toHaveBeenCalled();
    });

    it("refuses an offchain input at another address, persisting nothing", async () => {
        const manager = new ExecutorManagerImpl(
            makeProvider({ inputs: [{ ...renewalInput, address: "tark1pother" }] }),
            wallet,
        );
        await expect(manager.registerRenewal(params, trusted)).rejects.toThrow(
            `Executor derived a different address: expected ${vectors.renewal.address}, got tark1pother`,
        );
        expect(contractManager.createContract).not.toHaveBeenCalled();
        expect(contractManager.updateContract).not.toHaveBeenCalled();
    });

    describe("when the params change", () => {
        it("registers a new boarding and renewal pair and leaves the old pair live", async () => {
            const { manager, provider, executor } = await renewingWallet();

            await executor.registerBoarding(changed, trusted);
            expect(provider.registerDelegation.mock.calls.map(([id]) => id)).toEqual([
                ids.boarding,
                ids.renewal,
            ]);
            expect(await rowsOf(manager, "boarding")).toEqual([
                `${OWNER}/500/active`,
                `${OWNER}/501/active`,
            ]);
            expect(await rowsOf(manager, "renewal")).toEqual([
                `${OWNER}/500/active`,
                `${OWNER}/501/active`,
            ]);
        });

        it("does not register the renewal watch again when it is already live", async () => {
            const { provider, executor } = await renewingWallet();

            await executor.registerBoarding(params, trusted);
            expect(provider.registerDelegation.mock.calls.map(([id]) => id)).toEqual([
                ids.boarding,
            ]);
        });

        it("registers no renewal for a key without a live renewal watch", async () => {
            const { wallet: managed, manager, provider } = await managedWallet();
            const executor = new ExecutorManagerImpl(provider, managed);
            await executor.registerBoarding(params, trusted);
            await executor.registerBoarding(changed, trusted);

            expect(provider.registerDelegation.mock.calls.map(([id]) => id)).toEqual([
                ids.boarding,
                ids.boarding,
            ]);
            // the companions stay local: the wallet renews what they receive itself
            expect(await rowsOf(manager, "renewal")).toEqual([
                `${OWNER}/500/local`,
                `${OWNER}/501/local`,
            ]);
        });

        it("keeps the boarding watch when the renewal paired with it fails", async () => {
            const fail: string[] = [];
            const { manager, executor } = await renewingWallet(fail);
            fail.push(ids.renewal);
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

            const registration = await executor.registerBoarding(changed, trusted);
            expect(registration.params.maxFee).toBe(changed.maxFee);
            expect(await rowsOf(manager, "boarding")).toContain(`${OWNER}/501/active`);
            expect(await rowsOf(manager, "renewal")).toContain(`${OWNER}/501/local`);
            expect(warn).toHaveBeenCalled();
            warn.mockRestore();

            // registerRenewal retries it
            fail.length = 0;
            await executor.registerRenewal(params, trusted);
            expect(await rowsOf(manager, "renewal")).toContain(`${OWNER}/501/active`);
        });

        it("registers renewal for each live boarding watch under its own params", async () => {
            const { wallet: managed, manager, provider } = await managedWallet();
            const executor = new ExecutorManagerImpl(provider, managed);
            await executor.registerBoarding(params, trusted);
            await holdBoardingWatch(managed, `tr(${heldKeys[0]})`);
            provider.registerDelegation.mockClear();

            await executor.registerRenewal(changed, trusted);
            const calls = renewalCalls(provider);
            // the displayed key under the options first, then the watches' own params
            expect(calls[0]).toBe(`${OWNER}/${CHANGED_FEE}`);
            expect(calls.slice(1).sort()).toEqual([`${HELD[0]}/${FEE}`, `${OWNER}/${FEE}`].sort());
            expect(await rowsOf(manager, "renewal")).toEqual(
                [`${OWNER}/500/active`, `${OWNER}/501/active`, `${HELD[0]}/500/active`].sort(),
            );
        });

        it("registers a renewal contract once, however many boarding watches pay into it", async () => {
            const { wallet: managed, provider } = await managedWallet();
            const executor = new ExecutorManagerImpl(provider, managed);
            await executor.registerBoarding(params, trusted);
            // only the boarding exit delay differs: the renewal contract is the same
            await executor.registerBoarding(
                { ...params, boardingExitDelay: params.boardingExitDelay + 1 },
                trusted,
            );
            provider.registerDelegation.mockClear();

            await executor.registerRenewal(params, trusted);
            expect(renewalCalls(provider)).toEqual([`${OWNER}/${FEE}`]);
        });
    });

    it("skips a boarding watch under another emulator key, warning with its key", async () => {
        const { wallet: managed, manager, provider } = await managedWallet();
        // its coins sit in a contract the Executor's current emulator key does not derive
        await holdBoardingWatch(managed, `tr(${heldKeys[0]})`, {
            keys: { emulatorPubkey: vectors.cosignerPubkey },
        });
        await holdBoardingWatch(managed, `tr(${heldKeys[1]})`);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        await expect(
            new ExecutorManagerImpl(provider, managed).registerRenewal(params, trusted),
        ).resolves.toBeDefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(heldKeys[0]));
        warn.mockRestore();

        // the other key was registered; the old contract was not
        expect(provider.registerDelegation.mock.calls.map(([, v]) => v.owner)).toEqual([
            vectors.owner,
            `02${heldKeys[1]}`,
        ]);
        expect(await rowsOf(manager, "renewal")).not.toContain(`${HELD[0]}/500/active`);
    });

    it("skips a boarding watch whose window is past the VTXO expiry, warning with its key", async () => {
        const { wallet: managed, provider } = await managedWallet();
        const operator = await managed.getOperatorInfo();
        managed.getOperatorInfo.mockResolvedValue({ ...operator, vtxoTreeExpiry: 172800n });
        // registered when the operator's expiry was longer
        await holdBoardingWatch(managed, `tr(${heldKeys[0]})`, {
            params: { ...params, renewalWindow: 172800 },
        });
        await holdBoardingWatch(managed, `tr(${heldKeys[1]})`);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        await expect(
            new ExecutorManagerImpl(provider, managed).registerRenewal(params, trusted),
        ).resolves.toBeDefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(heldKeys[0]));
        warn.mockRestore();

        expect(provider.registerDelegation.mock.calls.map(([, v]) => v.owner)).toEqual([
            vectors.owner,
            `02${heldKeys[1]}`,
        ]);
    });

    it("reads the Executor and the operator once, however many keys it registers", async () => {
        const { wallet: managed, provider } = await managedWallet();
        // the x-only key of 4G, a third held key
        const held = [
            ...heldKeys,
            "e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13",
        ];
        for (const key of held) await holdBoardingWatch(managed, `tr(${key})`);

        await new ExecutorManagerImpl(provider, managed).registerRenewal(params, trusted);
        // the displayed key and each held one cost a registration; the reads are shared
        expect(provider.registerDelegation).toHaveBeenCalledTimes(held.length + 1);
        expect(provider.getInfo).toHaveBeenCalledOnce();
        expect(managed.getOperatorInfo.mock.calls).toEqual([[{ requireLive: true }]]);
    });

    it("throws at once when the displayed key fails, trying no other", async () => {
        const { wallet: managed, provider } = await managedWallet([vectors.owner]);
        await holdBoardingWatch(managed, `tr(${heldKeys[0]})`);

        await expect(
            new ExecutorManagerImpl(provider, managed).registerRenewal(params, trusted),
        ).rejects.toThrow("Executor unavailable");
        expect(provider.registerDelegation).toHaveBeenCalledOnce();
    });

    it("activates the renewal row when renewal is registered after boarding", async () => {
        const { wallet: managed, manager, provider } = await managedWallet();
        const executor = new ExecutorManagerImpl(provider, managed);
        await executor.registerBoarding(params, trusted);
        const statuses = new Map(
            (await manager.getContracts({ type: ["executor"] })).map((c) => [
                c.params.template,
                c.metadata?.delegationStatus,
            ]),
        );
        expect(statuses.get("renewal")).toBe("local");
        expect(statuses.get("boarding")).toBe("active");

        await executor.registerRenewal(params, trusted);
        const [renewal] = (await manager.getContracts({ type: ["executor"] })).filter(
            (c) => c.params.template === "renewal",
        );
        expect(renewal.metadata?.delegationStatus).toBe("active");
    });

    it("does not demote the active renewal row when boarding is registered after renewal", async () => {
        const { wallet: managed, manager, provider } = await managedWallet();
        const executor = new ExecutorManagerImpl(provider, managed);
        await executor.registerRenewal(params, trusted);
        await executor.registerBoarding(params, trusted);
        const [renewal] = (await manager.getContracts({ type: ["executor"] })).filter(
            (c) => c.params.template === "renewal",
        );
        expect(renewal.metadata?.delegationStatus).toBe("active");
    });

    it("registers the displayed boarding key first, then every held live boarding key", async () => {
        const { wallet: managed, manager, provider } = await managedWallet();
        await holdBoardingWatch(managed, `tr(${heldKeys[0]})`);
        await holdBoardingWatch(managed, `tr(${heldKeys[1]})`);

        const first = await new ExecutorManagerImpl(provider, managed).registerRenewal(
            params,
            trusted,
        );
        // the displayed key is the identity's: no rotated receive row
        expect(first.variables.owner).toBe(vectors.owner);
        const owners = provider.registerDelegation.mock.calls.map(([, v]) => v.owner);
        expect(owners[0]).toBe(vectors.owner);
        // every held key was registered; same-timestamp rows have no stable order
        expect(new Set(owners.slice(1))).toEqual(new Set(heldKeys.map((k) => `02${k}`)));
        // each held key's renewal row went live
        const statuses = new Map(
            (await manager.getContracts({ type: ["executor"] }))
                .filter((c) => c.params.template === "renewal")
                .map((c) => [c.params.owner, c.metadata?.delegationStatus]),
        );
        expect(statuses.get(`02${heldKeys[0]}`)).toBe("active");
        expect(statuses.get(`02${heldKeys[1]}`)).toBe("active");
    });

    it("throws only after trying every key, naming the keys that failed", async () => {
        const { wallet: managed, provider } = await managedWallet([`02${heldKeys[0]}`]);
        await holdBoardingWatch(managed, `tr(${heldKeys[0]})`);
        await holdBoardingWatch(managed, `tr(${heldKeys[1]})`);

        const pending = new ExecutorManagerImpl(provider, managed).registerRenewal(params, trusted);
        await expect(pending).rejects.toThrow(
            `Executor renewal registration failed for the keys ${heldKeys[0]}`,
        );
        // the second key was still tried and registered; same-timestamp rows have no stable order
        const owners = provider.registerDelegation.mock.calls.map(([, v]) => v.owner);
        expect(owners[0]).toBe(vectors.owner);
        expect(new Set(owners.slice(1))).toEqual(new Set(heldKeys.map((k) => `02${k}`)));
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
const identity = {
    compressedPublicKey: async () => hex.decode(vectors.owner),
    xOnlyPublicKey: async () => hex.decode(vectors.owner).subarray(1),
};
const contractManager = {
    // no rotated boarding row: the identity's key is displayed
    getContracts: vi.fn(async (): Promise<unknown[]> => []),
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

const boardingInput = {
    name: "board",
    onchain: true,
    script: vectors.boarding.pkScript,
    address: vectors.boarding.address,
};

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
            inputs: [boardingInput],
            status: "active",
            templateId: BOARDING_ID,
            variables: vectors.boarding.variables,
            ...overrides,
        }),
        getDelegation: vi.fn(),
        listTemplates: vi.fn(),
    };
}
