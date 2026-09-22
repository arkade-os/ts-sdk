import { beforeEach, describe, expect, it } from "vitest";
import { DefaultVtxo } from "../src/script/default";
import { installRestoreHarness, makeStaticWalletForTest } from "./helpers/restoreWallet";

/** Spin until `predicate` holds, so a test never races a scheduler. */
const until = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !predicate(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
};

describe("boarding fetch fans out across addresses", () => {
    beforeEach(installRestoreHarness);

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
        const gates: Array<() => void> = [];
        (wallet as any).onchainProvider = {
            getCoins: async (address: string) => {
                started.push(address);
                await new Promise<void>((resolve) => gates.push(resolve));
                return [];
            },
        };

        const pending = wallet.getBoardingUtxos();
        // The second address must be in flight while the first is parked; a
        // sequential loop would still be showing one.
        await until(() => started.length === 2);
        expect(started).toHaveLength(2);

        for (const release of gates) release();
        await pending;

        await wallet.dispose();
    });
});
