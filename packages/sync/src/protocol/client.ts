import { hex } from "@scure/base";
import { authMessage, type SchnorrSigner } from "./auth";
import type {
    ChallengeResponse,
    CommitResponse,
    DiffResponse,
    ChangesResponse,
    EntriesResponse,
    EntryDto,
    HeadResponse,
    TokenResponse,
    WriteOpDto,
} from "./types";

export class BucketSyncAuthError extends Error {
    constructor(message = "authentication failed") {
        super(message);
        this.name = "BucketSyncAuthError";
    }
}

export class BucketSyncHttpError extends Error {
    constructor(
        readonly status: number,
        readonly body: string,
    ) {
        super(`bucket-sync HTTP ${status}: ${body}`);
        this.name = "BucketSyncHttpError";
    }
}

export interface BucketSyncClientOptions {
    /** Base URL of the bucket-sync server, e.g. `https://sync.example.com`. */
    baseUrl: string;
    /** Injectable fetch (defaults to the global). Supply one for Node < 18 or tests. */
    fetch?: typeof fetch;
    /** Optional device label recorded with the session (for lost-device revocation). */
    device?: string;
}

/**
 * Thin, faithful client for the bucket-sync REST/SSE protocol (v1). Handles the
 * schnorr challenge-response handshake and the bucket verbs. Values on the wire
 * are opaque base64 — this layer does no encryption (that is the sync engine).
 */
export class BucketSyncClient {
    private token: string | null = null;
    private readonly baseUrl: string;
    private readonly fetchImpl: typeof fetch;
    private readonly device?: string;

    constructor(opts: BucketSyncClientOptions) {
        this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
        const f = opts.fetch ?? globalThis.fetch;
        if (!f) throw new Error("no fetch implementation available; pass options.fetch");
        this.fetchImpl = f.bind(globalThis);
        this.device = opts.device;
    }

    /** True once a bearer token has been obtained. */
    get authenticated(): boolean {
        return this.token !== null;
    }

    /**
     * Authenticate with a schnorr identity. Tries `register` (which provisions a
     * bucket for a brand-new pubkey); if the pubkey already exists (409), falls
     * back to `verify`. On success the bearer token is stored for later calls.
     */
    async authenticate(signer: SchnorrSigner): Promise<void> {
        const pubkey = hex.encode(await signer.xOnlyPublicKey());
        this.token =
            (await this.attempt("register", pubkey, signer)) ??
            (await this.attempt("verify", pubkey, signer));
        if (!this.token) throw new BucketSyncAuthError("schnorr authentication failed");
    }

    private async attempt(
        verb: "register" | "verify",
        pubkey: string,
        signer: SchnorrSigner,
    ): Promise<string | null> {
        const challenge = await this.json<ChallengeResponse>(
            await this.fetchImpl(`${this.baseUrl}/v1/auth/schnorr/challenge`, { method: "POST" }),
        );
        const signature = await signer.signMessage(authMessage(challenge.nonce), "schnorr");
        const res = await this.fetchImpl(`${this.baseUrl}/v1/auth/schnorr/${verb}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                pubkey,
                nonce: challenge.nonce,
                signature: hex.encode(signature),
                device: this.device,
            }),
        });
        if (res.ok) return (await this.json<TokenResponse>(res)).token;
        return null;
    }

    /** Current bucket head: the sync cursor high-water mark and content hash. */
    async head(): Promise<HeadResponse> {
        return this.json<HeadResponse>(await this.authed("/v1/bucket/head"));
    }

    /** Batch-read entries by key. Missing keys are simply absent from the result. */
    async get(keys: string[]): Promise<EntryDto[]> {
        const res = await this.authed("/v1/bucket/get", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ keys }),
        });
        return (await this.json<EntriesResponse>(res)).entries;
    }

    /**
     * Atomic batch commit (CAS). Returns the `CommitResponse`; a CAS conflict is
     * `committed:false` with the offending keys (HTTP 409, not an exception).
     */
    async commit(ops: WriteOpDto[]): Promise<CommitResponse> {
        const res = await this.authed("/v1/bucket/commit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ops }),
        });
        // A CAS conflict is HTTP 409 with a CommitResponse body — parse it
        // directly rather than via json(), which rejects any non-2xx status.
        if (res.ok || res.status === 409) return (await res.json()) as CommitResponse;
        throw new BucketSyncHttpError(res.status, await res.text());
    }

    /** Catch-up page of changes since a seq cursor. `limit` is a max commit count. */
    async diff(since: number, limit?: number): Promise<DiffResponse> {
        const q = new URLSearchParams({ since: String(since) });
        if (limit != null) q.set("limit", String(limit));
        return this.json<DiffResponse>(await this.authed(`/v1/bucket/diff?${q}`));
    }

    /** Time-based audit page (approximate — not a sync cursor). */
    async changes(since: Date | string, limit?: number): Promise<ChangesResponse> {
        const iso = since instanceof Date ? since.toISOString() : since;
        const q = new URLSearchParams({ since: iso });
        if (limit != null) q.set("limit", String(limit));
        return this.json<ChangesResponse>(await this.authed(`/v1/bucket/changes?${q}`));
    }

    /**
     * Live tail via SSE. Yields each new `seq` the server publishes. `lastEventId`
     * resumes after a known cursor. Uses fetch (not EventSource) so the bearer
     * token rides in the Authorization header. Ends when `signal` aborts or the
     * connection closes.
     */
    async *stream(lastEventId?: number, signal?: AbortSignal): AsyncGenerator<number> {
        const headers: Record<string, string> = { ...this.bearer() };
        if (lastEventId != null) headers["Last-Event-ID"] = String(lastEventId);
        const res = await this.fetchImpl(`${this.baseUrl}/v1/bucket/stream`, { headers, signal });
        if (!res.ok || !res.body) throw new BucketSyncHttpError(res.status, await res.text());

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                let sep: number;
                // SSE frames are separated by a blank line; each carries `data: <seq>`.
                while ((sep = buf.indexOf("\n\n")) >= 0) {
                    const frame = buf.slice(0, sep);
                    buf = buf.slice(sep + 2);
                    const seq = parseSseData(frame);
                    if (seq != null) yield seq;
                }
            }
        } finally {
            reader.cancel().catch(() => {});
        }
    }

    /** Revoke the current session (lost-device kill). Clears the local token. */
    async revokeSession(): Promise<void> {
        if (!this.token) return;
        await this.authed("/v1/auth/session", { method: "DELETE" });
        this.token = null;
    }

    // ── internals ─────────────────────────────────────────────────────────

    private bearer(): Record<string, string> {
        if (!this.token)
            throw new BucketSyncAuthError("not authenticated; call authenticate() first");
        return { authorization: `Bearer ${this.token}` };
    }

    private async authed(path: string, init: RequestInit = {}): Promise<Response> {
        const headers = { ...(init.headers as Record<string, string>), ...this.bearer() };
        return this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    }

    private async json<T>(res: Response): Promise<T> {
        if (!res.ok) throw new BucketSyncHttpError(res.status, await res.text());
        return (await res.json()) as T;
    }
}

/** Parse the `data:` value out of one SSE frame; null if absent/non-numeric. */
function parseSseData(frame: string): number | null {
    for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) {
            const seq = Number(line.slice(5).trim());
            return Number.isFinite(seq) ? seq : null;
        }
    }
    return null;
}
