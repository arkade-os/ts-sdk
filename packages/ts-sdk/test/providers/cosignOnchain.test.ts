import { afterEach, describe, expect, it, vi } from "vitest";
import {
    CachingArkProvider,
    FetchError,
    OnchainCosignAmbiguousError,
    OnchainCosignRejectedError,
    OnchainCosignUnsupportedError,
    RestArkProvider,
} from "../../src";

const okJson = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const arkErrorBody = (name: string, message: string, code = 3) => ({
    code,
    message,
    details: [{ "@type": "type.googleapis.com/ark.v1.ErrorDetails", code, name, message }],
});

const cosignWith = (response: Response | Error) => {
    const fetchMock =
        response instanceof Error
            ? vi.fn().mockRejectedValue(response)
            : vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const provider = new RestArkProvider("http://ark");
    return { fetchMock, provider, err: provider.cosignOnchainTx("x").catch((e) => e) };
};

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

    it("maps a structured arkd rejection to OnchainCosignRejectedError carrying its name", async () => {
        const { err } = cosignWith(okJson(arkErrorBody("INVALID_ARK_PSBT", "too close"), 400));
        const e = await err;
        expect(e).toBeInstanceOf(OnchainCosignRejectedError);
        expect(e.serverMessage).toBe("too close");
        expect(e.arkErrorName).toBe("INVALID_ARK_PSBT");
    });

    it("treats a structured NOT_FOUND as a rejection, not as unsupported", async () => {
        const { provider, fetchMock, err } = cosignWith(
            okJson(arkErrorBody("VTXO_NOT_FOUND", "no such vtxo", 30), 404),
        );
        expect(await err).toBeInstanceOf(OnchainCosignRejectedError);
        fetchMock.mockResolvedValue(okJson({ txid: "t" }));
        await expect(provider.cosignOnchainTx("x")).resolves.toBe("t");
    });

    it.each([
        [
            "a structured INTERNAL_ERROR",
            () => okJson(arkErrorBody("INTERNAL_ERROR", "retry", 0), 500),
        ],
        ["an unstructured 500", () => new Response("bad gateway", { status: 500 })],
        ["an unstructured 400", () => new Response("bad request", { status: 400 })],
        ["a FetchError", () => new FetchError("down", { url: "http://ark" })],
        ["a raw fetch rejection", () => new TypeError("network")],
    ])("maps %s to OnchainCosignAmbiguousError", async (_name, make) => {
        const { err } = cosignWith(make());
        expect(await err).toBeInstanceOf(OnchainCosignAmbiguousError);
    });

    it("CachingArkProvider forwards", async () => {
        const inner = { cosignOnchainTx: vi.fn().mockResolvedValue("t") } as any;
        expect(await new CachingArkProvider(inner).cosignOnchainTx!("p")).toBe("t");
        expect(inner.cosignOnchainTx).toHaveBeenCalledWith("p");
    });

    it("CachingArkProvider omits cosignOnchainTx when the inner provider lacks it", () => {
        expect(new CachingArkProvider({} as any).cosignOnchainTx).toBeUndefined();
    });
});
