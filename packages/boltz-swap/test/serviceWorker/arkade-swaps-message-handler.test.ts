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

        expect((globalThis as any).self.clients.matchAll).toHaveBeenCalledTimes(1);
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "SM-EVENT-SWAP_UPDATE" }),
        );
    });

    it("includes uncontrolled windows so pages before SW claim receive events", async () => {
        await (handler as any).broadcastEvent({
            tag: "TAG",
            type: "SM-EVENT-SWAP_UPDATE",
            payload: { swap: { id: "s1" }, oldStatus: "swap.created" as BoltzSwapStatus },
        });

        expect((globalThis as any).self.clients.matchAll).toHaveBeenCalledWith({
            includeUncontrolled: true,
            type: "window",
        });
    });
});

describe("ArkadeSwapsMessageHandler SM-START", () => {
    // The runtime proxy sends SM-START with no payload: the SW side sources its
    // swaps from the repository (see ArkadeSwaps.startSwapManager).
    it("dispatches to the SW-side manager without a client swap set", async () => {
        const arkadeSwaps = { startSwapManager: vi.fn().mockResolvedValue(undefined) };
        const handler = new ArkadeSwapsMessageHandler({} as SwapRepository);
        (handler as any).handler = arkadeSwaps;
        (handler as any).wallet = {};

        const response = await handler.handleMessage({
            id: "req",
            tag: handler.messageTag,
            type: "SM-START",
        } as any);

        expect(response).toMatchObject({ type: "SM-STARTED" });
        expect(arkadeSwaps.startSwapManager).toHaveBeenCalledWith();
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
                } as any),
            ).toBe(true);
        }

        expect(
            handler.isLongRunning({
                id: "req",
                tag: handler.messageTag,
                type: "GET_FEES",
            } as any),
        ).toBe(false);
    });
});
