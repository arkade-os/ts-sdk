import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hex } from "@scure/base";
import { ScriptNum } from "@scure/btc-signer";
import {
    Batch,
    ContractManager,
    ContractWatcher,
    ExecutorContractHandler,
    ExecutorRequestError,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    MnemonicIdentity,
    RestArkProvider,
    SingleKey,
    Wallet,
    networks,
    type Contract,
    type ExecutorProvider,
    type ExtendedVirtualCoin,
} from "../src";
import { collectContracts, type ContractFilter } from "../src/repositories/contractRepository";
import { saveVtxosForContract } from "../src/contracts/vtxoOwnership";
import { collectVtxos } from "../src/repositories/walletRepository";
import { REGISTRATION_TIMEOUT_MS } from "../src/wallet/executor";
import { DEFAULT_TEMPLATE_IDS } from "../src/script/executor/executorTemplate";
import { getOwnBoardingAddress } from "../src/wallet/utils";
import { createMockExtendedVtxo } from "./contracts/helpers";
import vectors from "./fixtures/executor/vectors.json";
import { jsonResponse } from "./helpers/response";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("../src/utils/fetch", async (importActual) => ({
    ...(await importActual<typeof import("../src/utils/fetch")>()),
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

const SERVER_KEY_HEX = vectors.serverPubkey;
const arkInfo = {
    signerPubkey: SERVER_KEY_HEX,
    forfeitPubkey: SERVER_KEY_HEX,
    batchExpiry: BigInt(144),
    unilateralExitDelay: BigInt(144),
    boardingExitDelay: BigInt(144),
    roundInterval: BigInt(144),
    network: "mutinynet",
    dust: BigInt(1000),
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    checkpointTapscript:
        "039d0440b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac",
};
const identity = SingleKey.fromHex(
    "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2",
);
// an Executor is configured; the wallet never calls it for its addresses
const executorProvider = {} as ExecutorProvider;
const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

async function executorRow(
    template: "renewal" | "boarding",
    owner: Pick<SingleKey, "compressedPublicKey"> = identity,
) {
    const params = ExecutorContractHandler.serializeParams({
        template,
        owner: await owner.compressedPublicKey(),
        exitDelay: 144,
        renewalWindow: 1000,
        maxFee: 100,
        ...(template === "boarding" ? { boardingExitDelay: 144 } : {}),
        cosignerPubKey: hex.decode(vectors.cosignerPubkey),
        serverPubKey: hex.decode(SERVER_KEY_HEX),
        emulatorPubKey: hex.decode(vectors.emulatorPubkey),
    });
    const script = ExecutorContractHandler.createScript(params);
    return {
        script,
        contract: {
            type: "executor",
            params,
            script: hex.encode(script.pkScript),
            address: script.address("tark", hex.decode(SERVER_KEY_HEX).subarray(1)).encode(),
            state: "active" as const,
            createdAt: Date.now(),
            metadata: {
                delegationStatus: template === "boarding" ? "active" : "local",
            } as Record<string, unknown>,
        },
    };
}

async function walletWith(options: { executor: boolean; rows: boolean }) {
    const contractRepository = new InMemoryContractRepository();
    const renewal = await executorRow("renewal");
    const boarding = await executorRow("boarding");
    if (options.rows) {
        await contractRepository.saveContract(renewal.contract);
        await contractRepository.saveContract(boarding.contract);
    }
    const wallet = await Wallet.create({
        identity,
        arkProvider: new RestArkProvider("http://localhost:7070"),
        storage: { walletRepository: new InMemoryWalletRepository(), contractRepository },
        settlementConfig: false,
        ...(options.executor ? { executorProvider } : {}),
    });
    return { wallet, renewal, boarding };
}

/**
 * An HD wallet with a live watch at its identity key, and an Executor that registers more.
 * `coinAtRenewal` stores a coin at that key's renewal contract before the wallet starts. `hold`
 * leaves every registration pending until `open()`, `fail()` or its signal aborts. `lazy` boots
 * the contract manager in the background. `delegation` is what the Executor says of a watch it is
 * asked about: held, `expired`, or `missing` (a 404).
 */
async function hdWalletWithWatch({
    refuse = false,
    coinAtRenewal = false,
    hold = false,
    lazy = false,
    renewalLive = false,
    failRenewal = false,
    delegation = "active",
}: {
    refuse?: boolean;
    coinAtRenewal?: boolean;
    hold?: boolean;
    lazy?: boolean;
    renewalLive?: boolean;
    failRenewal?: boolean;
    delegation?: "active" | "expired" | "missing";
} = {}) {
    // an HD wallet subscribes to its contracts at boot
    vi.stubGlobal(
        "EventSource",
        vi.fn().mockImplementation((url: string) => ({ url, close: vi.fn() })),
    );
    mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("/info")) return jsonResponse(arkInfo);
        if (url.includes("subscri")) return jsonResponse({ subscriptionId: "sub-1" });
        if (url.includes("vtxo") || url.includes("scripts")) return jsonResponse({ vtxos: [] });
        return jsonResponse([]);
    });
    const hd = MnemonicIdentity.fromMnemonic(MNEMONIC, { isMainnet: false });
    const renewal = await executorRow("renewal", hd);
    const boarding = await executorRow("boarding", hd);
    const contractRepository = new InMemoryContractRepository();
    await contractRepository.saveContract(
        renewalLive
            ? { ...renewal.contract, metadata: { delegationStatus: "active" } }
            : renewal.contract,
    );
    await contractRepository.saveContract(boarding.contract);
    const walletRepository = new InMemoryWalletRepository();
    if (coinAtRenewal) {
        await saveVtxosForContract(walletRepository, renewal.contract, [
            createMockExtendedVtxo({ script: renewal.contract.script }),
        ]);
    }
    let open!: () => void;
    let fail!: (e: unknown) => void;
    const gate = hold
        ? new Promise<void>((resolve, reject) => {
              open = resolve;
              fail = reject;
          })
        : undefined;
    const registerDelegation = vi.fn(
        async (
            templateId: string,
            variables: Record<string, string>,
            options?: { signal?: AbortSignal },
        ) => {
            if (gate) {
                await Promise.race([
                    gate,
                    new Promise<never>((_, reject) =>
                        options?.signal?.addEventListener("abort", () =>
                            reject(options.signal?.reason),
                        ),
                    ),
                ]);
            }
            if (refuse) throw new Error("Executor unavailable");
            const template = templateId === DEFAULT_TEMPLATE_IDS.boarding ? "boarding" : "renewal";
            if (failRenewal && template === "renewal") throw new Error("Executor unavailable");
            const num = (name: string) => Number(ScriptNum().decode(hex.decode(variables[name])));
            const script = ExecutorContractHandler.createScript(
                ExecutorContractHandler.serializeParams({
                    template,
                    owner: hex.decode(variables.owner),
                    exitDelay: num("exit_delay"),
                    renewalWindow: num("renewal_window"),
                    maxFee: num("max_fee"),
                    ...(template === "boarding"
                        ? { boardingExitDelay: num("boarding_exit_delay") }
                        : {}),
                    cosignerPubKey: hex.decode(vectors.cosignerPubkey),
                    serverPubKey: hex.decode(SERVER_KEY_HEX),
                    emulatorPubKey: hex.decode(vectors.emulatorPubkey),
                }),
            );
            return {
                id: 1,
                templateId,
                variables,
                status: "active",
                inputs: [
                    {
                        name: template,
                        onchain: template === "boarding",
                        script: hex.encode(script.pkScript),
                        address:
                            template === "boarding"
                                ? script.onchainAddress(networks.mutinynet)
                                : script
                                      .address("tark", hex.decode(SERVER_KEY_HEX).subarray(1))
                                      .encode(),
                    },
                ],
            };
        },
    );
    const getDelegation = vi.fn(async () => {
        if (delegation === "missing") throw new ExecutorRequestError("delegation not found", 404);
        return { delegation: { status: delegation }, coins: [] };
    });
    const wallet = await Wallet.create({
        identity: hd,
        walletMode: "hd",
        arkProvider: new RestArkProvider("http://localhost:7070"),
        storage: { walletRepository, contractRepository },
        settlementConfig: false,
        ...(lazy ? { lazyInitialization: true } : {}),
        executorProvider: {
            getInfo: async () => ({
                version: "test",
                network: "mutinynet",
                cosignerPubkey: vectors.cosignerPubkey,
                serverPubkey: SERVER_KEY_HEX,
                emulatorPubkey: vectors.emulatorPubkey,
            }),
            registerDelegation,
            getDelegation,
        } as unknown as ExecutorProvider,
    });
    const owner = hex.encode(await hd.compressedPublicKey());
    return {
        wallet,
        renewal,
        boarding,
        registerDelegation,
        getDelegation,
        owner,
        open,
        fail,
        walletRepository,
    };
}

