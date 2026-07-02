import { BucketSyncClient } from "../protocol/client";
import type { SchnorrSigner } from "../protocol/auth";
import { BucketSync, type BucketSyncOptions } from "./bucketSync";
import type { SyncSource } from "./sources";

export interface WalletSyncOptions extends BucketSyncOptions {
    /** Base URL of the bucket-sync server. */
    baseUrl: string;
    /** The wallet identity (an Arkade `Identity` satisfies this) used for schnorr auth. */
    identity: SchnorrSigner;
    /** 32-byte key-wrapping key for `cse-v1` — derive from the seed via `deriveKwk`. */
    encryptionKey: Uint8Array;
    /** The state slices to sync (e.g. `new ContractSource(repo)`). */
    sources: SyncSource[];
    /** Injectable fetch (defaults to global). */
    fetch?: typeof fetch;
    /** Device label recorded with the session. */
    device?: string;
}

/**
 * High-level backup / restore / live-sync for a set of {@link SyncSource}s. Wraps
 * an authenticated {@link BucketSyncClient} + the {@link BucketSync} engine.
 *
 * All engine operations are serialized through an internal promise chain, so
 * concurrent callers (e.g. a background `start()` loop plus a repository
 * wrapper's fire-and-forget pushes) can never interleave and corrupt the shared
 * version map / cursor.
 */
export class WalletSync {
    private chain: Promise<unknown> = Promise.resolve();

    private constructor(
        readonly client: BucketSyncClient,
        private readonly engine: BucketSync,
        private readonly sources: SyncSource[],
    ) {}

    /** Authenticate and build a ready-to-use sync handle. */
    static async create(opts: WalletSyncOptions): Promise<WalletSync> {
        const client = new BucketSyncClient({
            baseUrl: opts.baseUrl,
            fetch: opts.fetch,
            device: opts.device,
        });
        await client.authenticate(opts.identity);
        const engine = new BucketSync(client, opts.encryptionKey, opts);
        return new WalletSync(client, engine, opts.sources);
    }

    /** Push a full snapshot of every source to the server (initial or manual backup). */
    async backup(): Promise<void> {
        return this.serialize(async () => {
            const records = new Map<string, Uint8Array | null>();
            for (const source of this.sources) {
                for (const [key, value] of await source.snapshot()) records.set(key, value);
            }
            if (records.size > 0) await this.engine.put(records);
        });
    }

    /** Pull the whole bucket and apply it to the local sources (fresh-device restore). */
    async restore(): Promise<number> {
        return this.serialize(() => this.engine.pullAll((key, pt) => this.dispatch(key, pt)));
    }

    /** Pull remote changes since the last cursor and apply them (incremental catch-up). */
    async sync(): Promise<number> {
        return this.serialize(() => this.engine.pull((key, pt) => this.dispatch(key, pt)));
    }

    /** Push specific records (used by the repository wrappers after a local write). */
    async push(records: Map<string, Uint8Array | null>): Promise<void> {
        return this.serialize(() => this.engine.put(records));
    }

    /**
     * Catch up, then live-tail: on each server SSE event, pull and apply. Resolves
     * when `signal` aborts or the stream closes. Errors from an individual sync
     * pass propagate (wrap in try/catch at the call site for a resilient loop).
     */
    async start(signal?: AbortSignal): Promise<void> {
        await this.sync();
        for await (const _seq of this.client.stream(this.engine.cursorSeq, signal)) {
            await this.sync();
        }
    }

    private async dispatch(key: string, plaintext: Uint8Array | null): Promise<void> {
        for (const source of this.sources) {
            if (source.owns(key)) {
                await source.apply(key, plaintext);
                return;
            }
        }
        // Unknown namespace (e.g. written by a newer client): ignore for forward-compat.
    }

    /** Serialize engine access: each op waits for the previous to settle. */
    private serialize<T>(op: () => Promise<T>): Promise<T> {
        const run = this.chain.then(op, op);
        this.chain = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }
}
