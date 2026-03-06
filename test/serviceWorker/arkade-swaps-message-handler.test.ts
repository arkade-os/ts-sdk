import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ArkadeSwapsMessageHandler } from "../../src/serviceWorker/arkade-swaps-message-handler";
import { SwapRepository } from "../../src/repositories/swap-repository";
import { PendingReverseSwap } from "../../src/types";
import { BoltzSwapStatus } from "../../src/boltz-swap-provider";

describe("ArkadeSwapsMessageHandler broadcastEvent", () => {
    let handler: ArkadeSwapsMessageHandler;
    let postMessage: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        // Fake clients API
        postMessage = vi.fn();
        (globalThis as any).self = {
            clients: {
                matchAll: vi.fn().mockResolvedValue([{ postMessage }]),
            },
        };
        handler = new ArkadeSwapsMessageHandler({} as SwapRepository);
    });

    afterEach(() => {
        delete (globalThis as any).self;
    });

    it("broadcasts swap update event to all clients", async () => {
        const swap = { id: "s1" } as PendingReverseSwap;
        await (handler as any).broadcastEvent({
            tag: "TAG",
            type: "SM-EVENT-SWAP_UPDATE",
            payload: { swap, oldStatus: "swap.created" as BoltzSwapStatus },
        });

        expect((globalThis as any).self.clients.matchAll).toHaveBeenCalledTimes(
            1
        );
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "SM-EVENT-SWAP_UPDATE" })
        );
    });
});
