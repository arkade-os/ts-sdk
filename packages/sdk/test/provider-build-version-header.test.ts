import { afterEach, describe, expect, it, vi } from "vitest";
import { EsploraProvider, RestOperatorProvider, RestIndexerProvider } from "../src";
import { version as sdkVersion } from "../package.json";
import { jsonResponse } from "./helpers/response";

afterEach(() => vi.unstubAllGlobals());

function captureHeaders(json: () => any = async () => []): Headers[] {
    const seen: Headers[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
            seen.push(new Headers(init?.headers));
            return jsonResponse(await json());
        }),
    );
    return seen;
}

// Esplora and the indexer may run on origins whose CORS preflight rejects unknown
// request headers. X-Build-Version never leaves arkd; the indexer gets X-SDK-VERSION
// only where no preflight happens.
describe("non-ark providers omit arkd-only headers (CORS)", () => {
    it("EsploraProvider does not send X-Build-Version or X-SDK-VERSION", async () => {
        const seen = captureHeaders();
        await new EsploraProvider("https://esplora.test").getCoins("addr").catch(() => undefined);
        expect(seen.length).toBeGreaterThan(0);
        expect(seen[0].has("X-Build-Version")).toBe(false);
        expect(seen[0].has("X-SDK-VERSION")).toBe(false);
    });

    const indexerHeaders = async (): Promise<Headers> => {
        const seen = captureHeaders();
        await new RestIndexerProvider("https://indexer.test")
            .getVtxoTree({ txid: "aa".repeat(32), vout: 0 })
            .catch(() => undefined);
        expect(seen.length).toBeGreaterThan(0);
        return seen[0];
    };

    it("RestIndexerProvider identifies the SDK to the indexer outside a browser", async () => {
        const headers = await indexerHeaders();
        expect(headers.get("X-SDK-VERSION")).toBe(`ts-sdk/${sdkVersion}`);
        expect(headers.has("X-Build-Version")).toBe(false);
    });

    it("RestIndexerProvider sends no custom header from a page origin", async () => {
        vi.stubGlobal("location", { origin: "https://wallet.test" });
        const headers = await indexerHeaders();
        expect(headers.has("X-SDK-VERSION")).toBe(false);
        expect(headers.has("X-Build-Version")).toBe(false);
    });
});

// The Ark server is the one origin that accepts (and reads) these headers.
describe("RestOperatorProvider sends arkd compatibility headers", () => {
    it("sends X-SDK-VERSION carrying the package version", async () => {
        const seen = captureHeaders(async () => ({}));
        await new RestOperatorProvider("https://ark.test").getInfo().catch(() => undefined);
        expect(seen.length).toBeGreaterThan(0);
        expect(seen[0].get("X-Build-Version")).toBe("0.9.9");
        expect(seen[0].get("X-SDK-VERSION")).toBe(`ts-sdk/${sdkVersion}`);
    });
});
