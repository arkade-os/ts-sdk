import { describe, expect, it } from "vitest";
import {
    eventSourceIterator,
    isEventSourceError,
} from "../src/providers/utils";
import { MockEventSource } from "./mocks/eventSource";

describe("eventSourceIterator", () => {
    it("surfaces reconnecting EventSource errors as EventSourceError", async () => {
        const eventSource = new MockEventSource();
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
        const eventSource = new MockEventSource();
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

    it("close wakes a pending next without relying on an EventSource error", async () => {
        const eventSource = new MockEventSource();
        const iterator = eventSourceIterator(
            eventSource as unknown as EventSource
        );
        const next = iterator.next();

        iterator.close();

        await expect(next).rejects.toMatchObject({
            name: "AbortError",
            message: "EventSource closed",
        });
        expect(eventSource.closed).toBe(true);
        expect(eventSource.listenerCount("message")).toBe(0);
        expect(eventSource.listenerCount("error")).toBe(0);
    });

    it("return closes the EventSource and wakes a pending next", async () => {
        const eventSource = new MockEventSource();
        const iterator = eventSourceIterator(
            eventSource as unknown as EventSource
        );
        const next = iterator.next();

        const returned = iterator.return();

        await expect(next).rejects.toMatchObject({
            name: "AbortError",
            message: "EventSource closed",
        });
        await expect(returned).resolves.toMatchObject({ done: true });
        expect(eventSource.closed).toBe(true);
        expect(eventSource.listenerCount("message")).toBe(0);
        expect(eventSource.listenerCount("error")).toBe(0);
    });
});
