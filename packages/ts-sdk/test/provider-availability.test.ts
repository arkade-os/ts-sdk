import { beforeEach, describe, expect, it, vi } from "vitest";
import { RestIndexerProvider, RestArkProvider, ProviderUnavailableError } from "../src";
import { throwIfHttpUnavailable, toProviderUnavailable } from "../src/providers/errors";
import { FetchError } from "../src/utils/fetch";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

// Preserve the real FetchError (and other exports); only override the two
// fetch entry points so transport failures / HTTP statuses are controllable.
vi.mock("../src/utils/fetch", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/utils/fetch")>();
    return { ...actual, fetch: mockFetch, baseFetch: mockFetch };
});

describe("throwIfHttpUnavailable", () => {
    it("throws a typed unavailable error for 429 and any 5xx", () => {
        for (const status of [429, 500, 502, 503]) {
            expect(() =>
                throwIfHttpUnavailable({ status, statusText: "x" } as Response, "indexer"),
            ).toThrow(ProviderUnavailableError);
        }
    });

    it("does not throw for 2xx / 4xx", () => {
        for (const status of [200, 400, 404, 409]) {
            expect(() =>
                throwIfHttpUnavailable({ status, statusText: "x" } as Response, "arkade"),
            ).not.toThrow();
        }
    });
});

describe("toProviderUnavailable", () => {
    it("maps a transport FetchError to a typed unavailable error with kind + cause", () => {
        const fe = new FetchError("net", { url: "u" });
        const mapped = toProviderUnavailable(fe, "indexer");
        expect(mapped).toBeInstanceOf(ProviderUnavailableError);
        expect((mapped as ProviderUnavailableError).kind).toBe("indexer");
        expect((mapped as ProviderUnavailableError).cause).toBe(fe);
    });

    it("returns non-transport (terminal) errors unchanged", () => {
        const terminal = new Error("bad request");
        expect(toProviderUnavailable(terminal, "arkade")).toBe(terminal);
    });
});

describe("RestIndexerProvider availability classification", () => {
    beforeEach(() => mockFetch.mockReset());
    const provider = () => new RestIndexerProvider("http://localhost:7070");

    it("maps a 503 response to ProviderUnavailableError(indexer)", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 503,
            statusText: "Service Unavailable",
        });
        await expect(provider().getVtxos({ scripts: ["s"] })).rejects.toMatchObject({
            name: "ProviderUnavailableError",
            kind: "indexer",
        });
    });

    it("maps a transport failure to ProviderUnavailableError(indexer)", async () => {
        mockFetch.mockRejectedValueOnce(new FetchError("down", { url: "u" }));
        await expect(provider().getVtxos({ scripts: ["s"] })).rejects.toBeInstanceOf(
            ProviderUnavailableError,
        );
    });

    it("leaves a 404 as a terminal plain Error (not unavailable)", async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: "Not Found" });
        const err = await provider()
            .getVtxos({ scripts: ["s"] })
            .catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(ProviderUnavailableError);
        expect(err.message).toMatch(/Failed to fetch vtxos/);
    });
});

describe("RestArkProvider availability classification", () => {
    beforeEach(() => mockFetch.mockReset());
    const provider = () => new RestArkProvider("http://localhost:7070");

    it("getInfo maps a 503 to ProviderUnavailableError(arkade)", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 503,
            statusText: "Service Unavailable",
            text: async () => "",
        });
        await expect(provider().getInfo()).rejects.toMatchObject({
            name: "ProviderUnavailableError",
            kind: "arkade",
        });
    });

    it("cooperative submitTx maps a transport failure to ProviderUnavailableError(arkade)", async () => {
        mockFetch.mockRejectedValueOnce(new FetchError("down", { url: "u" }));
        await expect(provider().submitTx("tx", [])).rejects.toBeInstanceOf(
            ProviderUnavailableError,
        );
    });

    it("cooperative submitTx maps a 503 to ProviderUnavailableError(arkade)", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 503,
            statusText: "Service Unavailable",
        });
        await expect(provider().submitTx("tx", [])).rejects.toMatchObject({
            name: "ProviderUnavailableError",
            kind: "arkade",
        });
    });
});
