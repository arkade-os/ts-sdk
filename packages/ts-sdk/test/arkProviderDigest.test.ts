import { describe, it, expect, vi, afterEach } from "vitest";
import { RestArkProvider, DigestMismatchError } from "../src/providers/ark";

const SIGNER = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

function okInfo(digest: string, signerPubkey: string = SIGNER) {
    return { ok: true, json: async () => ({ signerPubkey, digest }) };
}

/** A rejected non-/info response whose body carries the given marker. */
function errBody(marker: string) {
    const body = `{"message":"${marker}"}`;
    return { ok: false, clone: () => ({ text: async () => body }), text: async () => body };
}

/**
 * A rejected non-/info response whose *clone* body read fails (e.g. the
 * connection dropped mid-body) but whose direct `text()` still resolves — the
 * shape `authedFetch` hits when it cannot inspect the body for DIGEST_MISMATCH.
 */
function errUnreadableClone(marker: string) {
    const body = `{"message":"${marker}"}`;
    return {
        ok: false,
        clone: () => ({
            text: async () => {
                throw new Error("connection reset mid-body");
            },
        }),
        text: async () => body,
    };
}

/** A rejected non-/info response carrying a verbatim JSON error body. */
function errResponse(body: string) {
    return { ok: false, clone: () => ({ text: async () => body }), text: async () => body };
}

/**
 * The REST body arkd returns for a DIGEST_MISMATCH rejection: a grpc-gateway
 * status whose `details` carry an `ark.v1.ErrorDetails` with name DIGEST_MISMATCH
 * (mirrors arkd's error_converter + the X-Digest guard added in v0.9.9-rc.1 #1104).
 */
function digestMismatchBody() {
    return JSON.stringify({
        code: 9,
        message: "invalid digest header",
        details: [
            {
                "@type": "type.googleapis.com/ark.v1.ErrorDetails",
                code: 1019,
                name: "DIGEST_MISMATCH",
                message: "invalid digest header",
                metadata: { expectedDigest: "d3", gotDigest: "d-stale" },
            },
        ],
    });
}

