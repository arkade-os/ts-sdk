import { afterEach, describe, expect, it, vi } from "vitest";
import { pollUntil } from "../src/onchainHtlc";

describe("pollUntil duration", () => {
    afterEach(() => vi.useRealTimers());

    it.each([-1, 0.5, NaN, Infinity, 2 ** 31])(
        "rejects invalid poll delay %s before probing",
        async (pollMs) => {
            const probe = vi.fn();
            await expect(pollUntil(probe, { pollMs }, "deadline", "expired")).rejects.toThrow(
                "pollMs",
            );
            expect(probe).not.toHaveBeenCalled();
        },
    );

    it("keeps zero as immediate repolling", async () => {
        vi.useFakeTimers();
        const probe = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("funded");
        const pending = pollUntil(probe, { pollMs: 0 }, "deadline", "expired");
        await vi.advanceTimersByTimeAsync(0);
        await expect(pending).resolves.toBe("funded");
        expect(probe).toHaveBeenCalledTimes(2);
    });
});
