import { afterEach, describe, expect, it, vi } from "vitest";
import { baseFetch, fetch, FetchError } from "../src/utils/fetch";

afterEach(() => vi.unstubAllGlobals());

describe("FetchError", () => {
    it("is a named Error subclass carrying url, method and cause", () => {
        const cause = new TypeError("Failed to fetch");
        const err = new FetchError("boom", {
            url: "https://x.test/a",
            method: "POST",
            cause,
        });
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(FetchError);
        expect(err.name).toBe("FetchError");
        expect(err.message).toBe("boom");
        expect(err.url).toBe("https://x.test/a");
        expect(err.method).toBe("POST");
        expect(err.cause).toBe(cause);
    });
});

describe("baseFetch", () => {
    it("wraps a transport-level rejection in FetchError, defaulting method to GET and honoring init.method", async () => {
        const cause = new TypeError("Failed to fetch");
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw cause;
            }),
        );

        const getErr = await baseFetch("https://esplora.test/address/abc/utxo").catch((e) => e);
        expect(getErr).toBeInstanceOf(FetchError);
        expect(getErr.name).toBe("FetchError");
        expect(getErr.message).toContain("GET https://esplora.test/address/abc/utxo");
        expect(getErr.url).toBe("https://esplora.test/address/abc/utxo");
        expect(getErr.method).toBe("GET");
        expect(getErr.cause).toBe(cause);

        const postErr = await baseFetch("https://x.test/tx", { method: "POST" }).catch((e) => e);
        expect(postErr.method).toBe("POST");
        expect(postErr.message).toContain("POST https://x.test/tx");
    });

    it("derives the request URL from a URL instance", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new TypeError("Failed to fetch");
            }),
        );

        const err = await baseFetch(new URL("https://x.test/path")).catch((e) => e);
        expect(err).toBeInstanceOf(FetchError);
        expect(err.url).toBe("https://x.test/path");
    });

    it("derives URL and method from a Request instance", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new TypeError("Failed to fetch");
            }),
        );

        const request = new Request("https://x.test/req", { method: "PUT" });
        const err = await baseFetch(request).catch((e) => e);
        expect(err).toBeInstanceOf(FetchError);
        expect(err.url).toBe("https://x.test/req");
        expect(err.method).toBe("PUT");
    });

    it("passes a resolving Response through unchanged", async () => {
        const response = { ok: true, status: 200 } as unknown as Response;
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => response),
        );

        const result = await baseFetch("https://x.test/ok");
        expect(result).toBe(response);
    });

    it("still throws synchronously when the Fetch API is unavailable", () => {
        vi.stubGlobal("fetch", undefined);
        expect(() => baseFetch("https://x.test/none")).toThrow(
            "Fetch API is not available in this environment.",
        );
    });

    it("does not wrap the unavailable-fetch guard error as a FetchError", () => {
        vi.stubGlobal("fetch", undefined);
        try {
            baseFetch("https://x.test/none");
            expect.unreachable("baseFetch should have thrown");
        } catch (e) {
            expect(e).toBeInstanceOf(Error);
            expect(e).not.toBeInstanceOf(FetchError);
        }
    });
});

describe("Ark-server fetch wrapper", () => {
    it("surfaces the wrapped FetchError on transport failure (delegates to baseFetch)", async () => {
        const cause = new TypeError("Failed to fetch");
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw cause;
            }),
        );

        const err = await fetch("https://ark.test/v1/info").catch((e) => e);
        expect(err).toBeInstanceOf(FetchError);
        expect(err.name).toBe("FetchError");
        expect(err.url).toBe("https://ark.test/v1/info");
        expect(err.cause).toBe(cause);
    });

    it("passes a resolving Response through unchanged", async () => {
        const response = { ok: true } as unknown as Response;
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => response),
        );

        const result = await fetch("https://ark.test/v1/info");
        expect(result).toBe(response);
    });
});
