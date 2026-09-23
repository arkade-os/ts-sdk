import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
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
});
