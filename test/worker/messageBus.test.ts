import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    InMemoryWalletRepository,
    InMemoryContractRepository,
} from "../../src";
import { MessageBus } from "../../src/worker/messageBus";

describe("MessageBus PING/PONG", () => {
    let messageHandler: Function;

    beforeEach(() => {
        const selfMock = {
            addEventListener: vi.fn((type: string, handler: Function) => {
                if (type === "message") messageHandler = handler;
            }),
            removeEventListener: vi.fn(),
            skipWaiting: vi.fn(),
            clients: {
                claim: vi.fn(),
                matchAll: vi.fn().mockResolvedValue([]),
            },
            setTimeout: (fn: Function, ms: number) =>
                setTimeout(fn, ms) as unknown as number,
            clearTimeout: (id: number) => clearTimeout(id),
        };
        vi.stubGlobal("self", selfMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("responds to PING with PONG", async () => {
        const bus = new MessageBus(
            new InMemoryWalletRepository(),
            new InMemoryContractRepository(),
            { messageHandlers: [] }
        );
        await bus.start();

        const postMessage = vi.fn();
        await messageHandler({
            data: { id: "ping-1", tag: "PING" },
            source: { postMessage },
            waitUntil: vi.fn((p: Promise<any>) => p),
        });

        expect(postMessage).toHaveBeenCalledWith({
            id: "ping-1",
            tag: "PONG",
        });

        await bus.stop();
    });

    it("responds to PING even when bus is not initialized", async () => {
        const bus = new MessageBus(
            new InMemoryWalletRepository(),
            new InMemoryContractRepository(),
            { messageHandlers: [] }
        );
        await bus.start();

        // Don't send INITIALIZE_MESSAGE_BUS — bus is uninitialized

        const postMessage = vi.fn();
        await messageHandler({
            data: { id: "ping-2", tag: "PING" },
            source: { postMessage },
            waitUntil: vi.fn((p: Promise<any>) => p),
        });

        expect(postMessage).toHaveBeenCalledWith({
            id: "ping-2",
            tag: "PONG",
        });
        // Should not have sent an error (which the !initialized gate would)
        expect(postMessage).toHaveBeenCalledTimes(1);

        await bus.stop();
    });
});
