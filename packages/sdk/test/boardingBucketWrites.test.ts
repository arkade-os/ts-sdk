import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import {
    ContractManager,
    DefaultVtxo,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    networks,
} from "../src";
import { collectScriptVtxos } from "../src/repositories/walletRepository";
import { timelockToSequence } from "../src/utils/timelock";
import { Wallet } from "../src/wallet/wallet";
import { createMockIndexerProvider } from "./contracts/helpers";

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
const utxo = (fill: string) => ({
    txid: fill.repeat(32),
    vout: 0,
    value: 5_000,
    status: { confirmed: true, block_height: 200 },
});

describe("updateDbAfterSettle boarding writes", () => {
    it("keeps both pending marks when two settles finish together", async () => {
        const [a, b, c] = ["aa", "bb", "cc"].map(utxo);
        const walletRepository = new InMemoryWalletRepository();
        const contractRepository = new InMemoryContractRepository();
        await contractRepository.saveContract(boarding);
        const manager = await ContractManager.create({
            indexerProvider: createMockIndexerProvider(),
            contractRepository,
            walletRepository,
            onchainProvider: {
                getCoins: vi.fn(async () => [a, b, c]),
                getTxOutspends: vi.fn(async () => []),
                getChainTip: vi.fn(async () => ({ height: 300, time: 0, hash: "" })),
                watchAddresses: vi.fn(async () => () => {}),
            } as any,
            network: networks.regtest,
        });
        await manager.syncOnchain();
        const thisArg = {
            walletRepository,
            getContractManager: async () => manager,
            boardingTapscript: script,
            network: networks.regtest,
        };
        const settle = (input: ReturnType<typeof utxo>) =>
            (Wallet.prototype as any).updateDbAfterSettle.call(
                thisArg,
                [{ ...input, tapTree: script.encode() }],
                "commitment",
            );

        await Promise.all([settle(a), settle(b)]);

        const rows = await collectScriptVtxos(walletRepository, boarding.script);
        const spender = (u: ReturnType<typeof utxo>) =>
            rows.find((row) => row.txid === u.txid)?.spentBy;
        expect([spender(a), spender(b), spender(c)]).toEqual(["commitment", "commitment", ""]);
        manager.dispose();
    });
});
