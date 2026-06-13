import { afterEach, describe, expect, it, vi } from "vitest";
import { EsploraProvider, RestIndexerProvider } from "../src";

afterEach(() => vi.unstubAllGlobals());

// X-Build-Version is an arkd-only compatibility header. The Esplora and indexer
// services run on different origins whose CORS preflight rejects unknown request
// headers, so these providers must use the header-less baseFetch (not the
// X-Build-Version-adding fetch wrapper).
describe("non-ark providers omit X-Build-Version (CORS)", () => {
    function captureHeaders(): Headers[] {
        const seen: Headers[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (_url: string, init?: RequestInit) => {
                seen.push(new Headers(init?.headers));
                return { ok: true, json: async () => [], text: async () => "[]" };
            }),
        );
        return seen;
    }

    it("EsploraProvider does not send X-Build-Version", async () => {
        const seen = captureHeaders();
        await new EsploraProvider("https://esplora.test").getCoins("addr").catch(() => undefined);
        expect(seen.length).toBeGreaterThan(0);
        expect(seen[0].has("X-Build-Version")).toBe(false);
    });

    it("RestIndexerProvider does not send X-Build-Version", async () => {
        const seen = captureHeaders();
        await new RestIndexerProvider("https://indexer.test")
            .getVtxoTree({ txid: "aa".repeat(32), vout: 0 })
            .catch(() => undefined);
        expect(seen.length).toBeGreaterThan(0);
        expect(seen[0].has("X-Build-Version")).toBe(false);
    });
});
