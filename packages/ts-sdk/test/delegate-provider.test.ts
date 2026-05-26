import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestDelegateProvider } from "../src";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("RestDelegateProvider.getDelegateInfo", () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const respondWith = (body: unknown) =>
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(body),
        });

    it("normalizes delegateAddress to a string when the payload field is a non-string", async () => {
        // delegateAddress is a truthy non-string; delegatorAddress is the valid one.
        respondWith({
            pubkey: "02abc",
            fee: "0",
            delegateAddress: 123,
            delegatorAddress: "tark1validaddress",
        });

        const info = await new RestDelegateProvider("http://localhost:7012").getDelegateInfo();

        expect(typeof info.delegateAddress).toBe("string");
        expect(info.delegateAddress).toBe("tark1validaddress");
    });

    it("prefers delegateAddress when it is a valid string", async () => {
        respondWith({
            pubkey: "02abc",
            fee: "0",
            delegateAddress: "tark1delegate",
            delegatorAddress: "tark1legacy",
        });

        const info = await new RestDelegateProvider("http://localhost:7012").getDelegateInfo();

        expect(info.delegateAddress).toBe("tark1delegate");
    });

    it("rejects payloads where neither address is a non-empty string", async () => {
        respondWith({
            pubkey: "02abc",
            fee: "0",
            delegateAddress: 123,
            delegatorAddress: 456,
        });

        await expect(
            new RestDelegateProvider("http://localhost:7012").getDelegateInfo(),
        ).rejects.toThrow("Invalid delegate info");
    });
});
