import { BucketSyncClient } from "../protocol/client";
import type { SchnorrSigner } from "../protocol/auth";
import { BucketSync, type BucketSyncOptions } from "./bucketSync";
import type { SyncSource } from "./sources";

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);

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
     * Catch up, then re-push anything the server is missing or disagrees with, and
     * report how many records were repaired.
     *
     * The pull path cannot fix this on its own: it only applies remote → local. A
     * push that never landed — the repository wrappers are fire-and-forget, so an
     * offline device or a crash between the local write and the push both do this —
     * leaves a record that exists nowhere but this device, and nothing would
     * otherwise notice. For a swap that record holds the preimage, which is the
     * difference between a claimable VHTLC and a Boltz refund timeout.
     *
     * Pulls first, deliberately: that way "the server disagrees" can only mean this
     * device is ahead. Diffing without pulling would let a reconcile push stale
     * local state over another device's newer write.
     *
     * Repairs missing and divergent records only. A delete whose push failed is NOT
     * detected — a record absent from the local snapshot is indistinguishable from
     * one that was never here — so a deleted record can survive on the server and
     * reappear on a later restore. That asymmetry is intentional: a resurrected
     * stale record is untidy, a missing preimage loses money.
     */
    async reconcile(): Promise<number> {
        await this.sync();
        return this.serialize(async () => {
            const local = new Map<string, Uint8Array>();
            for (const source of this.sources) {
                for (const [key, value] of await source.snapshot()) local.set(key, value);
            }
            if (local.size === 0) return 0;

            const remote = await this.engine.fetchDecrypted([...local.keys()]);
            const missing = new Map<string, Uint8Array | null>();
            for (const [key, value] of local) {
                const current = remote.get(key) ?? null;
                if (current === null || !sameBytes(current, value)) missing.set(key, value);
            }
            if (missing.size > 0) await this.engine.put(missing);
            return missing.size;
        });
    }

    /**
     * Catch up, then live-tail: on each server SSE event, pull and apply. Resolves
     * when `signal` aborts or the stream closes. Errors from an individual sync
     * pass propagate (wrap in try/catch at the call site for a resilient loop).
     *
     * The initial catch-up is a {@link reconcile}, so every long-running session
     * also repairs pushes that never landed.
     */
    async start(signal?: AbortSignal): Promise<void> {
        await this.reconcile();
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
