import { describe, expect, it, vi } from "vitest";
import * as arkTransaction from "../src/utils/arkTransaction";
import { fundedWallet } from "./concurrentSpendingFixture";

vi.mock("../src/utils/arkTransaction", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/utils/arkTransaction")>()),
    buildOffchainTx: vi.fn(() => ({ arkTx: {}, checkpoints: [] })),
    submitOffchainTx: vi.fn(),
}));

describe("the pending Arkade transaction flag", () => {
    it("stays set until every overlapping submit has finalized", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { wallet, coins } = await fundedWallet({ concurrentSpending: true });
        const tapTree = (wallet as any).offchainTapscript.encode();
        const finalize: Array<() => void> = [];
        vi.mocked(arkTransaction.submitOffchainTx).mockImplementation(
            async (_provider, _tx, _signer, hooks) => {
                await hooks?.beforeSubmit?.();
                await new Promise<void>((resolve) => finalize.push(resolve));
                await hooks?.afterFinalize?.();
                return { arkTxid: "x", signedCheckpointTxs: [] } as any;
            },
        );
        const flag = async () =>
            (await wallet.walletRepository.getWalletState())?.settings?.hasPendingTx;

        const first = wallet.buildAndSubmitOffchainTx([{ ...coins[0], tapTree }], []);
        const second = wallet.buildAndSubmitOffchainTx([{ ...coins[1], tapTree }], []);
        await vi.waitFor(() => expect(finalize).toHaveLength(2));

        finalize[0]();
        await first;
        expect(await flag()).toBe(true);
        finalize[1]();
        await second;
        expect(await flag()).toBe(false);
        await wallet.dispose();
    });
});
