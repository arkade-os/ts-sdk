import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import {
    DefaultVtxo,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    networks,
} from "../../src";
import {
    migrateLegacyUtxos,
    onchainAddressOf,
    toOnchainCoinRow,
} from "../../src/contracts/onchainCoins";
import { extendCoinWithTapscript } from "../../src/wallet/utils";
import { timelockToSequence } from "../../src/utils/timelock";

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

describe("onchain coin rows", () => {
    it("builds an isUnrolled row keyed by the contract script", () => {
        const row = toOnchainCoinRow(coin, boarding, script);
        expect(row).toMatchObject({
            txid: coin.txid,
            vout: 1,
            value: 50_000,
            isUnrolled: true,
            isSpent: false,
            script: boarding.script,
        });
        expect(row.status.block_height).toBe(200);
        expect(row.createdAt.getTime()).toBe(1_700_000_000_000);
        expect(row.virtualStatus.state).toBe("settled");
        expect(row.forfeitTapLeafScript).toBeDefined();
        expect(row.tapTree).toEqual(script.encode());
    });

    it("derives the P2TR address from params", () => {
        expect(onchainAddressOf(boarding, networks.regtest)).toBe(
            script.onchainAddress(networks.regtest),
        );
    });

    it("migrates legacy utxos once and leaves the utxos table intact", async () => {
        const walletRepository = new InMemoryWalletRepository();
        const contractRepository = new InMemoryContractRepository();
        await contractRepository.saveContract(boarding);
        const legacy = extendCoinWithTapscript(script, coin);
        await walletRepository.saveUtxos(script.onchainAddress(networks.regtest), [legacy]);

        const deps = { walletRepository, contractRepository, network: networks.regtest };
        expect(await migrateLegacyUtxos(deps)).toBe(1);
        expect(await migrateLegacyUtxos(deps)).toBe(0);

        const rows = await walletRepository.getVtxosForScript!(boarding.script);
        expect(rows).toHaveLength(1);
        expect(rows[0].isUnrolled).toBe(true);
        expect(await walletRepository.getUtxos(script.onchainAddress(networks.regtest))).toEqual([
            legacy,
        ]);
    });

    it("skips a contract whose handler is not registered", async () => {
        const walletRepository = new InMemoryWalletRepository();
        const contractRepository = new InMemoryContractRepository();
        await contractRepository.saveContract({
            ...boarding,
            type: "unregistered",
            scope: "onchain",
            script: "51".repeat(17),
        });
        await contractRepository.saveContract(boarding);
        await walletRepository.saveUtxos(script.onchainAddress(networks.regtest), [
            extendCoinWithTapscript(script, coin),
        ]);
        vi.spyOn(console, "warn").mockImplementation(() => {});

        const deps = { walletRepository, contractRepository, network: networks.regtest };
        expect(await migrateLegacyUtxos(deps)).toBe(1);
    });

    it("keeps existing wallet settings when marking the migration done", async () => {
        const walletRepository = new InMemoryWalletRepository();
        await walletRepository.saveWalletState({ lastSyncTime: 5, settings: { keep: 1 } });
        await migrateLegacyUtxos({
            walletRepository,
            contractRepository: new InMemoryContractRepository(),
            network: networks.regtest,
        });
        expect(await walletRepository.getWalletState()).toMatchObject({
            lastSyncTime: 5,
            settings: { keep: 1 },
        });
    });
});
