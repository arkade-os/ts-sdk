import { describe, it, expect, vi, afterEach } from "vitest";
import { hex } from "@scure/base";
import {
    ExecutorContractHandler,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    MnemonicIdentity,
    RestArkProvider,
    Wallet,
    type Contract,
} from "../src";
import { saveVtxosForContract } from "../src/contracts/vtxoOwnership";
import { collectContracts } from "../src/repositories/contractRepository";
import { HDDescriptorProvider } from "../src/wallet/hdDescriptorProvider";
import vectors from "./fixtures/executor/vectors.json";
import { createMockExtendedVtxo } from "./contracts/helpers";
import { arkInfo, renewalRow } from "./helpers/delegatedRows";
import { executorStub } from "./helpers/executorStub";
import { jsonResponse } from "./helpers/response";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("../src/utils/fetch", async (importActual) => ({
    ...(await importActual<typeof import("../src/utils/fetch")>()),
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DAY_MS = 24 * 60 * 60 * 1000;

/** The identity's boarding watch, which `rotateBoarding` copies onto a key it rotates to. */
async function boardingRow(owner: Uint8Array) {
    const params = ExecutorContractHandler.serializeParams({
        template: "boarding",
        owner,
        exitDelay: 144,
        renewalWindow: 1000,
        maxFee: 100,
        boardingExitDelay: 144,
        batchCosignerPubKey: hex.decode(vectors.batchCosignerPubkey),
        operatorPubKey: hex.decode(vectors.operatorPubkey),
        emulatorPubKey: hex.decode(vectors.emulatorPubkey),
    });
    const script = ExecutorContractHandler.createScript(params);
    return {
        type: "executor",
        params,
        script: hex.encode(script.pkScript),
        address: "unused",
        state: "active" as const,
        createdAt: Date.now(),
        metadata: { delegationStatus: "active" },
    };
}

/**
 * An HD wallet at its identity key with the Executor's help. `opted` stores live renewal and
 * boarding watches there, as an app that called `registerRenewal` has.
 */
async function hdWallet({ opted = true }: { opted?: boolean } = {}) {
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
    const owner = await hd.compressedPublicKey();
    const contractRepository = new InMemoryContractRepository();
    if (opted) {
        await contractRepository.saveContract((await renewalRow({ owner })).contract);
        await contractRepository.saveContract(await boardingRow(owner));
    }
    const executor = executorStub();
    const wallet = await Wallet.create({
        identity: hd,
        walletMode: "hd",
        arkProvider: new RestArkProvider("http://localhost:7070"),
        storage: { walletRepository: new InMemoryWalletRepository(), contractRepository },
        settlementConfig: false,
        executorProvider: executor.provider,
    });
    await idle(wallet);
    return { wallet, executor, contractRepository };
}

/** The boot's refresh and the queued rotations, including any a running one queues. */
async function idle(wallet: Wallet) {
    await (wallet as any)._executorBoot;
    let chain: Promise<void>;
    do {
        chain = (wallet as any)._executorBoardChain;
        await chain;
    } while (chain !== (wallet as any)._executorBoardChain);
}

async function renewalsOf(wallet: Wallet): Promise<Contract[]> {
    return (await collectContracts(wallet.contractRepository, { type: ["executor"] })).filter(
        (c) => c.params.template === "renewal",
    );
}

/** The renewal row of the key at `pubKey`, x-only. */
async function twinOf(wallet: Wallet, pubKey: Uint8Array) {
    const key = hex.encode(pubKey);
    return (await renewalsOf(wallet)).find((c) => c.params.owner.slice(2) === key)!;
}

/** Delivers `vtxo_received` for `contract`, as the watcher does, and waits for what it queued. */
async function receiveAt(wallet: Wallet, contract: Contract) {
    const manager = await wallet.getContractManager();
    for (const cb of (manager as any).eventCallbacks as Set<(e: unknown) => void>) {
        cb({
            type: "vtxo_received",
            contractScript: contract.script,
            contract,
            vtxos: [],
            timestamp: Date.now(),
        });
    }
    await (wallet as any)._receiveRotator.drain();
    await idle(wallet);
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("an HD wallet's receive address under an Executor", () => {
    it("is the own address until the app opts in", async () => {
        const { wallet } = await hdWallet({ opted: false });

        expect(await wallet.getAddress()).toBe(wallet.arkAddress.encode());
        expect(await renewalsOf(wallet)).toHaveLength(0);
        await wallet.dispose();
    });

    it("keeps the receive key off the boarding key once the app has opted in", async () => {
        const { wallet } = await hdWallet();

        // both were the identity key before the boot moved boarding
        expect(hex.encode(wallet.boardingTapscript.options.pubKey)).not.toBe(
            hex.encode(wallet.offchainTapscript.options.pubKey),
        );
        const twin = await twinOf(wallet, wallet.offchainTapscript.options.pubKey);
        expect(await wallet.getAddress()).toBe(twin.address);
        await wallet.dispose();
    });

    it("rotates boarding once, when the app opts in during the session", async () => {
        const { wallet } = await hdWallet({ opted: false });
        const manager = (await wallet.getExecutorManager())!;
        const first = await wallet.getBoardingAddress();
        const provider = vi.spyOn(HDDescriptorProvider.prototype, "getNextSigningDescriptor");

        await manager.registerRenewal(
            { renewalWindow: 1000, maxFee: 100, exitDelay: 144 },
            { emulatorPubkey: vectors.emulatorPubkey },
        );
        await wallet.refreshExecutorWatches();
        await wallet.refreshExecutorWatches();

        expect(await wallet.getBoardingAddress()).not.toBe(first);
        expect(provider).toHaveBeenCalledOnce();
        const twin = await twinOf(wallet, wallet.offchainTapscript.options.pubKey);
        expect(await wallet.getAddress()).toBe(twin.address);
        await wallet.dispose();
    });

    it("separates the receive and boarding keys as soon as renewal is registered, with no poll", async () => {
        const { wallet } = await hdWallet({ opted: false });
        const manager = (await wallet.getExecutorManager())!;
        const first = await wallet.getBoardingAddress();
        const refresh = vi.spyOn(wallet, "refreshExecutorWatches");

        await manager.registerRenewal(
            { renewalWindow: 1000, maxFee: 100, exitDelay: 144 },
            { emulatorPubkey: vectors.emulatorPubkey },
        );
        await idle(wallet);

        expect(refresh).not.toHaveBeenCalled();
        expect(await wallet.getBoardingAddress()).not.toBe(first);
        const twin = await twinOf(wallet, wallet.offchainTapscript.options.pubKey);
        expect(await wallet.getAddress()).toBe(twin.address);
        await wallet.dispose();
    });

    it("registers a new twin when the app registers renewal with other params", async () => {
        const { wallet, executor } = await hdWallet();
        const manager = (await wallet.getExecutorManager())!;
        const key = wallet.offchainTapscript.options.pubKey;
        const before = await twinOf(wallet, key);
        const options = { renewalWindow: 2000, maxFee: 100, exitDelay: 144 };
        const registration = { emulatorPubkey: vectors.emulatorPubkey };

        await manager.registerBoarding(options, registration);
        await manager.registerRenewal(options, registration);
        await wallet.refreshExecutorWatches();
        executor.registerDelegation.mockClear();
        await wallet.refreshExecutorWatches();

        const twins = (await renewalsOf(wallet)).filter(
            (c) => c.params.owner.slice(2) === hex.encode(key),
        );
        const after = twins.find((c) => c.params.renewalWindow === "2000")!;
        expect(after.script).not.toBe(before.script);
        expect(await wallet.getAddress()).toBe(after.address);
        expect(executor.registerDelegation).not.toHaveBeenCalled();
        await wallet.dispose();
    });

    it("rotates the receive key once on a receipt at its twin, registering the new twin first", async () => {
        const { wallet, executor } = await hdWallet();
        const before = await twinOf(wallet, wallet.offchainTapscript.options.pubKey);
        const events: string[] = [];
        executor.registerDelegation.mockClear();
        executor.registerDelegation.mockImplementation(
            (
                (original) =>
                async (...args: Parameters<typeof original>) => {
                    events.push("register");
                    return original(...args);
                }
            )(executor.registerDelegation.getMockImplementation()!),
        );
        const swap = wallet.setOffchainTapscriptForRotation.bind(wallet);
        vi.spyOn(wallet, "setOffchainTapscriptForRotation").mockImplementation((tapscript) => {
            events.push("swap");
            swap(tapscript);
        });
        const provider = vi.spyOn(HDDescriptorProvider.prototype, "getNextSigningDescriptor");
        const boarding = await wallet.getBoardingAddress();

        await receiveAt(wallet, before);

        expect(provider).toHaveBeenCalledOnce();
        expect(events).toEqual(["register", "swap"]);
        const after = await twinOf(wallet, wallet.offchainTapscript.options.pubKey);
        expect(after.script).not.toBe(before.script);
        expect(await wallet.getAddress()).toBe(after.address);
        expect(after.metadata?.delegationStatus).toBe("active");
        // the first twin is still live: a payment to the address shown earlier is renewed
        expect(
            (await twinOf(wallet, hex.decode(before.params.owner).subarray(1))).metadata,
        ).toMatchObject({
            delegationStatus: "active",
        });
        expect(await wallet.getBoardingAddress()).toBe(boarding);
        await wallet.dispose();
    });

    it("shows its own address, rotating once, when the Executor refuses the new twin, and repairs it", async () => {
        const { wallet, executor } = await hdWallet();
        const before = await twinOf(wallet, wallet.offchainTapscript.options.pubKey);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const provider = vi.spyOn(HDDescriptorProvider.prototype, "getNextSigningDescriptor");
        executor.state.refuse = true;

        await receiveAt(wallet, before);

        expect(provider).toHaveBeenCalledOnce();
        expect(await wallet.getAddress()).toBe(wallet.arkAddress.encode());
        expect(wallet.arkAddress.encode()).not.toBe(before.address);
        expect(warn).toHaveBeenCalledWith(
            "Failed to register an Executor watch for the new receive address",
            expect.any(Error),
        );

        executor.state.refuse = false;
        await wallet.refreshExecutorWatches();

        const repaired = await twinOf(wallet, wallet.offchainTapscript.options.pubKey);
        expect(await wallet.getAddress()).toBe(repaired.address);
        expect(provider).toHaveBeenCalledOnce();
        await wallet.dispose();
    });

    it("does not try a failing Executor again until the back-off has passed", async () => {
        const { wallet, executor } = await hdWallet();
        const before = await twinOf(wallet, wallet.offchainTapscript.options.pubKey);
        vi.spyOn(console, "warn").mockImplementation(() => {});
        executor.state.refuse = true;
        await receiveAt(wallet, before);
        executor.registerDelegation.mockClear();

        await wallet.refreshExecutorWatches();
        await wallet.refreshExecutorWatches();

        expect(executor.registerDelegation).toHaveBeenCalledOnce();
        await wallet.dispose();
    });

    it("rotates boarding, not receive, on a receipt at the boarding key's contract", async () => {
        const { wallet } = await hdWallet();
        const boardingKey = wallet.boardingTapscript.options.pubKey;
        const boardingContract = await twinOf(wallet, boardingKey);
        const receive = wallet.defaultContractScript;
        const boarding = await wallet.getBoardingAddress();

        await receiveAt(wallet, boardingContract);

        expect(await wallet.getBoardingAddress()).not.toBe(boarding);
        expect(wallet.defaultContractScript).toBe(receive);
        await wallet.dispose();
    });

    it("rotates receive, not boarding, on a receipt at the receive twin", async () => {
        const { wallet } = await hdWallet();
        const twin = await twinOf(wallet, wallet.offchainTapscript.options.pubKey);
        const receive = wallet.defaultContractScript;
        const boarding = await wallet.getBoardingAddress();

        await receiveAt(wallet, twin);

        expect(wallet.defaultContractScript).not.toBe(receive);
        expect(await wallet.getBoardingAddress()).toBe(boarding);
        await wallet.dispose();
    });

    it("rotates on a receipt at a twin whose watch has ended", async () => {
        const { wallet, contractRepository } = await hdWallet();
        const twin = await twinOf(wallet, wallet.offchainTapscript.options.pubKey);
        const ended = { ...twin, metadata: { ...twin.metadata, delegationStatus: "expired" } };
        await contractRepository.saveContract(ended);
        const receive = wallet.defaultContractScript;

        await receiveAt(wallet, ended);

        expect(wallet.defaultContractScript).not.toBe(receive);
        await wallet.dispose();
    });

    describe("the daily refresh", () => {
        /** One twin per receipt, each registered a second after the last; the last is displayed. */
        async function afterThreeReceipts() {
            vi.useFakeTimers({ toFake: ["Date"] });
            const fx = await hdWallet();
            const twins = [await twinOf(fx.wallet, fx.wallet.offchainTapscript.options.pubKey)];
            for (let i = 0; i < 3; i++) {
                vi.setSystemTime(Date.now() + 1000);
                await receiveAt(fx.wallet, twins[i]);
                twins.push(await twinOf(fx.wallet, fx.wallet.offchainTapscript.options.pubKey));
            }
            const [first, oldest, previous, displayed] = twins;
            return { ...fx, first, oldest, previous, displayed };
        }

        const registeredOwners = (executor: Awaited<ReturnType<typeof hdWallet>>["executor"]) =>
            executor.registerDelegation.mock.calls.map(([, variables]) => variables.owner);

        const statusOf = async (wallet: Wallet, twin: Contract) =>
            (await renewalsOf(wallet)).find((c) => c.script === twin.script)?.metadata
                ?.delegationStatus;

        it("revives the displayed receive twin and the newest other key, and ends older twins without a coin", async () => {
            const { wallet, executor, oldest, previous, displayed } = await afterThreeReceipts();
            executor.registerDelegation.mockClear();
            executor.state.status = "expired";
            vi.setSystemTime(Date.now() + DAY_MS);

            await wallet.refreshExecutorWatches();

            expect(registeredOwners(executor)).toContain(displayed.params.owner);
            expect(registeredOwners(executor)).toContain(previous.params.owner);
            expect(registeredOwners(executor)).not.toContain(oldest.params.owner);
            expect(await statusOf(wallet, displayed)).toBe("active");
            expect(await statusOf(wallet, oldest)).toBe("expired");
            await wallet.dispose();
        });

        it("revives an older twin that holds an unspent coin, though the Executor lost it", async () => {
            const { wallet, executor, oldest, displayed } = await afterThreeReceipts();
            await saveVtxosForContract(wallet.walletRepository, oldest, [
                createMockExtendedVtxo({ script: oldest.script }),
            ]);
            executor.registerDelegation.mockClear();
            executor.state.status = "missing";
            vi.setSystemTime(Date.now() + DAY_MS);

            await wallet.refreshExecutorWatches();

            expect(registeredOwners(executor)).toContain(oldest.params.owner);
            expect(await statusOf(wallet, oldest)).toBe("active");
            expect(await statusOf(wallet, displayed)).toBe("active");
            await wallet.dispose();
        });

        it("ends an older twin whose coins are all spent", async () => {
            const { wallet, executor, oldest } = await afterThreeReceipts();
            await saveVtxosForContract(wallet.walletRepository, oldest, [
                createMockExtendedVtxo({
                    script: oldest.script,
                    isSpent: true,
                    spentBy: "cc".repeat(32),
                }),
            ]);
            executor.registerDelegation.mockClear();
            executor.state.status = "expired";
            vi.setSystemTime(Date.now() + DAY_MS);

            await wallet.refreshExecutorWatches();

            expect(registeredOwners(executor)).not.toContain(oldest.params.owner);
            expect(await statusOf(wallet, oldest)).toBe("expired");
            await wallet.dispose();
        });
    });
});
