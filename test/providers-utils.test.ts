import { describe, expect, it } from "vitest";
import {
    eventSourceIterator,
    isEventSourceError,
} from "../src/providers/utils";

class ControlledEventSource {
    readyState = 1;
    private listeners = new Map<string, Set<(event: unknown) => void>>();

    addEventListener(type: string, handler: (event: unknown) => void) {
        if (!this.listeners.has(type)) {
            this.listeners.set(type, new Set());
        }
        this.listeners.get(type)!.add(handler);
    }

    removeEventListener(type: string, handler: (event: unknown) => void) {
        this.listeners.get(type)?.delete(handler);
    }

    emitMessage(data: string) {
        this.emit("message", { data });
    }

    emitError(readyState: number) {
        this.readyState = readyState;
        this.emit("error", new Event("error"));
    }

    private emit(type: string, event: unknown) {
        for (const handler of this.listeners.get(type) ?? []) {
            handler(event);
        }
    }
}

describe("eventSourceIterator", () => {
    it("surfaces reconnecting EventSource errors as EventSourceError", async () => {
        const eventSource = new ControlledEventSource();
        const iterator = eventSourceIterator(
            eventSource as unknown as EventSource
        );
        const next = iterator.next();

        eventSource.emitError(0);

        await expect(next).rejects.toMatchObject({
            name: "EventSourceError",
            message: "EventSource error",
        });

        await next.catch((error) => {
            expect(isEventSourceError(error)).toBe(true);
        });
    });

    it("surfaces closed EventSource errors as EventSourceError", async () => {
        const eventSource = new ControlledEventSource();
        const iterator = eventSourceIterator(
            eventSource as unknown as EventSource
        );
        const next = iterator.next();

        eventSource.emitError(2);

        await expect(next).rejects.toMatchObject({
            name: "EventSourceError",
            message: "EventSource error",
        });

        await next.catch((error) => {
            expect(isEventSourceError(error)).toBe(true);
        });
    });
});
