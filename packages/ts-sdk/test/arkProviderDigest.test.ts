import { describe, it, expect, vi, afterEach } from "vitest";
import { RestArkProvider, DigestMismatchError } from "../src/providers/ark";

const SIGNER = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

/** A 200 /v1/info response advertising the given digest. */
function okInfo(digest: string) {
    return { ok: true, json: async () => ({ signerPubkey: SIGNER, digest }) };
}

/** A 200 /v1/tx/submit response. */
function okSubmit() {
    return {
        ok: true,
        json: async () => ({ arkTxid: "a", finalArkTx: "f", signedCheckpointTxs: [] }),
    };
}

/** A rejected non-/info response whose body carries the given marker. */
function errBody(marker: string) {
    const body = `{"message":"${marker}"}`;
    return { ok: false, clone: () => ({ text: async () => body }), text: async () => body };
}

afterEach(() => vi.unstubAllGlobals());

describe("RestArkProvider server-info digest negotiation", () => {
    it("getInfo caches the server digest", async () => {
        const provider = new RestArkProvider("http://ark.test");
        vi.stubGlobal("fetch", vi.fn(okInfoFetch("dX")));

        await provider.getInfo();

        expect((provider as unknown as { _digest: string })._digest).toBe("dX");
    });

    it("sends the cached X-Digest header on outgoing requests", async () => {
        const provider = new RestArkProvider("http://ark.test");
        // Capture the header VALUE at call time (decoupled from any object
        // reference) so the assertion can't be perturbed by later mutation.
        let sentXDigest: string | undefined;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init?: RequestInit) => {
                if (url.includes("/info")) return okInfo("d2");
                sentXDigest = (init?.headers as Record<string, string> | undefined)?.["X-Digest"];
                return okSubmit();
            }),
        );

        await provider.getInfo(); // caches digest "d2"
        // Pinpoint: confirm the cache is seeded right before the request, so a
        // failure here vs. on `sentXDigest` localizes seed-vs-send.
        expect((provider as unknown as { _digest: string })._digest).toBe("d2");

        await provider.submitTx("rawtx", []); // routed through authedFetch

        expect(sentXDigest).toBe("d2");
    });

    it("on DIGEST_MISMATCH refreshes + emits onServerInfoChanged + throws (no silent retry)", async () => {
        const provider = new RestArkProvider("http://ark.test");
        let submitAttempts = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (url.includes("/info")) return okInfo("d3");
                submitAttempts++;
                return errBody("DIGEST_MISMATCH");
            }),
        );
        await provider.getInfo();

        const seen: { signerPubkey: string }[] = [];
        provider.onServerInfoChanged((info) => seen.push(info));

        // Mirrors NArk #131: the SDK throws rather than silently retrying a
        // request that was built against the now-stale server config.
        await expect(provider.submitTx("rawtx", [])).rejects.toBeInstanceOf(DigestMismatchError);

        // Detection fired (refreshed info emitted once) and there was no retry.
        expect(seen).toHaveLength(1);
        expect(seen[0].signerPubkey).toBe(SIGNER);
        expect(submitAttempts).toBe(1);
    });

    it("does not emit or retry when a non-digest error comes back", async () => {
        const provider = new RestArkProvider("http://ark.test");
        let submitAttempts = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (url.includes("/info")) return okInfo("d2");
                submitAttempts++;
                return errBody("SOMETHING_ELSE");
            }),
        );
        await provider.getInfo();

        const seen: unknown[] = [];
        provider.onServerInfoChanged((info) => seen.push(info));

        await expect(provider.submitTx("rawtx", [])).rejects.toThrow();
        expect(seen).toHaveLength(0);
        expect(submitAttempts).toBe(1);
    });
});

/** A fetch impl that always answers /v1/info with the given digest. */
function okInfoFetch(digest: string) {
    return async () => okInfo(digest);
}
