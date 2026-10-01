import { afterEach, expect, it, vi } from "vitest";
import { createVtxo, type TestArkWallet } from "./e2e/utils";

vi.mock("child_process", () => ({ execSync: vi.fn(() => "") }));

afterEach(() => vi.useRealTimers());

it("waits for settlement membership rather than matching the commitment to the leaf txid", async () => {
    vi.useFakeTimers();
    const commitment = "11".repeat(32);
    const funded = [{ txid: "22".repeat(32), vout: 0, value: 10_000, commitmentTxIds: [] }];
    const settled = [{ ...funded[0], txid: "33".repeat(32), commitmentTxIds: [commitment] }];
    const wallet = {
        getAddress: vi.fn().mockResolvedValue("address"),
        getVtxos: vi
            .fn()
            .mockResolvedValueOnce(funded)
            .mockResolvedValueOnce(funded)
            .mockResolvedValueOnce([])
            .mockResolvedValue(settled),
        settle: vi.fn().mockResolvedValue(commitment),
    };
    const result = createVtxo({ wallet } as unknown as TestArkWallet, 10_000);
    const assertion = expect(result).resolves.toBe(commitment);
    await vi.runAllTimersAsync();
    await assertion;
    expect(wallet.getVtxos).toHaveBeenCalledTimes(4);
});
