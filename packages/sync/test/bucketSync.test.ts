import { describe, it, expect } from "vitest";
import { BucketSync, SyncConflictError, type BucketApi } from "../src/sync/bucketSync";
import type {
    CommitResponse,
    DiffResponse,
    EntryDto,
    HeadResponse,
    WriteOpDto,
} from "../src/protocol/types";

/**
 * In-memory CAS bucket that mirrors the server's commit/diff semantics
 * (per InMemoryBucketStore in the bucket-sync-server repo): per-key version,
 * per-bucket seq, batch-atomic CAS, tombstones, seq-paged diff. Lets us test
 * the engine's logic precisely; the real server is exercised in the e2e test.
 */
class FakeBucket implements BucketApi {
    private entries = new Map<
        string,
        { version: number; seq: number; value: string; deleted: boolean }
    >();
    private seq = 0;

    async head(): Promise<HeadResponse> {
        return { currentSeq: this.seq, contentHash: "" };
    }

    async get(keys: string[]): Promise<EntryDto[]> {
        return keys.filter((k) => this.entries.has(k)).map((k) => this.toDto(k));
    }

    async commit(ops: WriteOpDto[]): Promise<CommitResponse> {
        const conflicts = ops
            .map((op) => ({ key: op.key, currentVersion: this.entries.get(op.key)?.version ?? 0 }))
            .filter((c, i) => ops[i].expectedVersion !== c.currentVersion);
        if (conflicts.length) return { committed: false, newSeq: this.seq, conflicts };

        const newSeq = ++this.seq;
        for (const op of ops) {
            const cur = this.entries.get(op.key)?.version ?? 0;
            this.entries.set(op.key, {
                version: cur + 1,
                seq: newSeq,
                value: op.delete ? "" : op.value,
                deleted: op.delete,
            });
        }
        return { committed: true, newSeq, conflicts: [] };
    }

    async diff(since: number, limit = 500): Promise<DiffResponse> {
        const all = [...this.entries.keys()]
            .map((k) => this.toDto(k))
            .filter((e) => e.seq > since)
            .sort((a, b) => a.seq - b.seq || a.key.localeCompare(b.key));
        if (all.length === 0) return { entries: [], nextSeq: since, hasMore: false };
        const seqs = [...new Set(all.map((e) => e.seq))].slice(0, limit);
        const cutoff = seqs[seqs.length - 1];
        return {
            entries: all.filter((e) => e.seq <= cutoff),
            nextSeq: cutoff,
            hasMore: all.some((e) => e.seq > cutoff),
        };
    }

    private toDto(key: string): EntryDto {
        const e = this.entries.get(key)!;
        return {
            key,
            version: e.version,
            seq: e.seq,
            contentHash: "",
            scheme: "cse-v1",
            deleted: e.deleted,
            value: e.value,
            updatedAt: "",
        };
    }
}

const kwk = () => crypto.getRandomValues(new Uint8Array(32));
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));

/** Collect a pull into a plain object for assertions. */
async function drain(sync: BucketSync): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    await sync.pullAll((key, pt) => {
        out[key] = dec(pt);
    });
    return out;
}

