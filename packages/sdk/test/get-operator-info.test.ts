import { describe, expect, it, vi } from "vitest";
import { ReadonlyWallet } from "../src/wallet/wallet";
import { ExpoWallet } from "../src/wallet/expo/wallet";
import { ServiceWorkerReadonlyWallet } from "../src/wallet/serviceWorker/wallet";

describe("deprecated getArkadeInfo", () => {
    it.each([
        ["ReadonlyWallet", ReadonlyWallet],
        ["ExpoWallet", ExpoWallet],
        ["ServiceWorkerReadonlyWallet", ServiceWorkerReadonlyWallet],
    ])("forwards on %s", async (_name, wallet) => {
        const info = { digest: "d" };
        const getOperatorInfo = vi.fn().mockResolvedValue(info);

        const result = await wallet.prototype.getArkadeInfo.call({ getOperatorInfo } as never, {
            requireLive: true,
        });

        expect(result).toBe(info);
        expect(getOperatorInfo).toHaveBeenCalledWith({ requireLive: true });
    });
});
