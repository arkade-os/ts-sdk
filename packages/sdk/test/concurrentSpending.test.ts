import { afterEach, describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { ArkAddress } from "../src";
import { fundedWallet, stallSubmits } from "./concurrentSpendingFixture";

afterEach(() => vi.restoreAllMocks());

describe("send without concurrentSpending", () => {
    it("queues a second send behind the first, which then spends the first's change", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { wallet, outpoints } = await fundedWallet();
        const submits = stallSubmits(wallet);
        const to = await wallet.getAddress();
        const own = hex.encode(ArkAddress.decode(to).pkScript);

        const first = wallet.send({ address: to, amount: 2_000 });
        const second = wallet.send({ address: to, amount: 2_000 });
        await vi.waitFor(() => expect(submits).toHaveLength(1));
        await new Promise((r) => setTimeout(r, 50));
        expect(submits).toHaveLength(1);
        expect(submits[0].inputs).toEqual([outpoints[0]]);
        expect(submits[0].outputs).toEqual([
            [own, 2_000n],
            [own, 8_000n],
        ]);

        submits[0].finish();
        await expect(first).resolves.toBe("1".repeat(64));
        await vi.waitFor(() => expect(submits).toHaveLength(2));
        expect(submits[1].inputs).toEqual([`${"1".repeat(64)}:1`]);
        submits[1].finish();
        await expect(second).resolves.toBe("2".repeat(64));
        await wallet.dispose();
    });
});
