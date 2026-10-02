import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import {
    ContractManager,
    DefaultVtxo,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    networks,
} from "../../src";
import { OnchainContractWatcher } from "../../src/contracts/onchainWatcher";
import { toOnchainCoinRow } from "../../src/contracts/onchainCoins";
import { saveVtxosForContract } from "../../src/contracts/vtxoOwnership";
import { updateWalletState } from "../../src/utils/syncCursors";
import { timelockToSequence } from "../../src/utils/timelock";
import {
    createDefaultContractParams,
    createMockIndexerProvider,
    TEST_DEFAULT_ARK_ADDRESS,
    TEST_DEFAULT_SCRIPT,
    testDefaultScript,
} from "./helpers";

describe("OnchainContractWatcher", () => {
    it("subscribes to target addresses and reports the touched scripts", async () => {
        let push: (txs: any[]) => void = () => {};
        const stop = vi.fn();
        const onchainProvider = {
            watchAddresses: vi.fn(async (_addrs: string[], cb: any) => {
                push = cb;
                return stop;
            }),
        } as any;
        const onChange = vi.fn();
        const w = new OnchainContractWatcher({
            onchainProvider,
            network: networks.regtest,
            onChange,
        });
        await w.setTargets([
            { script: "s1", address: "bcrt1qa" },
            { script: "s2", address: "bcrt1qb" },
        ]);
        expect(onchainProvider.watchAddresses).toHaveBeenCalledWith(
            ["bcrt1qa", "bcrt1qb"],
            expect.any(Function),
        );

        push([{ txid: "t", vin: [], vout: [{ scriptpubkey_address: "bcrt1qb", value: 1 }] }]);
        expect(onChange).toHaveBeenCalledWith(["s2"]);

        push([{ txid: "t2", vin: [{ prevout: { scriptpubkey_address: "bcrt1qa" } }], vout: [] }]);
        expect(onChange).toHaveBeenLastCalledWith(["s1"]);

        // Electrum delivers spends without prevouts: nothing matches, so every target is touched.
        push([{ txid: "t3", vin: [{ txid: "x", vout: 0 }], vout: [] }]);
        expect(onChange).toHaveBeenLastCalledWith(["s1", "s2"]);

        await w.setTargets([{ script: "s1", address: "bcrt1qa" }]);
        expect(stop).toHaveBeenCalledTimes(1);
        w.stop();
    });
});

