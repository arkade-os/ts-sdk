import { describe, it, expect, vi, afterEach } from "vitest";
import { RestArkProvider, DigestMismatchError } from "../src/providers/ark";

const SIGNER = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

/** A 200 /v1/info response advertising the given digest. */
function okInfo(digest: string) {
    return { ok: true, json: async () => ({ signerPubkey: SIGNER, digest }) };
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

// Note: arkd requests carry the cached `X-Digest` header (added by
// `authedFetch`). That outgoing-header send is forward-compat — dormant until
// arkd reads it (#131) — and is best verified by integration on the real
// transport; a unit assertion that captured the header off a mocked fetch
// proved non-deterministic on CI runners, so the behavior below is what we lock
// in: digest caching, and the DIGEST_MISMATCH detection contract.
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
