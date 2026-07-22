import { base64 } from "@scure/base";
import { CSE_V1_SCHEME, seal, open } from "../crypto/cseV1";
import type {
    CommitResponse,
    DiffResponse,
    EntryDto,
    HeadResponse,
    WriteOpDto,
} from "../protocol/types";

/**
 * The subset of {@link BucketSyncClient} the engine needs. Narrowed to an
 * interface so the CAS/cursor logic can be unit-tested against an in-memory
 * fake as well as the real HTTP client.
 */
export interface BucketApi {
    head(): Promise<HeadResponse>;
    get(keys: string[]): Promise<EntryDto[]>;
    commit(ops: WriteOpDto[]): Promise<CommitResponse>;
    diff(since: number, limit?: number): Promise<DiffResponse>;
}

/** Callback applied to each pulled record; `plaintext === null` is a tombstone (delete). */
export type ApplyFn = (key: string, plaintext: Uint8Array | null) => void | Promise<void>;

/** Decides the value to (re)commit for a key that conflicted with a concurrent remote write. */
export type ConflictResolver = (ctx: {
    key: string;
    local: Uint8Array | null;
    remote: Uint8Array | null;
    remoteVersion: number;
}) => Uint8Array | null | "skip";

/** Default resolver: the pushing device's value wins (overwrites the remote at its new version). */
export const localWins: ConflictResolver = (ctx) => ctx.local;

export class SyncConflictError extends Error {
    constructor(readonly keys: string[]) {
        super(`unresolved CAS conflict after retries: ${keys.join(", ")}`);
        this.name = "SyncConflictError";
    }
}

export interface BucketSyncOptions {
    /** Conflict policy on a CAS clash. Defaults to {@link localWins}. */
    resolver?: ConflictResolver;
    /** Max commit retries before giving up on a persistent conflict. Default 5. */
    maxRetries?: number;
    /** Diff page size (max commits per page). Default 500. */
    pageLimit?: number;
}

/**
 * The end-to-end-encrypted key-value sync core. Entity-agnostic: callers hand it
 * namespaced keys and plaintext bytes; it seals each value with `cse-v1`, drives
 * per-key optimistic CAS against the server, and tracks the per-key version map
 * and the per-bucket seq cursor so pushes and pulls stay consistent.
 *
 * Higher layers (contract/wallet-state sources, the repository wrappers) map
 * SDK entities to keys and plaintext and delegate the wire mechanics here.
 */
export class BucketSync {
    private readonly versions = new Map<string, number>();
    private cursor = 0;
    private readonly resolver: ConflictResolver;
    private readonly maxRetries: number;
    private readonly pageLimit: number;

    constructor(
        private readonly api: BucketApi,
        private readonly kwk: Uint8Array,
        opts: BucketSyncOptions = {},
    ) {
        this.resolver = opts.resolver ?? localWins;
        this.maxRetries = opts.maxRetries ?? 5;
        this.pageLimit = opts.pageLimit ?? 500;
    }

    /** The seq cursor this engine has caught up to. */
    get cursorSeq(): number {
        return this.cursor;
    }

    /** Last-known CAS version for a key (0 = never seen / absent). */
    knownVersion(key: string): number {
        return this.versions.get(key) ?? 0;
    }

    /**
     * Commit a set of records atomically (one batch = one seq). `null` value is a
     * delete (tombstone). On a CAS conflict, fetches the current remote value for
     * the conflicting keys, runs the resolver, and retries — up to `maxRetries`.
     */
    async put(records: Map<string, Uint8Array | null>): Promise<void> {
        if (records.size === 0) return;
        const desired = new Map(records);

        for (let attempt = 0; ; attempt++) {
            const res = await this.api.commit(this.buildOps(desired));
            if (res.committed) {
                for (const key of desired.keys())
                    this.versions.set(key, this.knownVersion(key) + 1);
                this.cursor = res.newSeq;
                return;
            }

            if (attempt >= this.maxRetries)
                throw new SyncConflictError(res.conflicts.map((c) => c.key));

            // Refresh our version map to the server's truth, pull the remote values,
            // and let the resolver decide what (if anything) to re-commit per key.
            for (const c of res.conflicts) this.versions.set(c.key, c.currentVersion);
            const remote = await this.fetchDecrypted(res.conflicts.map((c) => c.key));
            for (const c of res.conflicts) {
                const decision = this.resolver({
                    key: c.key,
                    local: desired.get(c.key) ?? null,
                    remote: remote.get(c.key) ?? null,
                    remoteVersion: c.currentVersion,
                });
                if (decision === "skip") desired.delete(c.key);
                else desired.set(c.key, decision);
            }
            if (desired.size === 0) return;
        }
    }

    /** Convenience: commit a single record. */
    async putOne(key: string, plaintext: Uint8Array | null): Promise<void> {
        return this.put(new Map([[key, plaintext]]));
    }

    /**
     * Apply every remote change since the current cursor to `apply`, advancing the
     * cursor and version map. Returns the number of entries applied. Paginated.
     */
    async pull(apply: ApplyFn): Promise<number> {
        let applied = 0;
        for (;;) {
            const page = await this.api.diff(this.cursor, this.pageLimit);
            for (const e of page.entries) {
                await apply(e.key, e.deleted ? null : open(base64.decode(e.value), this.kwk));
                this.versions.set(e.key, e.version);
                applied++;
            }
            this.cursor = page.nextSeq;
            if (!page.hasMore) return applied;
        }
    }

    /** Reset the cursor and replay the whole bucket into `apply` (restore / bootstrap). */
    async pullAll(apply: ApplyFn): Promise<number> {
        this.cursor = 0;
        this.versions.clear();
        return this.pull(apply);
    }

    private buildOps(values: Map<string, Uint8Array | null>): WriteOpDto[] {
        return [...values].map(([key, pt]) =>
            pt === null
                ? {
                      key,
                      expectedVersion: this.knownVersion(key),
                      scheme: CSE_V1_SCHEME,
                      value: "",
                      delete: true,
                  }
                : {
                      key,
                      expectedVersion: this.knownVersion(key),
                      scheme: CSE_V1_SCHEME,
                      value: base64.encode(seal(pt, this.kwk)),
                      delete: false,
                  },
        );
    }

    /** Fetch + decrypt the current server value for the given keys (null when absent/tombstoned). */
    private async fetchDecrypted(keys: string[]): Promise<Map<string, Uint8Array | null>> {
        const out = new Map<string, Uint8Array | null>();
        const entries = await this.api.get(keys);
        for (const e of entries) {
            out.set(e.key, e.deleted ? null : open(base64.decode(e.value), this.kwk));
            this.versions.set(e.key, e.version);
        }
        return out;
    }
}
