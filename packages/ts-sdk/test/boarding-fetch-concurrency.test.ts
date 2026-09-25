import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { DefaultVtxo } from "../src/script/default";
import {
    installRestoreHarness,
    makeStaticWalletForTest,
    teardownRestoreHarness,
} from "./helpers/restoreWallet";

/** Spin until `predicate` holds, so a test never races a scheduler. */
const until = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !predicate(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
};

describe("boarding fetch fans out across addresses", () => {
    beforeEach(installRestoreHarness);
    afterEach(teardownRestoreHarness);

    it("starts every address's fetch before any of them resolves", async () => {
        const handle = await makeStaticWalletForTest();
        const wallet = handle.wallet as typeof handle.wallet & {
            getBoardingTapscripts(): Promise<DefaultVtxo.Script[]>;
        };
        // Two distinct boarding addresses, without deriving a real rotation: the
        // wallets that pay for this are the ones whose fan-out has accumulated,
        // and a second script with a different key is one.
        (wallet as any).getBoardingTapscripts = async () => [
            wallet.boardingTapscript,
            new DefaultVtxo.Script({
                ...wallet.boardingTapscript.options,
                pubKey: new Uint8Array(32).fill(7),
            }),
        ];

        const started: string[] = [];
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        (wallet as any).onchainProvider = {
            getCoins: async (address: string) => {
                started.push(address);
                await released;
                return [];
            },
        };
        onTestFinished(async () => {
            release(); // a fetch still parked would hang dispose()
            await wallet.dispose();
        });

        const pending = wallet.getBoardingUtxos();
        // The second address must be in flight while the first is parked; a
        // sequential loop would still be showing one.
        await until(() => new Set(started).size === 2); // by address: background polls fetch too
        expect(new Set(started).size).toBe(2);

        release();
        await pending;
    });

    it("writes nothing once any address's fetch has failed", async () => {
        const { wallet, walletRepository } = await makeStaticWalletForTest();
        const second = new DefaultVtxo.Script({
            ...wallet.boardingTapscript.options,
            pubKey: new Uint8Array(32).fill(7),
        });
        (wallet as any).getBoardingTapscripts = async () => [wallet.boardingTapscript, second];
        const [failing, late] = [wallet.boardingTapscript, second].map((s) =>
            s.onchainAddress(wallet.network),
        );
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        (wallet as any).onchainProvider = {
            getCoins: async (address: string) => {
                if (address === failing) throw new Error("explorer down");
                await released;
                return [
                    { txid: "ab".repeat(32), vout: 0, value: 5_000, status: { confirmed: true } },
                ];
            },
        };
        onTestFinished(async () => {
            release();
            await wallet.dispose();
        });

        await expect(wallet.getBoardingUtxos()).rejects.toThrow("explorer down");
        // A caller reacting to the failure (here: clearing) must not see a late write.
        await walletRepository.clear();
        release();
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(await walletRepository.getUtxos(late)).toEqual([]);
    });

    it("saves every address's coins in one write", async () => {
        const { wallet, walletRepository } = await makeStaticWalletForTest();
        const second = new DefaultVtxo.Script({
            ...wallet.boardingTapscript.options,
            pubKey: new Uint8Array(32).fill(7),
        });
        (wallet as any).getBoardingTapscripts = async () => [wallet.boardingTapscript, second];
        const addresses = [wallet.boardingTapscript, second].map((s) =>
            s.onchainAddress(wallet.network),
        );
        const coin = { txid: "ab".repeat(32), vout: 0, value: 5_000, status: { confirmed: true } };
        (wallet as any).onchainProvider = {
            getCoins: async (address: string) => (address === addresses[1] ? [coin] : []),
        };
        const saveUtxos = vi.spyOn(walletRepository, "saveUtxos");
        onTestFinished(() => wallet.dispose());

        await wallet.getBoardingUtxos();

        // The background poll writes too; only calls carrying the second address are ours.
        const writes = (saveUtxos.mock.calls as unknown[][]).filter(([arg]) =>
            arg instanceof Map ? arg.has(addresses[1]) : arg === addresses[1],
        );
        expect(writes.length).toBeGreaterThan(0);
        for (const args of writes) {
            expect(args).toHaveLength(1);
            expect([...(args[0] as Map<string, unknown>).keys()]).toEqual(addresses);
        }
        const [saved] = await walletRepository.getUtxos(addresses[1]);
        expect(saved.txid).toBe(coin.txid);
    });
});