/** A coin at `row`'s contract, with an outpoint named by `txidByte`. */
function coin(row: Awaited<ReturnType<typeof executorRow>>, txidByte: string) {
    return createMockExtendedVtxo({
        script: row.contract.script,
        txid: txidByte.repeat(32),
    });
}

/**
 * Sends part of a coin at `renewal`, as the delegated coin's owner; the change comes back to that
 * contract, which is what the contract manager would report.
 */
async function sendFromRenewal(
    { wallet, renewal, walletRepository }: Awaited<ReturnType<typeof hdWalletWithWatch>>,
    boarded: ExtendedVirtualCoin,
) {
    const input = { ...boarded, isPreconfirmed: true, expiresAt: new Date(Date.now() + 36e6) };
    await saveVtxosForContract(walletRepository, renewal.contract, [input]);
    const arkTxid = "ee".repeat(32);
    vi.spyOn(wallet as any, "_buildAndSubmitOffchainTx").mockResolvedValue({
        arkTxid,
        signedCheckpointTxs: [],
    });
    await wallet.send({
        recipients: [{ address: vectors.renewal.address, amount: 4_000 }],
        selectedVtxos: [input],
    });
    const stored = await collectVtxos(walletRepository, renewal.contract.address);
    return stored.find((v) => v.txid === arkTxid)!;
}

/** Delivers a contract event to the wallet's subscribers, as the watcher does. */
async function deliverContractEvent(
    wallet: Wallet,
    type: "vtxo_received" | "vtxo_spent",
    contract: Contract,
    vtxos: ExtendedVirtualCoin[],
) {
    const manager = await wallet.getContractManager();
    for (const cb of (manager as any).eventCallbacks as Set<(e: unknown) => void>) {
        cb({
            type,
            contractScript: contract.script,
            contract,
            vtxos: vtxos.map((v) => ({ ...v, contractScript: contract.script })),
            timestamp: Date.now(),
        });
    }
}

