import { describe, it, expect } from "vitest";
import { BucketSyncClient, BucketSyncAuthError, BucketSyncHttpError } from "../src/protocol/client";
import { authMessage, type SchnorrSigner } from "../src/protocol/auth";

// Fixed-output signer. Real signature verification is exercised in the e2e test
// against the actual server; here we only assert the client's request shaping.
const stubSigner: SchnorrSigner = {
    xOnlyPublicKey: async () => new Uint8Array(32).fill(0x07),
    signMessage: async () => new Uint8Array(64).fill(0x09),
};

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Route = (init?: RequestInit) => Response | Promise<Response>;

function mockFetch(routes: Record<string, Route>): typeof fetch {
    return (async (url: string | URL, init?: RequestInit) => {
        const path = new URL(url.toString()).pathname;
        const h = routes[path];
        if (!h) throw new Error(`no route for ${init?.method ?? "GET"} ${path}`);
        return h(init);
    }) as unknown as typeof fetch;
}

const nonce = (b: string) => b.repeat(32); // 64-hex
const authOk = (token = "tok"): Record<string, Route> => ({
    "/v1/auth/schnorr/challenge": () => json({ nonce: nonce("ab"), expiresAt: "" }),
    "/v1/auth/schnorr/register": () => json({ token, expiresAt: "" }),
});

async function authedClient(routes: Record<string, Route>): Promise<BucketSyncClient> {
    const client = new BucketSyncClient({
        baseUrl: "http://server",
        fetch: mockFetch({ ...authOk(), ...routes }),
    });
    await client.authenticate(stubSigner);
    return client;
}

describe("authMessage", () => {
    it("produces a 32-byte digest for a valid 64-hex nonce", () => {
        expect(authMessage(nonce("ab")).length).toBe(32);
    });
    it("throws for a wrong-length nonce", () => {
        expect(() => authMessage("abcd")).toThrow();
    });
    it("is deterministic and nonce-dependent", () => {
        expect(authMessage(nonce("11"))).toEqual(authMessage(nonce("11")));
        expect(authMessage(nonce("11"))).not.toEqual(authMessage(nonce("22")));
    });
});

describe("BucketSyncClient — auth handshake", () => {
    it("registers a new pubkey and stores the token", async () => {
        const seen: string[] = [];
        const client = new BucketSyncClient({
            baseUrl: "http://server",
            fetch: mockFetch({
                "/v1/auth/schnorr/challenge": () => {
                    seen.push("challenge");
                    return json({ nonce: nonce("ab"), expiresAt: "" });
                },
                "/v1/auth/schnorr/register": () => {
                    seen.push("register");
                    return json({ token: "tok-123", expiresAt: "" });
                },
            }),
        });
        await client.authenticate(stubSigner);
        expect(client.authenticated).toBe(true);
        expect(seen).toEqual(["challenge", "register"]);
    });

    it("falls back to verify when register returns 409", async () => {
        const client = new BucketSyncClient({
            baseUrl: "http://server",
            fetch: mockFetch({
                "/v1/auth/schnorr/challenge": () => json({ nonce: nonce("cd"), expiresAt: "" }),
                "/v1/auth/schnorr/register": () => new Response("", { status: 409 }),
                "/v1/auth/schnorr/verify": () => json({ token: "tok-verify", expiresAt: "" }),
            }),
        });
        await client.authenticate(stubSigner);
        expect(client.authenticated).toBe(true);
    });

    it("throws BucketSyncAuthError when both register and verify fail", async () => {
        const client = new BucketSyncClient({
            baseUrl: "http://server",
            fetch: mockFetch({
                "/v1/auth/schnorr/challenge": () => json({ nonce: nonce("ef"), expiresAt: "" }),
                "/v1/auth/schnorr/register": () => new Response("", { status: 401 }),
                "/v1/auth/schnorr/verify": () => new Response("", { status: 401 }),
            }),
        });
        await expect(client.authenticate(stubSigner)).rejects.toBeInstanceOf(BucketSyncAuthError);
    });

    it("sends the correct pubkey, computed signature, nonce and device", async () => {
        let body: Record<string, string> | undefined;
        const client = new BucketSyncClient({
            baseUrl: "http://server",
            device: "phone",
            fetch: mockFetch({
                "/v1/auth/schnorr/challenge": () => json({ nonce: nonce("12"), expiresAt: "" }),
                "/v1/auth/schnorr/register": (init) => {
                    body = JSON.parse(init!.body as string);
                    return json({ token: "t", expiresAt: "" });
                },
            }),
        });
        await client.authenticate(stubSigner);
        expect(body!.pubkey).toBe("07".repeat(32));
        expect(body!.signature).toBe("09".repeat(64));
        expect(body!.nonce).toBe(nonce("12"));
        expect(body!.device).toBe("phone");
    });
});

