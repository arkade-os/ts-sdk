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
import { timelockToSequence } from "../../src/utils/timelock";
import { createMockIndexerProvider } from "./helpers";

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

async function setup(getCoins: () => Promise<any[]>) {
    const walletRepository = new InMemoryWalletRepository();
    const contractRepository = new InMemoryContractRepository();
    await contractRepository.saveContract(boarding);
    const onchainProvider = {
        getCoins: vi.fn(getCoins),
        getTxOutspends: vi.fn(async () => [
            { spent: false },
            { spent: true, txid: "cc".repeat(32) },
        ]),
        watchAddresses: vi.fn(async () => () => {}),
    } as any;
    const manager = await ContractManager.create({
        indexerProvider: createMockIndexerProvider(),
        contractRepository,
        walletRepository,
        onchainProvider,
        network: networks.regtest,
    });
    return { manager, walletRepository, onchainProvider };
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

    it("keeps a pending spend across re-syncs and survives a getCoins failure", async () => {
        const getCoins = vi
            .fn()
            .mockResolvedValueOnce([coin])
            .mockResolvedValueOnce([coin])
            .mockRejectedValue(new Error("down"));
        const { manager, walletRepository } = await setup(getCoins);
        await manager.syncOnchain();
        await manager.markOnchainSpendPending([{ txid: coin.txid, vout: 1 }], "dd".repeat(32));
        await manager.syncOnchain();
        await expect(manager.syncOnchain()).resolves.toBeUndefined();

        const rows = await walletRepository.getVtxosForScript!(boarding.script);
        expect(rows[0]).toMatchObject({ isSpent: false, spentBy: "dd".repeat(32) });
        manager.dispose();
    });
});
