import { afterEach, describe, expect, it, vi } from "vitest";
import { EsploraProvider, RestArkProvider, RestIndexerProvider } from "../src";
import { version as sdkVersion } from "../package.json";

afterEach(() => vi.unstubAllGlobals());

function captureHeaders(json: () => any = async () => []): Headers[] {
    const seen: Headers[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
            seen.push(new Headers(init?.headers));
            return { ok: true, json, text: async () => "[]" };
        }),
    );
    return seen;
}

// X-Build-Version and X-SDK-VERSION are arkd-only custom headers. The Esplora
// and indexer services run on different origins whose CORS preflight rejects
// unknown request headers, so these providers must use the header-less baseFetch
// (not the header-adding fetch wrapper).
describe("non-ark providers omit arkd-only headers (CORS)", () => {
    it("EsploraProvider does not send X-Build-Version or X-SDK-VERSION", async () => {
        const seen = captureHeaders();
        await new EsploraProvider("https://esplora.test").getCoins("addr").catch(() => undefined);
        expect(seen.length).toBeGreaterThan(0);
        expect(seen[0].has("X-Build-Version")).toBe(false);
        expect(seen[0].has("X-SDK-VERSION")).toBe(false);
    });

    it("RestIndexerProvider does not send X-Build-Version or X-SDK-VERSION", async () => {
        const seen = captureHeaders();
        await new RestIndexerProvider("https://indexer.test")
            .getVtxoTree({ txid: "aa".repeat(32), vout: 0 })
            .catch(() => undefined);
        expect(seen.length).toBeGreaterThan(0);
        expect(seen[0].has("X-Build-Version")).toBe(false);
        expect(seen[0].has("X-SDK-VERSION")).toBe(false);
    });
});

// The Ark server is the one origin that accepts (and reads) these headers.
describe("RestArkProvider sends arkd compatibility headers", () => {
    it("sends X-SDK-VERSION carrying the package version", async () => {
        const seen = captureHeaders(async () => ({}));
        await new RestArkProvider("https://ark.test").getInfo().catch(() => undefined);
        expect(seen.length).toBeGreaterThan(0);
        expect(seen[0].get("X-Build-Version")).toBe("0.9.9");
        expect(seen[0].get("X-SDK-VERSION")).toBe(`ts-sdk/${sdkVersion}`);
    });
});
