import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestEmulatorProvider } from "../src/providers/emulator";
import { FetchError } from "../src/utils/fetch";

describe("RestEmulatorProvider fetch boundary", () => {
    let seen: { url: string; init?: RequestInit }[] = [];
    const original = globalThis.fetch;

    const ok = () =>
        new Response(JSON.stringify({ signerPubkey: "ab", signedArkTx: "x" }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });

    beforeEach(() => {
        seen = [];
        globalThis.fetch = vi.fn(async (input: any, init?: RequestInit) => {
            seen.push({ url: String(input), init });
            return ok();
        }) as any;
    });

    afterEach(() => {
        globalThis.fetch = original;
        vi.restoreAllMocks();
    });

    it("routes the info read through the shared boundary, typing its transport failures", async () => {
        globalThis.fetch = vi.fn(async () => {
            throw new TypeError("Failed to fetch");
        }) as any;

        const err = await new RestEmulatorProvider("https://emulator.test")
            .getInfo()
            .catch((e) => e);

        expect(err).toBeInstanceOf(FetchError);
    });

    // The emulator is a distinct origin from arkd, so it must not receive the
    // Ark-server compatibility headers — `baseFetch` is the wrapper that omits
    // them, and swapping it for `fetch` would break preflight, not a test.
    it("sends no Arkade-specific headers to the emulator origin", async () => {
        await new RestEmulatorProvider("https://emulator.test").getInfo();

        const headers = new Headers(seen[0].init?.headers);
        expect(headers.get("X-Build-Version")).toBeNull();
        expect(headers.get("X-SDK-VERSION")).toBeNull();
    });

    it("leaves a submit on the global fetch — an aborted co-sign has an unknown outcome", async () => {
        globalThis.fetch = vi.fn(async () => {
            throw new TypeError("Failed to fetch");
        }) as any;

        const err = await new RestEmulatorProvider("https://emulator.test")
            .submitTx("arktx", ["cp"])
            .catch((e) => e);

        expect(err).not.toBeInstanceOf(FetchError);
        expect(err).toBeInstanceOf(TypeError);
    });
});