/** {@link deliverContractEvent}, then the rotation it queued. */
async function emitContractEvent(
    wallet: Wallet,
    type: "vtxo_received" | "vtxo_spent",
    contract: Contract,
    vtxos: ExtendedVirtualCoin[],
) {
    await deliverContractEvent(wallet, type, contract, vtxos);
    await boardChainIdle(wallet);
}

// a boarding input: the non-VTXO coin a settle consumes
const boardingCoin = {
    txid: "ab".repeat(32),
    vout: 0,
    value: 100_000,
    status: { confirmed: true },
};

/** The queued rotations, including any a running one queues. */
async function boardChainIdle(wallet: Wallet) {
    let chain: Promise<void>;
    do {
        chain = (wallet as any)._executorBoardChain;
        await chain;
    } while (chain !== (wallet as any)._executorBoardChain);
}

/** Stubs what a settle needs from the operator, so that it commits `commitment-txid`. */
function stubSettle(wallet: Wallet) {
    const w = wallet as any;
    w.arkProvider.getEventStream = vi.fn().mockReturnValue((async function* () {})());
    w.makeRegisterIntentSignature = vi.fn().mockResolvedValue({ proof: "", message: {} });
    w.makeDeleteIntentSignature = vi.fn().mockResolvedValue({ proof: "", message: {} });
    w.safeRegisterIntent = vi.fn().mockResolvedValue("intent-id");
    w.persistIntentSnapshot = vi.fn();
    w.createBatchHandler = vi.fn().mockReturnValue({});
    w.updateDbAfterSettle = vi.fn();
    return vi.spyOn(Batch, "join").mockResolvedValue("commitment-txid");
}

