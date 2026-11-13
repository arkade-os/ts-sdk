import { describe, it, expect, vi, beforeEach } from "vitest";
import { hex } from "@scure/base";
import {
    ExecutorContractHandler,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    SingleKey,
    Wallet,
    networks,
    type ExecutorProvider,
} from "../src";
import { collectContracts, type ContractFilter } from "../src/repositories/contractRepository";
import { getOwnBoardingAddress } from "../src/wallet/utils";
import vectors from "./fixtures/executor/vectors.json";
import { jsonResponse } from "./helpers/response";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("../src/utils/fetch", () => ({ fetch: mockFetch, baseFetch: mockFetch }));

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

async function executorRow(template: "renewal" | "boarding") {
    const params = ExecutorContractHandler.serializeParams({
        template,
        owner: await identity.compressedPublicKey(),
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

    it("reports boarded coins to incoming-funds subscribers", async () => {
        const { wallet, renewal } = await walletWith({ executor: true, rows: true });
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
        await vi.waitFor(() => expect(funds).toHaveBeenCalledTimes(1));
        expect(funds).toHaveBeenCalledWith({ type: "vtxo", newVtxos: [vtxo], spentVtxos: [] });
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
