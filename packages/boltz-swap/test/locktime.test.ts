import { describe, it, expect, vi, afterEach } from "vitest";
import {
    CLTV_IMMATURE_RETRY_SEC,
    LOCKTIME_HEIGHT_THRESHOLD,
    isBlockHeightLocktime,
    isRefundLocktimeReached,
    refundLocktimeBasis,
    refundRetryAt,
} from "../src/utils/locktime";

// A fixed wall clock, well past any timestamp locktime built from it.
const NOW_SEC = 1_800_000_000;

const freezeClock = () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
};

afterEach(() => {
    vi.useRealTimers();
});

describe("BIP65 denomination boundary", () => {
    it("treats 499_999_999 as a block height and 500_000_000 as a timestamp", () => {
        expect(isBlockHeightLocktime(LOCKTIME_HEIGHT_THRESHOLD - 1)).toBe(true);
        expect(isBlockHeightLocktime(LOCKTIME_HEIGHT_THRESHOLD)).toBe(false);
        expect(LOCKTIME_HEIGHT_THRESHOLD).toBe(500_000_000);
    });
});

describe("isRefundLocktimeReached", () => {
    describe("timestamp-denominated locktime", () => {
        it("falls back to the wall clock and ignores an absent tip", () => {
            freezeClock();
            expect(isRefundLocktimeReached(NOW_SEC - 1)).toBe(true);
            expect(isRefundLocktimeReached(NOW_SEC + 1)).toBe(false);
        });

        it("is unaffected by the tip when one is supplied", () => {
            freezeClock();
            // A tip far below the locktime must not make an elapsed timestamp
            // read as unreached — the two are different units entirely.
            expect(isRefundLocktimeReached(NOW_SEC - 1, 100)).toBe(true);
            expect(isRefundLocktimeReached(NOW_SEC + 1, 999_999_999)).toBe(false);
        });

        it("treats an exactly-equal timestamp as reached", () => {
            freezeClock();
            expect(isRefundLocktimeReached(NOW_SEC)).toBe(true);
        });
    });

    describe("block-height locktime", () => {
        const HEIGHT = 200_000;

        it("is not reached when the tip is below the locktime", () => {
            expect(isRefundLocktimeReached(HEIGHT, HEIGHT - 1)).toBe(false);
        });

        it("is reached when the tip is exactly at the locktime", () => {
            expect(isRefundLocktimeReached(HEIGHT, HEIGHT)).toBe(true);
        });

        it("is reached when the tip is above the locktime", () => {
            expect(isRefundLocktimeReached(HEIGHT, HEIGHT + 1)).toBe(true);
        });

        it("counts as not reached when the tip is unknown", () => {
            // The conservative direction: defer to the cooperative refund path
            // rather than attempt a spend the server would reject as immature.
            expect(isRefundLocktimeReached(HEIGHT, undefined)).toBe(false);
        });

        it("does not fall back to the wall clock when the tip is unknown", () => {
            freezeClock();
            // Wall-clock seconds dwarf any plausible height, so a wall-clock
            // fallback here would report every height locktime as long elapsed.
            expect(isRefundLocktimeReached(HEIGHT)).toBe(false);
        });
    });
});

describe("refundRetryAt", () => {
    it("re-polls a block height on the block-interval cadence", () => {
        freezeClock();
        // A height carries no wall-clock deadline, so there is nothing to wait
        // *until* — only a cadence to wait *for*.
        expect(refundRetryAt(200_000)).toBe(NOW_SEC + CLTV_IMMATURE_RETRY_SEC);
    });

    it("waits until the locktime itself for a timestamp", () => {
        freezeClock();
        expect(refundRetryAt(NOW_SEC + 3600)).toBe(NOW_SEC + 3600);
    });
});

describe("refundLocktimeBasis", () => {
    it("reports the chain tip for a block height", () => {
        expect(refundLocktimeBasis(200_000, 199_000)).toBe("chainTipHeight=199000");
    });

    it("reports an unknown tip rather than omitting it", () => {
        expect(refundLocktimeBasis(200_000, undefined)).toBe("chainTipHeight=unknown");
    });

    it("reports the wall clock for a timestamp, ignoring any tip", () => {
        freezeClock();
        expect(refundLocktimeBasis(NOW_SEC + 10, 199_000)).toBe(`currentTimestamp=${NOW_SEC}`);
    });
});