describe("BucketSync — encrypted KV round-trip", () => {
    it("seals on put and a second instance decrypts on pull (shared KWK)", async () => {
        const bucket = new FakeBucket();
        const key = kwk();
        const writer = new BucketSync(bucket, key);
        const reader = new BucketSync(bucket, key);

        await writer.put(new Map([["contract:abc", enc('{"type":"vhtlc"}')]]));
        expect(await drain(reader)).toEqual({ "contract:abc": '{"type":"vhtlc"}' });
    });

    it("does not leak plaintext to the wire (value is a cse-v1 envelope)", async () => {
        const bucket = new FakeBucket();
        const sync = new BucketSync(bucket, kwk());
        await sync.putOne("state:wallet", enc("SECRET-SETTINGS"));
        const [entry] = await bucket.get(["state:wallet"]);
        const wire = new TextDecoder().decode(
            Uint8Array.from(atob(entry.value), (c) => c.charCodeAt(0)),
        );
        expect(wire).not.toContain("SECRET-SETTINGS");
        expect(wire).toContain("cse-v1");
    });

    it("tracks per-key versions and the seq cursor across commits", async () => {
        const bucket = new FakeBucket();
        const sync = new BucketSync(bucket, kwk());
        await sync.putOne("k", enc("v1"));
        expect(sync.knownVersion("k")).toBe(1);
        expect(sync.cursorSeq).toBe(1);
        await sync.putOne("k", enc("v2"));
        expect(sync.knownVersion("k")).toBe(2);
        expect(sync.cursorSeq).toBe(2);
    });

    it("propagates tombstones (delete) to a pulling instance", async () => {
        const bucket = new FakeBucket();
        const key = kwk();
        const writer = new BucketSync(bucket, key);
        await writer.putOne("k", enc("hello"));
        await writer.putOne("k", null); // delete
        expect(await drain(new BucketSync(bucket, key))).toEqual({ k: null });
    });

    it("pull is incremental — a second pull with no changes applies nothing", async () => {
        const bucket = new FakeBucket();
        const key = kwk();
        const sync = new BucketSync(bucket, key);
        await sync.putOne("a", enc("1"));
        // our own commit advanced the cursor, so nothing new to pull
        expect(await sync.pull(() => {})).toBe(0);
        // a separate writer (same KWK so pull can decrypt) adds b; pull sees exactly one
        const other = new BucketSync(bucket, key);
        await other.putOne("b", enc("2"));
        expect(await sync.pull(() => {})).toBe(1);
    });
});

describe("BucketSync — CAS conflict resolution", () => {
    it("local-wins: a stale writer refreshes and overwrites the remote", async () => {
        const bucket = new FakeBucket();
        const key = kwk();
        const a = new BucketSync(bucket, key);
        await a.putOne("k", enc("from-A"));

        // b has never seen k (knownVersion 0) → its commit conflicts, then retries.
        const b = new BucketSync(bucket, key);
        await b.putOne("k", enc("from-B"));

        expect(await drain(new BucketSync(bucket, key))).toEqual({ k: "from-B" });
    });

    it("a 'skip' resolver leaves the remote value untouched", async () => {
        const bucket = new FakeBucket();
        const key = kwk();
        const a = new BucketSync(bucket, key);
        await a.putOne("k", enc("keep-A"));

        const b = new BucketSync(bucket, key, { resolver: () => "skip" });
        await b.putOne("k", enc("drop-B")); // conflicts, resolver skips → no-op

        expect(await drain(new BucketSync(bucket, key))).toEqual({ k: "keep-A" });
    });

    it("throws SyncConflictError when the conflict never clears", async () => {
        // A bucket stub in perpetual contention: every commit conflicts. With the
        // default local-wins resolver the engine keeps retrying, then gives up.
        let commits = 0;
        const contended: BucketApi = {
            head: async () => ({ currentSeq: 0, contentHash: "" }),
            get: async (keys) =>
                keys.map((k) => ({
                    key: k,
                    version: commits,
                    seq: commits,
                    contentHash: "",
                    scheme: "cse-v1",
                    deleted: true,
                    value: "",
                    updatedAt: "",
                })),
            commit: async () => {
                commits++;
                return {
                    committed: false,
                    newSeq: 0,
                    conflicts: [{ key: "k", currentVersion: commits }],
                };
            },
            diff: async () => ({ entries: [], nextSeq: 0, hasMore: false }),
        };
        const b = new BucketSync(contended, kwk(), { maxRetries: 2 });
        await expect(b.putOne("k", enc("v-b"))).rejects.toBeInstanceOf(SyncConflictError);
        expect(commits).toBe(3); // initial attempt + 2 retries
    });
});

describe("BucketSync — batch atomicity", () => {
    it("commits a multi-key batch at a single seq", async () => {
        const bucket = new FakeBucket();
        const key = kwk();
        const sync = new BucketSync(bucket, key);
        await sync.put(
            new Map([
                ["contract:a", enc("A")],
                ["contract:b", enc("B")],
                ["state:wallet", enc("S")],
            ]),
        );
        expect(sync.cursorSeq).toBe(1); // one batch = one seq
        expect(await drain(new BucketSync(bucket, key))).toEqual({
            "contract:a": "A",
            "contract:b": "B",
            "state:wallet": "S",
        });
    });
});