/** Whether `promise` settled within a few turns of the event loop. */
async function settlesSoon(promise: Promise<unknown>): Promise<boolean> {
    let settled = false;
    promise.then(
        () => (settled = true),
        () => (settled = true),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    return settled;
}

describe("delegated boarding address on an HD wallet", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("follows the most recently registered params, and back to the first on a rollback", async () => {
        // registrations a millisecond apart would order by their rows' creation instead
        vi.useFakeTimers({ toFake: ["Date"] });
        const { wallet, boarding } = await hdWalletWithWatch();
        const executor = (await wallet.getExecutorManager())!;
        const register = (maxFee: number) =>
            executor.registerBoarding(
                { renewalWindow: 1000, maxFee, exitDelay: 144, boardingExitDelay: 144 },
                { emulatorPubkey: vectors.emulatorPubkey },
            );
        const first = boarding.script.onchainAddress(networks.mutinynet);
        expect(await wallet.getBoardingAddress()).toBe(first);

        vi.setSystemTime(Date.now() + 1000);
        const changed = (await register(200)).address;
        expect(changed).not.toBe(first);
        expect(await wallet.getBoardingAddress()).toBe(changed);

        vi.setSystemTime(Date.now() + 1000);
        expect((await register(100)).address).toBe(first);
        expect(await wallet.getBoardingAddress()).toBe(first);
        // the other watch's deposits are still the wallet's
        expect(await wallet.getBoardingAddresses()).toContain(changed);
        await wallet.dispose();
    });

    it("gives a rotated boarding key a watch of its own", async () => {
        const { wallet, boarding, registerDelegation, owner } = await hdWalletWithWatch();
        const first = boarding.script.onchainAddress(networks.mutinynet);
        expect(await wallet.getBoardingAddress()).toBe(first);

        const next = await wallet.getNewBoardingAddress();
        expect(next).not.toBe(first);
        expect(next).not.toBe(wallet.ownBoardingAddress());
        expect(await wallet.getBoardingAddress()).toBe(next);
        const [[, variables]] = registerDelegation.mock.calls;
        expect(variables.owner.slice(2)).toBe(hex.encode(wallet.boardingTapscript.options.pubKey));
        expect(variables.owner).not.toBe(owner);
        // the first watch's deposits are still the wallet's
        expect(await wallet.getBoardingAddresses()).toContain(first);
        await wallet.dispose();
    });

    it("extends the new key with both watches when a renewal watch is live", async () => {
        const { wallet, boarding, registerDelegation } = await hdWalletWithWatch({
            renewalLive: true,
        });
        const first = boarding.script.onchainAddress(networks.mutinynet);

        const next = await wallet.getNewBoardingAddress();
        expect(next).not.toBe(first);
        // the new key got a boarding watch and the renewal watch its deposits land in
        expect(registerDelegation.mock.calls.map(([id]) => id).sort()).toEqual([
            DEFAULT_TEMPLATE_IDS.boarding,
            DEFAULT_TEMPLATE_IDS.renewal,
        ]);
        const [[, boardingVars], [, renewalVars]] = registerDelegation.mock.calls;
        expect(renewalVars.owner).toBe(boardingVars.owner);
        // the new key's renewal row is live, so the Executor renews its coins too
        const [newRenewal] = (
            await collectContracts(wallet.contractRepository, {
                type: ["executor"],
            })
        ).filter((c) => c.params.template === "renewal" && c.params.owner === renewalVars.owner);
        expect(newRenewal.metadata?.delegationStatus).toBe("active");
        await wallet.dispose();
    });

    it("registers boarding only when no renewal watch is live", async () => {
        const { wallet, registerDelegation } = await hdWalletWithWatch();

        await wallet.getNewBoardingAddress();
        expect(registerDelegation).toHaveBeenCalledOnce();
        expect(registerDelegation.mock.calls[0][0]).toBe(DEFAULT_TEMPLATE_IDS.boarding);
        await wallet.dispose();
    });

    it("still registers the boarding watch when the renewal one fails", async () => {
        const { wallet, boarding, registerDelegation } = await hdWalletWithWatch({
            renewalLive: true,
            failRenewal: true,
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const first = boarding.script.onchainAddress(networks.mutinynet);

        const next = await wallet.getNewBoardingAddress();
        expect(next).not.toBe(first);
        expect(next).not.toBe(wallet.ownBoardingAddress());
        // both were attempted; only the boarding one took
        expect(registerDelegation).toHaveBeenCalledTimes(2);
        expect(registerDelegation.mock.calls[0][0]).toBe(DEFAULT_TEMPLATE_IDS.boarding);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
        await wallet.dispose();
    });

    it("shows the rotated key's own address when the Executor refuses it a watch", async () => {
        const { wallet, boarding, registerDelegation } = await hdWalletWithWatch({
            refuse: true,
        });
        const first = boarding.script.onchainAddress(networks.mutinynet);

        const next = await wallet.getNewBoardingAddress();
        expect(registerDelegation).toHaveBeenCalledOnce();
        expect(next).toBe(wallet.ownBoardingAddress());
        expect(next).not.toBe(first);
        await wallet.dispose();
    });

    it("rotates once the Executor boards a deposit at the displayed key", async () => {
        const { wallet, boarding, renewal, registerDelegation } = await hdWalletWithWatch();
        const first = boarding.script.onchainAddress(networks.mutinynet);

        await emitContractEvent(wallet, "vtxo_received", renewal.contract, [coin(renewal, "aa")]);
        expect(await wallet.getBoardingAddress()).not.toBe(first);
        expect(registerDelegation).toHaveBeenCalledOnce();
        await wallet.dispose();
    });

    it("does not rotate again when the Executor renews the coin it boarded", async () => {
        const { wallet, boarding, renewal, registerDelegation } = await hdWalletWithWatch();
        const first = boarding.script.onchainAddress(networks.mutinynet);
        const boarded = coin(renewal, "aa");
        await emitContractEvent(wallet, "vtxo_received", renewal.contract, [boarded]);
        const next = await wallet.getBoardingAddress();
        expect(next).not.toBe(first);

        // the renewal spends the outpoint and locks a new one back at the same script
        await emitContractEvent(wallet, "vtxo_spent", renewal.contract, [boarded]);
        await emitContractEvent(wallet, "vtxo_received", renewal.contract, [coin(renewal, "bb")]);
        expect(await wallet.getBoardingAddress()).toBe(next);
        expect(registerDelegation).toHaveBeenCalledOnce();
        await wallet.dispose();
    });

    it("does not rotate for the change of a coin the Executor boarded", async () => {
        const fx = await hdWalletWithWatch({ renewalLive: true });
        const { wallet, boarding, renewal, registerDelegation } = fx;
        const first = boarding.script.onchainAddress(networks.mutinynet);
        const boarded = coin(renewal, "aa");
        await emitContractEvent(wallet, "vtxo_received", renewal.contract, [boarded]);
        const next = await wallet.getBoardingAddress();
        expect(next).not.toBe(first);

        const change = await sendFromRenewal(fx, boarded);
        await emitContractEvent(wallet, "vtxo_received", renewal.contract, [change]);
        expect(await wallet.getBoardingAddress()).toBe(next);
        // the one rotation's boarding and renewal watches
        expect(registerDelegation).toHaveBeenCalledTimes(2);
        await wallet.dispose();
    });

    it("rotates when the change lands after the deposit's own rotation failed", async () => {
        const fx = await hdWalletWithWatch({ renewalLive: true });
        const { wallet, boarding, renewal, registerDelegation } = fx;
        const first = boarding.script.onchainAddress(networks.mutinynet);
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(wallet as any, "rotateBoarding").mockRejectedValueOnce(new Error("no index"));
        const boarded = coin(renewal, "aa");
        await emitContractEvent(wallet, "vtxo_received", renewal.contract, [boarded]);
        expect(await wallet.getBoardingAddress()).toBe(first);

        const change = await sendFromRenewal(fx, boarded);
        await emitContractEvent(wallet, "vtxo_received", renewal.contract, [change]);
        expect(await wallet.getBoardingAddress()).not.toBe(first);
        expect(registerDelegation).toHaveBeenCalledTimes(2);
        await wallet.dispose();
    });

    it("rotates at boot for a coin already at the displayed key's renewal contract", async () => {
        const { wallet, boarding, registerDelegation } = await hdWalletWithWatch({
            coinAtRenewal: true,
        });
        const first = boarding.script.onchainAddress(networks.mutinynet);

        // no event: the coin was stored before the wallet subscribed
        await boardChainIdle(wallet);
        const next = await wallet.getBoardingAddress();
        expect(next).not.toBe(first);
        expect(registerDelegation).toHaveBeenCalledOnce();

        // the coin stays at the old key's contract: another start must not rotate again
        await (wallet as any).rotateForExecutorCoinAtBoot();
        await boardChainIdle(wallet);
        expect(await wallet.getBoardingAddress()).toBe(next);
        expect(registerDelegation).toHaveBeenCalledOnce();
        await wallet.dispose();
    });

    describe("with a lazy boot that writes the coin", () => {
        /** A lazy wallet whose boot sync is held, and writes the boarded coin silently. */
        async function lazyWalletWithBootCoin() {
            let finishBoot!: () => void;
            const booting = new Promise<void>((resolve) => (finishBoot = resolve));
            vi.spyOn(ContractManager.prototype as any, "reconcileWatched").mockReturnValue(booting);
            // nothing but the sync may report the coin
            vi.spyOn(ContractWatcher.prototype, "startWatching").mockResolvedValue(() => {});
            const w = await hdWalletWithWatch({ lazy: true });
            await saveVtxosForContract(w.walletRepository, w.renewal.contract, [
                createMockExtendedVtxo({ script: w.renewal.contract.script }),
            ]);
            expect(w.registerDelegation).not.toHaveBeenCalled();
            return { ...w, finishBoot };
        }

        it("rotates once the boot has finished", async () => {
            const { wallet, boarding, registerDelegation, finishBoot } =
                await lazyWalletWithBootCoin();
            const first = boarding.script.onchainAddress(networks.mutinynet);

            finishBoot();
            await vi.waitFor(() => expect(registerDelegation).toHaveBeenCalledOnce());
            await boardChainIdle(wallet);

            expect(await wallet.getBoardingAddress()).not.toBe(first);
            expect(registerDelegation).toHaveBeenCalledOnce();
            await wallet.dispose();
        });

        it("drains the rotation the boot scan queues before it disposes", async () => {
            const { wallet, registerDelegation, finishBoot } = await lazyWalletWithBootCoin();

            const disposed = wallet.dispose();
            // let dispose reach the drain, which waits on the held boot
            await new Promise((resolve) => setTimeout(resolve, 50));
            finishBoot();
            await disposed;

            expect(registerDelegation).toHaveBeenCalledOnce();
        });
    });

    describe("rotation after a settle", () => {
        it("returns the commitment and frees the tx lock while the watch is still registering", async () => {
            const { wallet, registerDelegation, open } = await hdWalletWithWatch({ hold: true });
            stubSettle(wallet);

            const first = wallet.settle({ inputs: [boardingCoin as any], outputs: [] });
            expect(await settlesSoon(first)).toBe(true);
            await expect(first).resolves.toBe("commitment-txid");
            await vi.waitFor(() => expect(registerDelegation).toHaveBeenCalledOnce());

            // the lock is free: a second settle proceeds, behind the first rotation
            const second = wallet.settle({ inputs: [boardingCoin as any], outputs: [] });
            expect(await settlesSoon(second)).toBe(true);
            await expect(second).resolves.toBe("commitment-txid");
            expect(registerDelegation).toHaveBeenCalledOnce();

            open();
            await boardChainIdle(wallet);
            await wallet.dispose();
        });

        it("keeps the old delegated address until the new watch is registered", async () => {
            const { wallet, boarding, registerDelegation, open } = await hdWalletWithWatch({
                hold: true,
            });
            const old = boarding.script.onchainAddress(networks.mutinynet);

            await (wallet as any).maybeRotateBoardingAfterBoard([boardingCoin]);
            await vi.waitFor(() => expect(registerDelegation).toHaveBeenCalledOnce());
            expect(await wallet.getBoardingAddress()).toBe(old);

            open();
            await boardChainIdle(wallet);
            const next = await wallet.getBoardingAddress();
            expect(next).not.toBe(old);
            expect(next).not.toBe(wallet.ownBoardingAddress());
            await wallet.dispose();
        });

        it("shows the new key's own address when its registration fails", async () => {
            const { wallet, boarding, registerDelegation, fail } = await hdWalletWithWatch({
                hold: true,
            });
            const old = boarding.script.onchainAddress(networks.mutinynet);
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

            await (wallet as any).maybeRotateBoardingAfterBoard([boardingCoin]);
            await vi.waitFor(() => expect(registerDelegation).toHaveBeenCalledOnce());
            expect(await wallet.getBoardingAddress()).toBe(old);

            fail(new Error("Executor unavailable"));
            await boardChainIdle(wallet);
            expect(await wallet.getBoardingAddress()).toBe(wallet.ownBoardingAddress());
            expect(await wallet.getBoardingAddress()).not.toBe(old);
            expect(warn).toHaveBeenCalled();
            await wallet.dispose();
        });

        it("does not rotate a second time for a deposit the Executor boards meanwhile", async () => {
            const { wallet, renewal, registerDelegation, open } = await hdWalletWithWatch({
                hold: true,
            });

            await (wallet as any).maybeRotateBoardingAfterBoard([boardingCoin]);
            await vi.waitFor(() => expect(registerDelegation).toHaveBeenCalledOnce());
            // a deposit at the old key, still displayed, which the Executor boards
            await deliverContractEvent(wallet, "vtxo_received", renewal.contract, [
                coin(renewal, "aa"),
            ]);

            open();
            await boardChainIdle(wallet);
            expect(registerDelegation).toHaveBeenCalledOnce();
            const [[, variables]] = registerDelegation.mock.calls;
            expect(variables.owner.slice(2)).toBe(
                hex.encode(wallet.boardingTapscript.options.pubKey),
            );
            await wallet.dispose();
        });

        it("waits for a pending registration before it disposes", async () => {
            const { wallet, registerDelegation, open } = await hdWalletWithWatch({ hold: true });

            await (wallet as any).maybeRotateBoardingAfterBoard([boardingCoin]);
            await vi.waitFor(() => expect(registerDelegation).toHaveBeenCalledOnce());
            const disposed = wallet.dispose();
            expect(await settlesSoon(disposed)).toBe(false);

            open();
            await disposed;
        });

        it("stops the VtxoManager before it drains the rotations its settle queues", async () => {
            const { wallet, registerDelegation, open } = await hdWalletWithWatch({ hold: true });
            const manager = await wallet.getVtxoManager();
            // a settle in flight when dispose starts: it commits, and queues its rotation, while
            // the manager is being stopped
            const stop = manager.dispose.bind(manager);
            vi.spyOn(manager, "dispose").mockImplementation(async () => {
                await (wallet as any).maybeRotateBoardingAfterBoard([boardingCoin]);
                await stop();
            });
            const created = vi.spyOn(ContractManager, "create");

            const disposed = wallet.dispose();
            await vi.waitFor(() => expect(registerDelegation).toHaveBeenCalledOnce());
            expect(await settlesSoon(disposed)).toBe(false);

            open();
            await disposed;
            // the registration finished through the contract manager that was still up
            expect(await wallet.getBoardingAddress()).not.toBe(wallet.ownBoardingAddress());
            expect(created).not.toHaveBeenCalled();
        });
    });

    it("keeps the boarding address a server-signer rotation moved while its watch registered", async () => {
        const { wallet, registerDelegation, open } = await hdWalletWithWatch({ hold: true });
        const newSigner = "ab".repeat(32);

        const rotating = wallet.getNewBoardingAddress();
        await vi.waitFor(() => expect(registerDelegation).toHaveBeenCalledOnce());
        await wallet.rotateServerSigner(hex.decode(newSigner), arkInfo.checkpointTapscript);
        open();
        await rotating;

        // not the tapscript minted under the signer that rotated away
        expect(hex.encode(wallet.boardingTapscript.options.serverPubKey)).toBe(newSigner);
        expect(await wallet.getBoardingAddress()).toBe(wallet.ownBoardingAddress());
        await wallet.dispose();
    });

    describe("Executor watches that lapse", () => {
        const DAY_MS = 24 * 60 * 60 * 1000;
        const boardingAddress = (boarding: Awaited<ReturnType<typeof executorRow>>) =>
            boarding.script.onchainAddress(networks.mutinynet);

        it("leaves a watch the Executor still holds", async () => {
            const { wallet, boarding, registerDelegation, getDelegation } =
                await hdWalletWithWatch();

            await boardChainIdle(wallet);
            expect(getDelegation).toHaveBeenCalledWith(boardingAddress(boarding));
            expect(registerDelegation).not.toHaveBeenCalled();
            await wallet.dispose();
        });

        it("registers an expired watch again at boot, at the same address", async () => {
            const { wallet, boarding, registerDelegation } = await hdWalletWithWatch({
                delegation: "expired",
            });

            await boardChainIdle(wallet);
            expect(registerDelegation).toHaveBeenCalledOnce();
            expect(registerDelegation.mock.calls[0][0]).toBe(DEFAULT_TEMPLATE_IDS.boarding);
            expect(await wallet.getBoardingAddress()).toBe(boardingAddress(boarding));
            await wallet.dispose();
        });

        it("registers a watch the Executor does not know again", async () => {
            const { wallet, registerDelegation } = await hdWalletWithWatch({
                delegation: "missing",
            });

            await boardChainIdle(wallet);
            expect(registerDelegation).toHaveBeenCalledOnce();
            await wallet.dispose();
        });

        it("shows the wallet's own address once an expired watch cannot be registered again", async () => {
            const { wallet, boarding, registerDelegation } = await hdWalletWithWatch({
                delegation: "expired",
                refuse: true,
            });
            vi.spyOn(console, "warn").mockImplementation(() => {});
            expect(boardingAddress(boarding)).not.toBe(wallet.ownBoardingAddress());

            await boardChainIdle(wallet);
            expect(registerDelegation).toHaveBeenCalledOnce();
            // no longer advertised: the wallet settles those deposits itself
            expect(await wallet.getBoardingAddress()).toBe(wallet.ownBoardingAddress());
            await wallet.dispose();
        });

        it("leaves a watch alone when the Executor cannot say whether it holds it", async () => {
            vi.useFakeTimers({ toFake: ["Date"] });
            const { wallet, boarding, registerDelegation, getDelegation } =
                await hdWalletWithWatch();
            vi.spyOn(console, "warn").mockImplementation(() => {});
            await boardChainIdle(wallet);
            getDelegation.mockRejectedValue(new ExecutorRequestError("unavailable", 503));
            vi.setSystemTime(Date.now() + DAY_MS);

            await wallet.refreshExecutorWatches();

            expect(getDelegation).toHaveBeenCalledTimes(2);
            expect(registerDelegation).not.toHaveBeenCalled();
            expect(await wallet.getBoardingAddress()).toBe(boardingAddress(boarding));
            await wallet.dispose();
        });

        it("checks once a day, from the boot and the poll alike", async () => {
            vi.useFakeTimers({ toFake: ["Date"] });
            const { wallet, getDelegation } = await hdWalletWithWatch();
            await boardChainIdle(wallet);
            expect(getDelegation).toHaveBeenCalledOnce();

            // the poll's call, soon after the boot's
            await wallet.refreshExecutorWatches();
            expect(getDelegation).toHaveBeenCalledOnce();

            vi.setSystemTime(Date.now() + DAY_MS);
            await wallet.refreshExecutorWatches();
            expect(getDelegation).toHaveBeenCalledTimes(2);
            await wallet.dispose();
        });

        it("asks again after a reload only once a day has passed, or the last refresh failed", async () => {
            vi.useFakeTimers({ toFake: ["Date"] });
            const { wallet, getDelegation } = await hdWalletWithWatch();
            vi.spyOn(console, "warn").mockImplementation(() => {});
            await boardChainIdle(wallet);
            expect(getDelegation).toHaveBeenCalledOnce();
            // what a reload starts with
            const reload = () => ((wallet as any)._executorRefreshedAt = 0);

            reload();
            await wallet.refreshExecutorWatches();
            expect(getDelegation).toHaveBeenCalledOnce();

            vi.setSystemTime(Date.now() + DAY_MS);
            const provider = (wallet as any)._executorManager.executorProvider;
            const getInfo = provider.getInfo;
            provider.getInfo = vi.fn().mockRejectedValue(new Error("offline"));
            await wallet.refreshExecutorWatches();
            expect(getDelegation).toHaveBeenCalledOnce();

            provider.getInfo = getInfo;
            reload();
            await wallet.refreshExecutorWatches();
            expect(getDelegation).toHaveBeenCalledTimes(2);
            await wallet.dispose();
        });

        it("does nothing without an Executor", async () => {
            mockFetch.mockImplementation(async () => jsonResponse(arkInfo));
            const { wallet } = await walletWith({ executor: false, rows: true });

            await expect(wallet.refreshExecutorWatches()).resolves.toBeUndefined();
            await wallet.dispose();
        });
    });

    it("shows the rotated key's own address once a registration times out", async () => {
        const { wallet, registerDelegation } = await hdWalletWithWatch({ hold: true });
        const deadline = new AbortController();
        const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
        vi.spyOn(console, "warn").mockImplementation(() => {});

        const next = wallet.getNewBoardingAddress();
        await vi.waitFor(() => expect(registerDelegation).toHaveBeenCalledOnce());
        expect(timeout).toHaveBeenCalledWith(REGISTRATION_TIMEOUT_MS);
        deadline.abort(new Error("timed out"));

        expect(await next).toBe(wallet.ownBoardingAddress());
        await wallet.dispose();
    });
});

describe("delegated boarding address", () => {
    beforeEach(() => {
        mockFetch.mockReset();
        mockFetch.mockImplementation(async () => jsonResponse(arkInfo));
    });

    it("boards at the delegated address and keeps the wallet's own Arkade address", async () => {
        const { wallet, boarding } = await walletWith({ executor: true, rows: true });

        expect(await wallet.getBoardingAddress()).toBe(
            boarding.script.onchainAddress(networks.mutinynet),
        );
        expect(await wallet.getAddress()).toBe(wallet.arkAddress.encode());
    });

    it("keeps the wallet's own boarding address without an Executor", async () => {
        const { wallet } = await walletWith({ executor: false, rows: true });
        expect(await wallet.getBoardingAddress()).toBe(
            wallet.boardingTapscript.onchainAddress(networks.mutinynet),
        );
    });

    it("keeps the wallet's own boarding address until a watch is registered", async () => {
        const { wallet, boarding } = await walletWith({ executor: true, rows: false });
        const own = wallet.boardingTapscript.onchainAddress(networks.mutinynet);
        expect(await wallet.getBoardingAddress()).toBe(own);

        await wallet.contractRepository.saveContract(boarding.contract);
        expect(await wallet.getBoardingAddress()).not.toBe(own);
    });

    it("falls back to its own boarding address once the watch lapses, ends or has no status", async () => {
        const { wallet, boarding } = await walletWith({ executor: true, rows: true });
        const own = wallet.boardingTapscript.onchainAddress(networks.mutinynet);
        for (const metadata of [
            { delegationStatus: "active", delegationExpiresAt: 1 },
            { delegationStatus: "expired" },
            { delegationStatus: "local" },
            undefined,
        ]) {
            await wallet.contractRepository.saveContract({ ...boarding.contract, metadata });
            expect(await wallet.getBoardingAddress()).toBe(own);
        }
        // expiresAt 0 is a watch without expiry
        await wallet.contractRepository.saveContract({
            ...boarding.contract,
            metadata: { delegationStatus: "active", delegationExpiresAt: 0 },
        });
        expect(await wallet.getBoardingAddress()).not.toBe(own);
    });

    it("skips a newer row whose params no longer derive its script", async () => {
        const { wallet, boarding } = await walletWith({ executor: true, rows: true });
        await wallet.contractRepository.saveContract({
            ...boarding.contract,
            script: "51",
            params: { ...boarding.contract.params, maxFee: "200" },
            createdAt: boarding.contract.createdAt + 1,
        });
        expect(await wallet.getBoardingAddress()).toBe(
            boarding.script.onchainAddress(networks.mutinynet),
        );
    });

    it("skips a newer malformed row for the older valid one", async () => {
        const { wallet, boarding } = await walletWith({ executor: true, rows: true });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        await wallet.contractRepository.saveContract({
            ...boarding.contract,
            script: "51",
            params: { ...boarding.contract.params, exitDelay: "garbage" },
            createdAt: boarding.contract.createdAt + 1,
        });
        expect(await wallet.getBoardingAddress()).toBe(
            boarding.script.onchainAddress(networks.mutinynet),
        );
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it("counts the renewal contract, not the boarding one, among its virtual-output scripts", async () => {
        const { wallet, renewal, boarding } = await walletWith({ executor: true, rows: true });
        vi.spyOn(wallet, "getContractManager").mockResolvedValue({
            getContracts: async (filter: ContractFilter) =>
                collectContracts(wallet.contractRepository, filter),
        } as never);
        const map = await wallet.getScriptMap();
        expect(map.has(renewal.contract.script)).toBe(true);
        expect(map.has(boarding.contract.script)).toBe(false);
        expect(await wallet.getWalletScripts()).toContain(renewal.contract.script);
    });

    it("reports boarded coins to incoming-funds subscribers, and deposits only as UTXOs", async () => {
        const { wallet, renewal, boarding } = await walletWith({ executor: true, rows: true });
        let emit: (event: unknown) => void = () => {};
        vi.spyOn(wallet, "getContractManager").mockResolvedValue({
            onContractEvent: (handler: (event: unknown) => void) => {
                emit = handler;
                return () => {};
            },
            annotateVtxos: async (vtxos: unknown[]) => vtxos,
        } as never);
        vi.spyOn(wallet, "getBoardingAddresses").mockResolvedValue([]);
        const funds = vi.fn();
        const stop = await wallet.notifyIncomingFunds(funds);

        const vtxo = {
            txid: "aa".repeat(32),
            vout: 0,
            value: 5000,
            script: renewal.contract.script,
        };
        // the onchain sync's row of a deposit, which the boarding watcher reports
        emit({
            type: "vtxo_received",
            contractScript: boarding.contract.script,
            contract: { ...boarding.contract, scope: "onchain" },
            vtxos: [{ ...vtxo, txid: "bb".repeat(32), script: boarding.contract.script }],
            timestamp: 0,
        });
        emit({
            type: "vtxo_received",
            contractScript: renewal.contract.script,
            contract: renewal.contract,
            vtxos: [vtxo],
            timestamp: 0,
        });
        emit({
            type: "vtxo_received",
            contractScript: "51",
            contract: { ...renewal.contract, type: "vhtlc" },
            vtxos: [vtxo],
            timestamp: 0,
        });
        await vi.waitFor(() =>
            expect(funds).toHaveBeenCalledWith({ type: "vtxo", newVtxos: [vtxo], spentVtxos: [] }),
        );
        expect(funds).toHaveBeenCalledTimes(1);
        stop();
    });

    describe("deposits at the delegated boarding address", () => {
        // one confirmed deposit at the delegated address, one at the wallet's own
        async function walletWithDeposits() {
            const ctx = await walletWith({ executor: true, rows: true });
            const delegated = ctx.boarding.script.onchainAddress(networks.mutinynet);
            const own = ctx.wallet.ownBoardingAddress();
            const coin = (txid: string, value: number) => ({
                txid,
                vout: 0,
                value,
                status: { confirmed: true, block_time: 1 },
            });
            vi.spyOn(ctx.wallet.onchainProvider, "getCoins").mockImplementation(
                async (address: string) =>
                    address === delegated
                        ? [coin("d".repeat(64), 7_000)]
                        : address === own
                          ? [coin("0".repeat(64), 3_000)]
                          : [],
            );
            vi.spyOn(ctx.wallet, "getContractManager").mockResolvedValue({
                syncOnchain: async () => {},
                getContracts: async (filter: ContractFilter) =>
                    collectContracts(ctx.wallet.contractRepository, filter),
            } as never);
            return { ...ctx, delegated, own };
        }
        const txids = (coins: { txid: string }[]) => coins.map((c) => c.txid[0]).sort();

        it("shows them among the wallet's boarding coins", async () => {
            const { wallet, delegated } = await walletWithDeposits();
            expect(await wallet.getBoardingAddresses()).toContain(delegated);
            expect(txids(await wallet.getBoardingUtxos())).toEqual(["0", "d"]);
        });

        it("leaves them to the Executor while the watch is live", async () => {
            const { wallet } = await walletWithDeposits();
            expect(txids(await wallet.getSelectableBoardingUtxos())).toEqual(["0"]);
            const groups = await wallet.getSelectableBoardingUtxoGroups();
            const held = groups.filter((g) => g.delegated);
            expect(held.map((g) => txids(g.coins))).toEqual([["d"]]);
            // the sweep still sees them, to exit them once their CSV elapses
            expect(txids(groups.flatMap((g) => g.coins))).toEqual(["0", "d"]);
        });

        it("boards them itself once the watch ends", async () => {
            const { wallet, boarding } = await walletWithDeposits();
            await wallet.contractRepository.saveContract({
                ...boarding.contract,
                metadata: { delegationStatus: "cancelled" },
            });
            expect(txids(await wallet.getSelectableBoardingUtxos())).toEqual(["0", "d"]);
            const groups = await wallet.getSelectableBoardingUtxoGroups();
            expect(groups.some((g) => g.delegated)).toBe(false);
        });

        it("sweeps to the wallet's own boarding address, not the delegated one", async () => {
            const { wallet, delegated, own } = await walletWithDeposits();
            expect(await wallet.getBoardingAddress()).toBe(delegated);
            expect(await getOwnBoardingAddress(wallet)).toBe(own);
        });
    });
});
