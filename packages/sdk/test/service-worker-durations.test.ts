import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SingleKey } from "../src/identity/singleKey";
import { InMemoryWalletRepository } from "../src/repositories/inMemory/walletRepository";
import { InMemoryContractRepository } from "../src/repositories/inMemory/contractRepository";
import { ServiceWorkerReadonlyWallet } from "../src/wallet/serviceWorker/wallet";

describe("service-worker wallet durations", () => {
    const postMessage = vi.fn();

    beforeEach(() => {
        vi.useFakeTimers();
        postMessage.mockClear();
        vi.stubGlobal("navigator", {
            serviceWorker: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    const options = () => ({
        serviceWorker: { postMessage } as unknown as ServiceWorker,
        identity: SingleKey.fromHex("01".repeat(32)),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
    });

    it.each([-1, 0.5, NaN, Infinity, 2 ** 31])(
        "rejects invalid bootstrap and per-request timeouts %s before posting",
        async (value) => {
            await expect(
                ServiceWorkerReadonlyWallet.create({ ...options(), messageBusTimeoutMs: value }),
            ).rejects.toThrow("messageBusTimeoutMs");
            await expect(
                ServiceWorkerReadonlyWallet.create({
                    ...options(),
                    messageTimeouts: { GET_BALANCE: value },
                }),
            ).rejects.toThrow("messageTimeouts.GET_BALANCE");
            expect(postMessage).not.toHaveBeenCalled();
        },
    );

    it("keeps zero as an immediate bootstrap timeout", async () => {
        const rejection = expect(
            ServiceWorkerReadonlyWallet.create({ ...options(), messageBusTimeoutMs: 0 }),
        ).rejects.toThrow("MessageBus timed out");
        await vi.advanceTimersByTimeAsync(0);
        await rejection;
        expect(postMessage).toHaveBeenCalledTimes(1);
    });
});
