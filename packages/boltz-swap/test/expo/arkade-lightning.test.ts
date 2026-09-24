import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { warnOnRemovedBackgroundFields } from "../../src/expo/arkade-lightning";

describe("warnOnRemovedBackgroundFields", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    it("does not warn when neither removed field is present", () => {
        warnOnRemovedBackgroundFields({
            taskQueue: {},
            foregroundIntervalMs: 20_000,
        });
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it("warns and names taskName when present (pre-fix-#136 field)", () => {
        warnOnRemovedBackgroundFields({
            taskName: "ark-swap-poll",
            taskQueue: {},
        });
        expect(warnSpy).toHaveBeenCalledOnce();
        const msg = String(warnSpy.mock.calls[0][0]);
        expect(msg).toContain("taskName");
        expect(msg).toContain("@arkade-os/boltz-swap/expo/background");
    });

    it("warns and names minimumBackgroundInterval when present", () => {
        warnOnRemovedBackgroundFields({
            taskQueue: {},
            minimumBackgroundInterval: 15,
        });
        expect(warnSpy).toHaveBeenCalledOnce();
        const msg = String(warnSpy.mock.calls[0][0]);
        expect(msg).toContain("minimumBackgroundInterval");
    });

    it("lists both removed fields in a single warning when both present", () => {
        warnOnRemovedBackgroundFields({
            taskName: "ark-swap-poll",
            minimumBackgroundInterval: 15,
            taskQueue: {},
        });
        expect(warnSpy).toHaveBeenCalledOnce();
        const msg = String(warnSpy.mock.calls[0][0]);
        expect(msg).toContain("taskName");
        expect(msg).toContain("minimumBackgroundInterval");
    });

    it("does not throw on null / undefined / non-object inputs", () => {
        expect(() => warnOnRemovedBackgroundFields(null)).not.toThrow();
        expect(() => warnOnRemovedBackgroundFields(undefined)).not.toThrow();
        expect(() => warnOnRemovedBackgroundFields("nonsense")).not.toThrow();
        expect(warnSpy).not.toHaveBeenCalled();
    });
});
