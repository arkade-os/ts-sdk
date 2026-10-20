import { describe, expect, it, vi } from "vitest";
import { InMemoryContractRepository, InMemoryWalletRepository, Wallet } from "../../src";
import { MessageBus } from "../../src/worker/messageBus";

describe("MessageBus default buildServices", () => {
    it.each([true, undefined])(
        "hands concurrentSpending=%s to the worker's wallet",
        async (concurrentSpending) => {
            const bus = new MessageBus(
                new InMemoryWalletRepository(),
                new InMemoryContractRepository(),
                {
                    messageHandlers: [],
                },
            );
            const create = vi
                .spyOn(Wallet, "create")
                .mockResolvedValue({ dispose: vi.fn() } as unknown as Wallet);

            await (bus as any).buildServices({
                wallet: { type: "single-key", privateKey: "15".repeat(32) },
                arkServer: { url: "https://ark.example.test" },
                concurrentSpending,
            });

            expect(create.mock.calls[0][0].concurrentSpending).toBe(concurrentSpending);
            create.mockRestore();
        },
    );
});
