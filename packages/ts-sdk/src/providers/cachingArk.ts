import { TreeNonces, TreePartialSigs } from "../tree/signingSession";
import { Intent } from "../intent";
import {
    ArkInfo,
    ArkProvider,
    PendingTx,
    SettlementEvent,
    SignedIntent,
    TxNotification,
} from "./ark";

const DEFAULT_TTL_MS = 60_000;

type ServerInfoEventSource = Partial<{
    onServerInfoChanged(listener: (info: ArkInfo) => void): () => void;
}>;

/**
 * Decorates an {@link ArkProvider}, caching {@link ArkProvider.getInfo} for
 * `ttlMs` (default 60s). Every other method passes straight through. The
 * cache is refreshed instantly on signer rotation via the inner provider's
 * `onServerInfoChanged`, if it has one — mirrors NArk's
 * `CachingClientTransport` (dotnet-sdk).
 *
 * Rotation *detection* is the inner provider's job on both paths, including the
 * one this decorator introduces: `RestArkProvider.getInfo` emits when a refresh
 * returns a changed digest, so a rotation first observed by a TTL-expiry
 * refetch still reaches subscribers. A custom inner provider without
 * `onServerInfoChanged` caches fine but cannot report rotations — the same
 * limitation it has undecorated.
 */
export class CachingArkProvider implements ArkProvider {
    private cached?: ArkInfo;
    private expiresAt = 0;
    private inflight?: Promise<ArkInfo>;

    constructor(
        private readonly inner: ArkProvider,
        private readonly ttlMs: number = DEFAULT_TTL_MS,
    ) {
        (inner as ServerInfoEventSource).onServerInfoChanged?.((info) => {
            this.cached = info;
            this.expiresAt = Date.now() + this.ttlMs;
        });
    }

    /**
     * The inner provider's server URL, when it exposes one. `ArkProvider` does
     * not declare a URL accessor, so consumers read it structurally — wallet
     * setup does, via `extractArkProviderUrl`, to derive the indexer URL when
     * `indexerUrl` is not configured. Without this delegation, decorating a
     * provider would make `Wallet.create` throw for want of an indexer URL.
     */
    get serverUrl(): string | undefined {
        const url = (this.inner as { serverUrl?: unknown }).serverUrl;
        return typeof url === "string" ? url : undefined;
    }

    async getInfo(): Promise<ArkInfo> {
        if (this.cached && Date.now() < this.expiresAt) return this.cached;
        if (!this.inflight) {
            this.inflight = this.inner
                .getInfo()
                .then((info) => {
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

    getTransactionsStream(signal: AbortSignal): AsyncIterableIterator<{
        commitmentTx?: TxNotification;
        arkTx?: TxNotification;
    }> {
        return this.inner.getTransactionsStream(signal);
    }

    getPendingTxs(intent: SignedIntent<Intent.GetPendingTxMessage>): Promise<PendingTx[]> {
        return this.inner.getPendingTxs(intent);
    }

    onServerInfoChanged(listener: (info: ArkInfo) => void): () => void {
        return (this.inner as ServerInfoEventSource).onServerInfoChanged?.(listener) ?? (() => {});
    }
}
