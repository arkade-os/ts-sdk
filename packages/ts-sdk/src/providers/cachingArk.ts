import { TreeNonces, TreePartialSigs } from "../tree/signingSession";
import { Intent } from "../intent";
import {
    ArkadeInfo,
    ArkProvider,
    PendingTx,
    SettlementEvent,
    SignedIntent,
    TxNotificationEvent,
} from "./ark";

const DEFAULT_TTL_MS = 60_000;

type ServerInfoEventSource = Partial<{
    onServerInfoChanged(listener: (info: ArkadeInfo) => void): () => void;
}>;

/**
 * Decorates an {@link ArkProvider}, caching {@link ArkProvider.getInfo} for
 * `ttlMs` (default 60s). Other provider methods pass through.
 * Expired-cache refresh failures propagate; persisted wallet boot fallback
 * lives in `arkInfoSnapshot`.
 */
export class CachingArkProvider implements ArkProvider {
    private cached?: ArkadeInfo;
    private expiresAt = 0;
    private inflight?: Promise<ArkadeInfo>;
    /** Bumped on every event-driven cache write; see {@link getInfo}. */
    private generation = 0;
    private readonly unsubscribe: () => void;

    constructor(
        private readonly inner: ArkProvider,
        private readonly ttlMs: number = DEFAULT_TTL_MS,
    ) {
        this.unsubscribe =
            (inner as ServerInfoEventSource).onServerInfoChanged?.((info) => {
                this.cached = info;
                this.expiresAt = Date.now() + this.ttlMs;
                this.generation++;
            }) ?? (() => {});
    }

    /** Releases the inner provider's server-info subscription. */
    dispose(): void {
        this.unsubscribe();
    }

    get serverUrl(): string | undefined {
        const url = (this.inner as { serverUrl?: unknown }).serverUrl;
        return typeof url === "string" ? url : undefined;
    }

    async getInfo(): Promise<ArkadeInfo> {
        if (this.cached && Date.now() < this.expiresAt) return this.cached;
        if (!this.inflight) {
            // A rotation event can land while this request is in flight, making
            // its result the older of the two. Writing it back would serve the
            // superseded signer for a full TTL, so a bumped generation discards
            // the response in favour of what the event already cached.
            const generation = this.generation;
            this.inflight = this.inner
                .getInfo()
                .then((info) => {
                    if (this.generation !== generation) return this.cached ?? info;
                    this.cached = info;
                    this.expiresAt = Date.now() + this.ttlMs;
                    return info;
                })
                .finally(() => {
                    this.inflight = undefined;
                });
        }
        return this.inflight;
    }

    submitTx(signedArkTx: string, checkpointTxs: string[]) {
        return this.inner.submitTx(signedArkTx, checkpointTxs);
    }

    finalizeTx(arkTxid: string, finalCheckpointTxs: string[]) {
        return this.inner.finalizeTx(arkTxid, finalCheckpointTxs);
    }

    registerIntent(intent: SignedIntent<Intent.RegisterMessage>) {
        return this.inner.registerIntent(intent);
    }

    deleteIntent(intent: SignedIntent<Intent.DeleteMessage>) {
        return this.inner.deleteIntent(intent);
    }

    confirmRegistration(intentId: string) {
        return this.inner.confirmRegistration(intentId);
    }

    submitTreeNonces(batchId: string, pubkey: string, nonces: TreeNonces) {
        return this.inner.submitTreeNonces(batchId, pubkey, nonces);
    }

    submitTreeSignatures(batchId: string, pubkey: string, signatures: TreePartialSigs) {
        return this.inner.submitTreeSignatures(batchId, pubkey, signatures);
    }

    submitSignedForfeitTxs(signedForfeitTxs: string[], signedCommitmentTx?: string) {
        return this.inner.submitSignedForfeitTxs(signedForfeitTxs, signedCommitmentTx);
    }

    getEventStream(signal: AbortSignal, topics: string[]): AsyncIterableIterator<SettlementEvent> {
        return this.inner.getEventStream(signal, topics);
    }

    getTransactionsStream(signal: AbortSignal): AsyncIterableIterator<TxNotificationEvent> {
        return this.inner.getTransactionsStream(signal);
    }

    getPendingTxs(intent: SignedIntent<Intent.GetPendingTxMessage>): Promise<PendingTx[]> {
        return this.inner.getPendingTxs(intent);
    }

    onServerInfoChanged(listener: (info: ArkadeInfo) => void): () => void {
        return (this.inner as ServerInfoEventSource).onServerInfoChanged?.(listener) ?? (() => {});
    }
}
