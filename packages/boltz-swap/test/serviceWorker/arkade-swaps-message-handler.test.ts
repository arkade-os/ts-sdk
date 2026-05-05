import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    ArkadeSwapsMessageHandler,
    LONG_RUNNING_ARKADE_SWAPS_REQUEST_TYPES,
} from "../../src/serviceWorker/arkade-swaps-message-handler";
import { SwapRepository } from "../../src/repositories/swap-repository";
import { BoltzReverseSwap } from "../../src/types";
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
        const swap = { id: "s1" } as BoltzReverseSwap;
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

describe("ArkadeSwapsMessageHandler long-running requests", () => {
    it("uses the exported long-running request set for bus timeout opt-out", () => {
        const handler = new ArkadeSwapsMessageHandler({} as SwapRepository);

        for (const type of LONG_RUNNING_ARKADE_SWAPS_REQUEST_TYPES) {
            expect(
                handler.isLongRunning({
                    id: "req",
                    tag: handler.messageTag,
                    type,
                } as any)
            ).toBe(true);
        }

        expect(
            handler.isLongRunning({
                id: "req",
                tag: handler.messageTag,
                type: "GET_FEES",
            } as any)
        ).toBe(false);
    });
});
