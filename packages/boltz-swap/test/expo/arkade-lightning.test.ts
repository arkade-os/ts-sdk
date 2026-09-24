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

    it("does not throw on null / undefined / non-object inputs", () => {
        expect(() => warnOnRemovedBackgroundFields(null)).not.toThrow();
        expect(() => warnOnRemovedBackgroundFields(undefined)).not.toThrow();
        expect(() => warnOnRemovedBackgroundFields("nonsense")).not.toThrow();
        expect(warnSpy).not.toHaveBeenCalled();
    });
});
