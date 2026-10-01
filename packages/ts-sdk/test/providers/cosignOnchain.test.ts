import { afterEach, describe, expect, it, vi } from "vitest";
import {
    CachingArkProvider,
    OnchainCosignRejectedError,
    OnchainCosignUnsupportedError,
    RestArkProvider,
} from "../../src";

const okJson = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("RestArkProvider.cosignOnchainTx", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("posts the psbt and returns the txid", async () => {
        const fetchMock = vi.fn().mockResolvedValue(okJson({ txid: "ab".repeat(32) }));
        vi.stubGlobal("fetch", fetchMock);
        const txid = await new RestArkProvider("http://ark").cosignOnchainTx("cHNidP8=");
        expect(txid).toBe("ab".repeat(32));
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("http://ark/v1/tx/onchain/cosign");
        expect(JSON.parse(init.body)).toEqual({ tx: "cHNidP8=" });
    });

    it.each([404, 501])(
        "maps HTTP %i to OnchainCosignUnsupportedError and caches it",
        async (status) => {
            const fetchMock = vi.fn().mockResolvedValue(new Response("Not Found", { status }));
            vi.stubGlobal("fetch", fetchMock);
            const p = new RestArkProvider("http://ark");
            await expect(p.cosignOnchainTx("x")).rejects.toBeInstanceOf(
                OnchainCosignUnsupportedError,
            );
            await expect(p.cosignOnchainTx("x")).rejects.toBeInstanceOf(
                OnchainCosignUnsupportedError,
            );
            expect(fetchMock).toHaveBeenCalledTimes(1);
        },
    );

    it("maps a structured arkd rejection to OnchainCosignRejectedError", async () => {
        const body = { code: 3, message: "input exit path too close to maturity", details: [] };
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson(body, 400)));
        const err = await new RestArkProvider("http://ark").cosignOnchainTx("x").catch((e) => e);
        expect(err).toBeInstanceOf(OnchainCosignRejectedError);
        expect(err.serverMessage).toContain("too close to maturity");
    });

    it("CachingArkProvider forwards", async () => {
        const inner = { cosignOnchainTx: vi.fn().mockResolvedValue("t") } as any;
        expect(await new CachingArkProvider(inner).cosignOnchainTx("p")).toBe("t");
        expect(inner.cosignOnchainTx).toHaveBeenCalledWith("p");
    });
});
