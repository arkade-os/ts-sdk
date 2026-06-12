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

function digestOf(provider: RestArkProvider): string {
    return (provider as unknown as { _digest: string })._digest;
}

afterEach(() => vi.unstubAllGlobals());

describe("RestArkProvider server-info digest negotiation", () => {
    it("getInfo caches the server digest", async () => {
        const provider = new RestArkProvider("http://ark.test");
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => okInfo("dX")),
        );

        await provider.getInfo();

        expect(digestOf(provider)).toBe("dX");
    });

    it("sends the cached X-Digest header on outgoing requests", async () => {
        const provider = new RestArkProvider("http://ark.test");
        // Snapshot the provider's digest AND the header that actually went out, at
        // the moment the request is sent. Asserting the whole object means a CI
        // failure message reveals the real state (digest set? header attached?).
        let snapshot: { digestAtSend: string; xDigest: string | undefined } | undefined;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init?: RequestInit) => {
                if (url.includes("/info")) return okInfo("d2");
                snapshot = {
                    digestAtSend: digestOf(provider),
                    xDigest: (init?.headers as Record<string, string> | undefined)?.["X-Digest"],
                };
                return okSubmit();
            }),
        );

        await provider.getInfo(); // caches digest "d2"
        await provider.submitTx("rawtx", []); // routed through authedFetch

        expect(snapshot).toEqual({ digestAtSend: "d2", xDigest: "d2" });
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