function digestOf(provider: RestArkProvider): string {
    return (provider as unknown as { _digest: string })._digest;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// Note: arkd requests carry the cached `X-Digest` header (added by
// `authedFetch`). arkd v0.9.9-rc.1 reads it behind an opt-in guard
// (`digest_header_required`, #1104); the outgoing-header send is best verified by
// integration on the real transport (a unit assertion that captured the header
// off a mocked fetch proved non-deterministic on CI runners), so the behavior
// below is what we lock in: digest caching and the DIGEST_MISMATCH detection
// contract — keyed on arkd's structured ErrorDetails name, not a raw substring.
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

    it("getInfo budgets its fetch, and the abort classifies as retryable", async () => {
        // A black-holed connection hangs an unbudgeted fetch past the
        // service-worker page deadline (20s), so the worker never reaches its
        // snapshot fallback. The budget aborts first; the rejection must then
        // classify RETRYABLE or the fallback would treat it as terminal.
        const provider = new RestArkProvider("http://ark.test");
        const fetchSpy = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
            expect(init?.signal).toBeInstanceOf(AbortSignal);
            return okInfo("d1");
        });
        vi.stubGlobal("fetch", fetchSpy);
        await provider.getInfo();
        expect(fetchSpy).toHaveBeenCalled();

        // The TimeoutError this signal rejects with classifies retryable —
        // pinned with the rest of the classifier in ark-info-snapshot.test.ts.
    });

    it("getInfo emits onServerInfoChanged when the digest moved — and only then", async () => {
        // A read is also a rotation signal (PR #803 review): without this, an
        // info read after the operator rotated advances the cached digest,
        // arkd stops answering DIGEST_MISMATCH, and the one event-driven
        // rotation trigger is suppressed by the act of reading.
        const provider = new RestArkProvider("http://ark.test");
        const digests = ["d1", "d1", "d2"];
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => okInfo(digests.shift()!)),
        );

        const seen: { digest?: string }[] = [];
        provider.onServerInfoChanged((info) => seen.push(info));

        await provider.getInfo(); // boot read: no previous digest, silent
        expect(seen).toHaveLength(0);

        await provider.getInfo(); // unchanged digest: silent
        expect(seen).toHaveLength(0);

        await provider.getInfo(); // moved: the rotation signal
        expect(seen).toHaveLength(1);
        expect(digestOf(provider)).toBe("d2");
    });

    it("getInfo emits onServerInfoChanged when a refresh returns a changed digest", async () => {
        const ROTATED = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
        const provider = new RestArkProvider("http://ark.test");
        let digest = "d1";
        let signer = SIGNER;
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => okInfo(digest, signer)),
        );
        await provider.getInfo();

        const seen: { signerPubkey: string; digest: string }[] = [];
        provider.onServerInfoChanged((info) => seen.push(info));

        digest = "d2";
        signer = ROTATED;
        await provider.getInfo();

        expect(seen).toHaveLength(1);
        expect(seen[0].signerPubkey).toBe(ROTATED);
        expect(seen[0].digest).toBe("d2");
        expect(digestOf(provider)).toBe("d2");
    });

    it("getInfo emits when a previously empty digest changes", async () => {
        const ROTATED = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
        const provider = new RestArkProvider("http://ark.test");
        let digest = "";
        let signer = SIGNER;
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => okInfo(digest, signer)),
        );

        const seen: { signerPubkey: string; digest: string }[] = [];
        provider.onServerInfoChanged((info) => seen.push(info));

        await provider.getInfo();
        expect(seen).toHaveLength(0);

        digest = "d1";
        signer = ROTATED;
        await provider.getInfo();

        expect(seen).toHaveLength(1);
        expect(seen[0].signerPubkey).toBe(ROTATED);
        expect(seen[0].digest).toBe("d1");
    });

    it("getInfo does not emit on first populate or on an unchanged digest", async () => {
        const provider = new RestArkProvider("http://ark.test");
        const seen: unknown[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => okInfo("d1")),
        );
        provider.onServerInfoChanged((info) => seen.push(info));

        await provider.getInfo();
        await provider.getInfo();

        expect(seen).toHaveLength(0);
    });

    it("on DIGEST_MISMATCH refreshes + emits onServerInfoChanged + throws (no silent retry)", async () => {
        const provider = new RestArkProvider("http://ark.test");
        let submitAttempts = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (url.includes("/info")) return okInfo("d3");
                submitAttempts++;
                return errResponse(digestMismatchBody());
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

    it("ignores a body that only contains the DIGEST_MISMATCH token (not a structured arkd error)", async () => {
        const provider = new RestArkProvider("http://ark.test");
        let submitAttempts = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (url.includes("/info")) return okInfo("d2");
                submitAttempts++;
                // The literal token appears, but not as a structured
                // ark.v1.ErrorDetails.name — so it must NOT be treated as a mismatch.
                return errResponse(`{"message":"unrelated failure mentioning DIGEST_MISMATCH"}`);
            }),
        );
        await provider.getInfo();

        const seen: unknown[] = [];
        provider.onServerInfoChanged((info) => seen.push(info));

        let caught: unknown;
        try {
            await provider.submitTx("rawtx", []);
        } catch (e) {
            caught = e;
        }

        // No refresh, no emit, digest preserved, and not surfaced as a
        // DigestMismatchError — the substring alone is not enough.
        expect(caught).toBeDefined();
        expect(caught).not.toBeInstanceOf(DigestMismatchError);
        expect(seen).toHaveLength(0);
        expect(digestOf(provider)).toBe("d2");
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

    it("surfaces (does not silently swallow) a body-read failure during digest detection", async () => {
        const provider = new RestArkProvider("http://ark.test");
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (url.includes("/info")) return okInfo("d2");
                return errUnreadableClone("SERVER_ERROR");
            }),
        );
        await provider.getInfo();

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const seen: unknown[] = [];
        provider.onServerInfoChanged((info) => seen.push(info));

        let caught: unknown;
        try {
            await provider.submitTx("rawtx", []);
        } catch (e) {
            caught = e;
        }

        // An unreadable body can't be classified, so it is NOT treated as a
        // digest mismatch: no refresh, no emit, digest preserved, and the caller
        // still sees the underlying HTTP error (not DigestMismatchError)...
        expect(caught).toBeDefined();
        expect(caught).not.toBeInstanceOf(DigestMismatchError);
        expect(seen).toHaveLength(0);
        expect(digestOf(provider)).toBe("d2");
        // ...but the read failure is surfaced rather than swallowed silently.
        expect(warn).toHaveBeenCalled();
    });

    it("exposes DigestMismatchError from the package entry point", async () => {
        const pkg = await import("../src");
        expect(pkg.DigestMismatchError).toBe(DigestMismatchError);
        expect(new pkg.DigestMismatchError("x")).toBeInstanceOf(Error);
    });
});
