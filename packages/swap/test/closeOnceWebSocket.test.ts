import { describe, expect, it, vi } from "vitest";
import { CloseOnceWebSocket } from "../src/closeOnceWebSocket";

describe("CloseOnceWebSocket", () => {
    it("closes the underlying socket once however often close() is called", () => {
        const close = vi.spyOn(WebSocket.prototype, "close");
        try {
            const socket = new CloseOnceWebSocket!("ws://127.0.0.1:1");
            socket.close();
            socket.close();
            expect(close).toHaveBeenCalledTimes(1);
        } finally {
            close.mockRestore();
        }
    });
});