describe("BucketSyncClient — bucket verbs", () => {
    it("requires authentication before bucket calls", async () => {
        const client = new BucketSyncClient({ baseUrl: "http://server", fetch: mockFetch({}) });
        await expect(client.head()).rejects.toBeInstanceOf(BucketSyncAuthError);
    });

    it("attaches the bearer token to bucket calls", async () => {
        let auth: string | null = null;
        const client = await authedClient({
            "/v1/bucket/head": (init) => {
                auth = (init!.headers as Record<string, string>).authorization;
                return json({ currentSeq: 0, contentHash: "" });
            },
        });
        await client.head();
        expect(auth).toBe("Bearer tok");
    });

    it("returns a CommitResponse on 409 (conflict is not an exception)", async () => {
        const client = await authedClient({
            "/v1/bucket/commit": () =>
                json(
                    { committed: false, newSeq: 5, conflicts: [{ key: "k", currentVersion: 3 }] },
                    409,
                ),
        });
        const r = await client.commit([
            { key: "k", expectedVersion: 2, scheme: "cse-v1", value: "", delete: false },
        ]);
        expect(r.committed).toBe(false);
        expect(r.conflicts[0]).toEqual({ key: "k", currentVersion: 3 });
    });

    it("throws BucketSyncHttpError on a non-409 commit failure", async () => {
        const client = await authedClient({
            "/v1/bucket/commit": () => new Response("boom", { status: 500 }),
        });
        await expect(
            client.commit([
                { key: "k", expectedVersion: 0, scheme: "cse-v1", value: "", delete: false },
            ]),
        ).rejects.toBeInstanceOf(BucketSyncHttpError);
    });

    it("parses a diff page", async () => {
        const client = await authedClient({
            "/v1/bucket/diff": () =>
                json({
                    entries: [
                        {
                            key: "contract:abc",
                            version: 1,
                            seq: 1,
                            contentHash: "h",
                            scheme: "cse-v1",
                            deleted: false,
                            value: "dmFs",
                            updatedAt: "2026-01-01T00:00:00Z",
                        },
                    ],
                    nextSeq: 1,
                    hasMore: false,
                }),
        });
        const page = await client.diff(0);
        expect(page.entries).toHaveLength(1);
        expect(page.entries[0].key).toBe("contract:abc");
        expect(page.nextSeq).toBe(1);
    });
});

describe("BucketSyncClient — SSE stream", () => {
    const streamOf = (chunks: string[]): Response =>
        new Response(
            new ReadableStream({
                start(c) {
                    for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
                    c.close();
                },
            }),
            { status: 200 },
        );

    it("yields seqs parsed from complete SSE frames", async () => {
        const client = await authedClient({
            "/v1/bucket/stream": () => streamOf(["id: 1\ndata: 1\n\n", "id: 2\ndata: 2\n\n"]),
        });
        const seqs: number[] = [];
        for await (const s of client.stream()) seqs.push(s);
        expect(seqs).toEqual([1, 2]);
    });

    it("reassembles a frame split across chunk boundaries", async () => {
        const client = await authedClient({
            "/v1/bucket/stream": () => streamOf(["id: 1\nda", "ta: 1\n\nid: 2\ndata: 2\n\n"]),
        });
        const seqs: number[] = [];
        for await (const s of client.stream()) seqs.push(s);
        expect(seqs).toEqual([1, 2]);
    });

    it("sends Last-Event-ID when resuming", async () => {
        let hdr: string | undefined;
        const client = await authedClient({
            "/v1/bucket/stream": (init) => {
                hdr = (init!.headers as Record<string, string>)["Last-Event-ID"];
                return streamOf(["data: 7\n\n"]);
            },
        });
        const seqs: number[] = [];
        for await (const s of client.stream(5)) seqs.push(s);
        expect(hdr).toBe("5");
        expect(seqs).toEqual([7]);
    });
});