const pubKey = hex.decode("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
const serverPubKey = hex.decode("c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5");
const csvTimelock = { type: "blocks", value: 144n } as const;
const script = new DefaultVtxo.Script({ pubKey, serverPubKey, csvTimelock });
const boarding = {
    type: "boarding",
    params: {
        pubKey: hex.encode(pubKey),
        serverPubKey: hex.encode(serverPubKey),
        csvTimelock: timelockToSequence(csvTimelock).toString(),
    },
    script: hex.encode(script.pkScript),
    address: script.address(networks.regtest.hrp, serverPubKey).encode(),
    state: "active" as const,
    createdAt: 0,
};
const coin = {
    txid: "aa".repeat(32),
    vout: 1,
    value: 50_000,
    status: { confirmed: true, block_height: 200, block_time: 1_700_000_000 },
};

const spender = "dd".repeat(32);
const pendingOf = async (repo: InMemoryWalletRepository) =>
    (await repo.getWalletState())?.settings?.onchainPendingSpends ?? {};

async function setup(
    getCoins: () => Promise<any[]>,
    outspends: any[] = [{ spent: false }, { spent: true, txid: "cc".repeat(32) }],
) {
    const walletRepository = new InMemoryWalletRepository();
    const contractRepository = new InMemoryContractRepository();
    await contractRepository.saveContract(boarding);
    const tip = { height: 300 };
    const onchainProvider = {
        getCoins: vi.fn(getCoins),
        getTxOutspends: vi.fn(async () => outspends),
        getChainTip: vi.fn(async () => ({ ...tip, time: 0, hash: "" })),
        watchAddresses: vi.fn(async () => () => {}),
    } as any;
    const manager = await ContractManager.create({
        indexerProvider: createMockIndexerProvider(),
        contractRepository,
        walletRepository,
        onchainProvider,
        network: networks.regtest,
    });
    return { manager, walletRepository, contractRepository, onchainProvider, tip };
}

describe("ContractManager.syncOnchain", () => {
    it("stores onchain coins and marks vanished ones spent", async () => {
        const getCoins = vi.fn().mockResolvedValueOnce([coin]).mockResolvedValue([]);
        const { manager, walletRepository, onchainProvider } = await setup(getCoins);
        const events: string[] = [];
        manager.onContractEvent((e) => events.push(e.type));

        await manager.syncOnchain();
        let rows = await walletRepository.getVtxosForScript!(boarding.script);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ isUnrolled: true, isSpent: false });
        expect(onchainProvider.getCoins).toHaveBeenCalledWith(
            script.onchainAddress(networks.regtest),
        );
        expect(onchainProvider.watchAddresses).toHaveBeenCalledWith(
            [script.onchainAddress(networks.regtest)],
            expect.any(Function),
        );

        await manager.syncOnchain();
        rows = await walletRepository.getVtxosForScript!(boarding.script);
        expect(rows[0]).toMatchObject({ isSpent: true, spentBy: "cc".repeat(32) });
        expect(onchainProvider.getTxOutspends).toHaveBeenCalledWith(coin.txid);
        expect(events).toEqual(["vtxo_received", "vtxo_spent"]);
        manager.dispose();
    });

    it("still saves new coins when a vanished row's outspends lookup fails", async () => {
        const fresh = { ...coin, txid: "bb".repeat(32), vout: 0 };
        const getCoins = vi.fn().mockResolvedValueOnce([coin]).mockResolvedValue([fresh]);
        const { manager, walletRepository, onchainProvider } = await setup(getCoins);
        await manager.syncOnchain();
        onchainProvider.getTxOutspends.mockRejectedValue(new Error("tx not found"));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        await manager.syncOnchain();

        const rows = await walletRepository.getVtxosForScript!(boarding.script);
        expect(rows.find((r) => r.txid === coin.txid)).toMatchObject({ isSpent: false });
        expect(rows.find((r) => r.txid === fresh.txid)).toMatchObject({ isUnrolled: true });
        expect(warn).toHaveBeenCalled();
        manager.dispose();
    });

    it("survives a getCoins failure", async () => {
        const getCoins = vi.fn().mockResolvedValueOnce([coin]).mockRejectedValue(new Error("down"));
        const { manager, walletRepository } = await setup(getCoins);
        await manager.syncOnchain();
        await expect(manager.syncOnchain()).resolves.toBeUndefined();
        expect(await walletRepository.getVtxosForScript!(boarding.script)).toHaveLength(1);
        manager.dispose();
    });

    it("keeps a pending spend for 5 blocks and releases it at 6", async () => {
        const { manager, walletRepository, tip } = await setup(async () => [coin]);
        await manager.syncOnchain();
        await manager.markOnchainSpendPending([{ txid: coin.txid, vout: 1 }], spender);
        expect(await pendingOf(walletRepository)).toEqual({
            [`${coin.txid}:1`]: { spender, height: 300, script: boarding.script },
        });

        tip.height = 305;
        await manager.syncOnchain();
        let [row] = await walletRepository.getVtxosForScript!(boarding.script);
        expect(row).toMatchObject({ isSpent: false, spentBy: spender });

        tip.height = 306;
        await manager.syncOnchain();
        [row] = await walletRepository.getVtxosForScript!(boarding.script);
        expect(row).toMatchObject({ isSpent: false, spentBy: "" });
        expect(await pendingOf(walletRepository)).toEqual({});
        manager.dispose();
    });

    it("confirms a pending spend once the coin is spent onchain", async () => {
        const getCoins = vi.fn().mockResolvedValueOnce([coin]).mockResolvedValue([]);
        const { manager, walletRepository } = await setup(getCoins, [{}, { spent: true }]);
        await manager.syncOnchain();
        await manager.markOnchainSpendPending([{ txid: coin.txid, vout: 1 }], spender);
        await manager.syncOnchain();
        const [row] = await walletRepository.getVtxosForScript!(boarding.script);
        expect(row).toMatchObject({ isSpent: true, spentBy: spender });
        expect(await pendingOf(walletRepository)).toEqual({});
        manager.dispose();
    });

    it("re-marking replaces the spender", async () => {
        const { manager, walletRepository } = await setup(async () => [coin]);
        await manager.syncOnchain();
        await manager.markOnchainSpendPending([{ txid: coin.txid, vout: 1 }], spender);
        await manager.markOnchainSpendPending([{ txid: coin.txid, vout: 1 }], "ee".repeat(32));
        const [row] = await walletRepository.getVtxosForScript!(boarding.script);
        expect(row.spentBy).toBe("ee".repeat(32));
        expect((await pendingOf(walletRepository))[`${coin.txid}:1`].spender).toBe("ee".repeat(32));
        manager.dispose();
    });

    it("keeps a concurrent wallet-state write made while marking", async () => {
        const { manager, walletRepository } = await setup(async () => [coin]);
        await manager.syncOnchain();
        const read = walletRepository.getWalletState.bind(walletRepository);
        let other: Promise<void> | undefined;
        vi.spyOn(walletRepository, "getWalletState").mockImplementation(async () => {
            const state = await read();
            if (!other) {
                other = updateWalletState(walletRepository, (s) => ({
                    ...s,
                    settings: { ...s.settings, cursorProbe: 1 },
                }));
                await new Promise((r) => setTimeout(r, 5));
            }
            return state;
        });
        await manager.markOnchainSpendPending([{ txid: coin.txid, vout: 1 }], spender);
        await other;
        const settings = (await read())?.settings;
        expect(settings?.cursorProbe).toBe(1);
        expect(settings?.onchainPendingSpends[`${coin.txid}:1`].spender).toBe(spender);
        manager.dispose();
    });

    it("rejects unknown outpoints without writing", async () => {
        const { manager, walletRepository } = await setup(async () => [coin]);
        await manager.syncOnchain();
        await expect(
            manager.markOnchainSpendPending(
                [
                    { txid: coin.txid, vout: 1 },
                    { txid: "ff".repeat(32), vout: 0 },
                ],
                spender,
            ),
        ).rejects.toThrow(`${"ff".repeat(32)}:0`);
        const [row] = await walletRepository.getVtxosForScript!(boarding.script);
        expect(row.spentBy).toBe("");
        expect(await pendingOf(walletRepository)).toEqual({});
        manager.dispose();
    });

    it("reconciles a pending row on an offchain-scoped contract", async () => {
        const getCoins = vi.fn().mockResolvedValue([]);
        const { manager, walletRepository, contractRepository, onchainProvider } = await setup(
            getCoins,
            [{}, { spent: true, txid: "cc".repeat(32) }],
        );
        const unrolled = {
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: TEST_DEFAULT_ARK_ADDRESS,
            state: "inactive" as const,
            createdAt: 0,
        };
        await contractRepository.saveContract(unrolled);
        await saveVtxosForContract(walletRepository, unrolled, [
            toOnchainCoinRow(coin, unrolled, testDefaultScript),
        ]);
        await manager.markOnchainSpendPending([{ txid: coin.txid, vout: 1 }], spender);

        await manager.syncOnchain();
        expect(onchainProvider.getCoins).toHaveBeenCalledWith(
            testDefaultScript.onchainAddress(networks.regtest),
        );
        const [row] = await walletRepository.getVtxosForScript!(TEST_DEFAULT_SCRIPT);
        expect(row).toMatchObject({ isSpent: true, spentBy: "cc".repeat(32) });
        expect(await pendingOf(walletRepository)).toEqual({});
        manager.dispose();
    });

    it("logs instead of rejecting when a watcher-triggered sync fails", async () => {
        const unhandled = vi.fn();
        process.on("unhandledRejection", unhandled);
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const { manager, contractRepository, onchainProvider } = await setup(async () => []);
            let push: (txs: any[]) => void = () => {};
            onchainProvider.watchAddresses
                .mockImplementationOnce(async (_a: string[], cb: any) => {
                    push = cb;
                    return () => {};
                })
                .mockRejectedValue(new Error("ws down"));
            await manager.syncOnchain();

            const other = new DefaultVtxo.Script({
                pubKey,
                serverPubKey,
                csvTimelock: { type: "blocks", value: 145n },
            });
            await contractRepository.saveContract({
                ...boarding,
                script: hex.encode(other.pkScript),
            });
            push([{ txid: "t", vin: [], vout: [] }]);
            await vi.waitFor(() => expect(error).toHaveBeenCalled());
            await new Promise((r) => setTimeout(r, 10));
            expect(unhandled).not.toHaveBeenCalled();
            manager.dispose();
        } finally {
            process.off("unhandledRejection", unhandled);
            error.mockRestore();
        }
    });
});
