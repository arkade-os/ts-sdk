import { describe, it, expect } from "vitest";
import {
    computeReconnectDelay,
    DEFAULT_CONTRACT_WATCHER_CONFIG,
} from "../src/contracts/contractWatcher";

describe("computeReconnectDelay", () => {
    it("grows exponentially from the base delay", () => {
        expect(computeReconnectDelay(1, 1000, 5000)).toBe(1000); // 1000 * 2^0
        expect(computeReconnectDelay(2, 1000, 5000)).toBe(2000); // 1000 * 2^1
        expect(computeReconnectDelay(3, 1000, 5000)).toBe(4000); // 1000 * 2^2
    });

    it("caps at maxMs so recovery after a server restart stays prompt", () => {
        expect(computeReconnectDelay(4, 1000, 5000)).toBe(5000); // 8000 -> capped
        expect(computeReconnectDelay(20, 1000, 5000)).toBe(5000); // far past the cap
    });
});

describe("ContractWatcher reconnect defaults", () => {
    it("recovers promptly: backoff cap and failsafe poll are bounded", () => {
        // Regression guard: a server restart (e.g. an operator signer rotation)
        // briefly drops the SSE subscription. The wallet must re-track state
        // quickly afterwards, so neither the reconnect backoff nor the failsafe
        // poll may sit in the tens of seconds.
        expect(DEFAULT_CONTRACT_WATCHER_CONFIG.maxReconnectDelayMs).toBeLessThanOrEqual(5_000);
        expect(DEFAULT_CONTRACT_WATCHER_CONFIG.failsafePollIntervalMs).toBeLessThanOrEqual(20_000);
    });
});
