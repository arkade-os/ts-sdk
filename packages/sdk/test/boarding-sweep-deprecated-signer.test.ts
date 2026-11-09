import { hex } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { Coin } from "../src";
import { BoardingContractHandler } from "../src/contracts/handlers/boarding";
import { Transaction } from "../src/utils/transaction";
import {
    installRestoreHarness,
    makeStaticWalletForTest,
    teardownRestoreHarness,
} from "./helpers/restoreWallet";

const DEPRECATED_SIGNER = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
// A previous ASP's key, neither the current signer nor listed as deprecated.
const FOREIGN_SIGNER = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";

// Shorter than the wallet's own 144-block boarding delay: at tip 205 it has elapsed (105 blocks)
// while the wallet's current delay has not.
const OLD_CSV = "100";
const TIP_HEIGHT = 205;

const coin = (byte: string): Coin => ({
    txid: byte.repeat(32),
    vout: 0,
    value: 10_000,
    status: { confirmed: true, block_height: 100, block_time: 1_700_000_000 },
});

async function setup() {
    const { wallet, contractRepository } = await makeStaticWalletForTest();
    onTestFinished(() => wallet.dispose());

    const saveBoardingContract = async (serverPubKey: string, csvTimelock: string) => {
        const params = {
            pubKey: hex.encode(await wallet.identity.xOnlyPublicKey()),
            serverPubKey,
            csvTimelock,
        };
        const script = BoardingContractHandler.createScript(params);
        const address = script.onchainAddress(wallet.network);
        await contractRepository.saveContract({
            type: "boarding",
            params,
            script: hex.encode(script.pkScript),
            address,
            state: "active",
            createdAt: 1,
        });
        return { address, script };
    };
    const deprecated = await saveBoardingContract(DEPRECATED_SIGNER, OLD_CSV);
    const foreign = await saveBoardingContract(FOREIGN_SIGNER, OLD_CSV);
    wallet.refreshDeprecatedSigners({
        deprecatedSigners: [{ pubkey: DEPRECATED_SIGNER, cutoffDate: 0n }],
    });

    const currentAddress = await wallet.getBoardingAddress();
    const coinsByAddress = new Map<string, Coin[]>([
        [currentAddress, []],
        [deprecated.address, [coin("dd")]],
    ]);
    const getCoins = vi
        .spyOn(wallet.onchainProvider, "getCoins")
        .mockImplementation(async (address) => {
            const coins = coinsByAddress.get(address);
            if (!coins) throw new Error(`Unexpected boarding address: ${address}`);
            return coins;
        });
    vi.spyOn(wallet.onchainProvider, "getChainTip").mockResolvedValue({
        height: TIP_HEIGHT,
        time: 1_700_000_000,
        hash: "00".repeat(32),
    });
    (wallet.onchainProvider as any).getFeeRate = async () => 1;
    const broadcast = vi
        .spyOn(wallet.onchainProvider, "broadcastTransaction")
        .mockResolvedValue("sweep-txid");

    return { wallet, currentAddress, deprecated, foreign, coinsByAddress, getCoins, broadcast };
}

describe("boarding sweep across signers", () => {
    beforeEach(installRestoreHarness);
    afterEach(teardownRestoreHarness);

    it("lists the deprecated signer's coins but never scans a foreign signer's address", async () => {
        const { wallet, deprecated, foreign, getCoins } = await setup();

        const groups = await wallet.getSelectableBoardingUtxoGroups();

        expect(groups.flatMap((g) => g.coins.map((c) => c.txid))).toEqual([coin("dd").txid]);
        expect(groups.find((g) => g.coins.length)?.serverPubKey).toBe(DEPRECATED_SIGNER);
        expect(getCoins).toHaveBeenCalledWith(deprecated.address);
        expect(getCoins).not.toHaveBeenCalledWith(foreign.address);
    });

    it("sweeps an expired deprecated-signer coin into the current boarding address, signed", async () => {
        const { wallet, broadcast } = await setup();
        const manager = await wallet.getVtxoManager();

        await manager.sweepExpiredBoardingUtxos();

        expect(broadcast).toHaveBeenCalledTimes(1);
        const tx = Transaction.fromRaw(hex.decode(broadcast.mock.calls[0][0]));
        expect(tx.inputsLength).toBe(1);
        expect(hex.encode(tx.getInput(0).txid!)).toBe(coin("dd").txid);
        // The exit leaf's signature is in the finalized witness: the wallet signed for a contract
        // row under the old signer.
        expect(tx.getInput(0).finalScriptWitness?.length).toBeGreaterThan(0);
        expect(tx.outputsLength).toBe(1);
        expect(hex.encode(tx.getOutput(0).script!)).toBe(
            hex.encode(wallet.boardingTapscript.pkScript),
        );
    });

    it("leaves out a coin an in-flight settle is spending", async () => {
        const { wallet, deprecated, coinsByAddress, broadcast } = await setup();
        coinsByAddress.set(deprecated.address, [coin("dd"), coin("ee")]);
        (wallet as any)._pendingSpendOutpoints.add(`${coin("ee").txid}:0`);
        const manager = await wallet.getVtxoManager();

        await manager.sweepExpiredBoardingUtxos();

        const tx = Transaction.fromRaw(hex.decode(broadcast.mock.calls[0][0]));
        expect(tx.inputsLength).toBe(1);
        expect(hex.encode(tx.getInput(0).txid!)).toBe(coin("dd").txid);
    });
});
