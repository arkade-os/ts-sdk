import { TxTreeNode } from "../tree/txTree";
import { TreeNonces, TreePartialSigs } from "../tree/signingSession";
import { hex } from "@scure/base";
import { Vtxo } from "./indexer";
import { eventSourceIterator, isEventSourceError } from "./utils";
import { maybeArkError } from "./errors";
import type { IntentFeeConfig } from "../arkfee";
import { Intent } from "../intent";
import { DEFAULT_ARKADE_SERVER_URL } from "../networks";
import { fetch } from "../utils/fetch";

/**
 * Thrown by {@link RestArkProvider} when arkd rejects a request with
 * `DIGEST_MISMATCH` — the client's cached server info was stale (e.g. an
 * operator signer rotation). By the time this surfaces the provider has already
 * refreshed its info and fired `onServerInfoChanged`; the caller should rebuild
 * the request under the fresh server info and retry. Mirrors NArk's
 * `DigestMismatchException` (dotnet-sdk #131): the SDK never silently retries.
 */
export class DigestMismatchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DigestMismatchError";
    }
}

/** Output requested during settlement or transaction submission. */
export type Output = {
    /** Destination address, either onchain or Arkade (offchain). */
    address: string;

    /** Amount to send in satoshis. */
    amount: bigint;
};

export enum SettlementEventType {
    BatchStarted = "batch_started",
    BatchFinalization = "batch_finalization",
    BatchFinalized = "batch_finalized",
    BatchFailed = "batch_failed",
    TreeSigningStarted = "tree_signing_started",
    TreeNonces = "tree_nonces",
    TreeTx = "tree_tx",
    TreeSignature = "tree_signature",
    StreamStarted = "stream_started",
}

export type BatchFinalizationEvent = {
    type: SettlementEventType.BatchFinalization;
    id: string;
    commitmentTx: string;
};

export type BatchFinalizedEvent = {
    type: SettlementEventType.BatchFinalized;
    id: string;
    commitmentTxid: string;
};

export type BatchFailedEvent = {
    type: SettlementEventType.BatchFailed;
    id: string;
    reason: string;
};

export type TreeSigningStartedEvent = {
    type: SettlementEventType.TreeSigningStarted;
    id: string;
    cosignersPublicKeys: string[];
    unsignedCommitmentTx: string;
};

export type TreeNoncesEvent = {
    type: SettlementEventType.TreeNonces;
    id: string;
    topic: string[];
    txid: string;
    /** Musig2 public nonces keyed by cosigner public key. */
    nonces: TreeNonces;
};

export type BatchStartedEvent = {
    type: SettlementEventType.BatchStarted;
    id: string;
    intentIdHashes: string[];
    batchExpiry: bigint;
};

export type TreeTxEvent = {
    type: SettlementEventType.TreeTx;
    id: string;
    topic: string[];
    batchIndex: number;
    chunk: TxTreeNode;
};

export type TreeSignatureEvent = {
    type: SettlementEventType.TreeSignature;
    id: string;
    topic: string[];
    batchIndex: number;
    txid: string;
    signature: string;
};

export type StreamStartedEvent = {
    type: SettlementEventType.StreamStarted;
    id: string;
};

export type SettlementEvent =
    | BatchFinalizationEvent
    | BatchFinalizedEvent
    | BatchFailedEvent
    | TreeSigningStartedEvent
    | TreeNoncesEvent
    | BatchStartedEvent
    | TreeTxEvent
    | TreeSignatureEvent
    | StreamStartedEvent;

export interface ScheduledSession {
    duration: bigint;
    fees: FeeInfo;
    nextEndTime: bigint;
    nextStartTime: bigint;
    period: bigint;
}

export interface FeeInfo {
    intentFee: IntentFeeConfig;
    txFeeRate: string;
}

export interface PendingTx {
    arkTxid: string;
    finalArkTx: string;
    signedCheckpointTxs: string[];
}

export interface DeprecatedSigner {
    /**
     * Unix timestamp (seconds) after which the server no longer accepts this
     * signer's VTXOs as cooperative-migration inputs. arkd advertises this as a
     * non-nullable field, so it is always present: `0n` is the sentinel for "no
     * cutoff advertised" — the deprecated signer is due for migration
     * immediately ({@link classifyContractSigner} maps `0n` to `DUE_NOW`). A
     * positive value is a real deadline (`MIGRATABLE` until it passes, then
     * `EXPIRED`).
     */
    cutoffDate: bigint;
    pubkey: string;
}

export type ServiceStatus = Record<string, string>;

export interface ArkInfo {
    boardingExitDelay: bigint;
    checkpointTapscript: string;
    deprecatedSigners: DeprecatedSigner[];
    digest: string;
    dust: bigint;
    fees: FeeInfo;
    forfeitAddress: string;
    forfeitPubkey: string;
    network: string;
    scheduledSession?: ScheduledSession;
    serviceStatus: ServiceStatus;
    sessionDuration: bigint;
    signerPubkey: string;
    unilateralExitDelay: bigint;
    /**
     * Maximum boarding input amount.
     *
     * @remarks
     * `-1` means unlimited, while `0` disables boarding.
     */
    utxoMaxAmount: bigint;
    utxoMinAmount: bigint;
    version: string;
    /**
     * Maximum virtual output amount.
     *
     * @remarks
     * `-1` means unlimited.
     */
    vtxoMaxAmount: bigint;
    vtxoMinAmount: bigint;
}

/** Signed intent payload sent to the Arkade server. */
export interface SignedIntent<T extends Intent.Message> {
    /** Base64-encoded signed proof transaction. */
    proof: string;

    /** Intent message payload associated with the proof. */
    message: T;
}

/** Transaction notification emitted by the Arkade server stream. */
export interface TxNotification {
    /** Transaction id. */
    txid: string;

    /** Raw transaction payload. */
    tx: string;

    /** Virtual outputs spent by the transaction. */
    spentVtxos: Vtxo[];

    /** Virtual outputs made spendable by the transaction. */
    spendableVtxos: Vtxo[];

    /** Optional checkpoint transactions associated with the notification. */
    checkpointTxs?: Record<string, { txid: string; tx: string }>;
}

export interface ArkProvider {
    /** Fetch Arkade server configuration and fee settings. */
    getInfo(): Promise<ArkInfo>;

    /** Submit a signed Arkade transaction and its checkpoint transactions. */
    submitTx(
        signedArkTx: string,
        checkpointTxs: string[],
    ): Promise<{
        arkTxid: string;
        finalArkTx: string;
        signedCheckpointTxs: string[];
    }>;

    /** Finalize a previously submitted Arkade transaction. */
    finalizeTx(arkTxid: string, finalCheckpointTxs: string[]): Promise<void>;

    /** Register a signed intent with the Arkade server. */
    registerIntent(intent: SignedIntent<Intent.RegisterMessage>): Promise<string>;

    /** Delete a previously registered intent. */
    deleteIntent(intent: SignedIntent<Intent.DeleteMessage>): Promise<void>;

    /** Confirm an already registered intent id. */
    confirmRegistration(intentId: string): Promise<void>;

    /** Submit musig2 tree nonces for a batch signing session. */
    submitTreeNonces(batchId: string, pubkey: string, nonces: TreeNonces): Promise<void>;

    /** Submit musig2 partial signatures for a batch signing session. */
    submitTreeSignatures(
        batchId: string,
        pubkey: string,
        signatures: TreePartialSigs,
    ): Promise<void>;

    /** Submit signed forfeit transactions for cooperative settlement. */
    submitSignedForfeitTxs(signedForfeitTxs: string[], signedCommitmentTx?: string): Promise<void>;

    /** Open the settlement event stream for the given topics. */
    getEventStream(signal: AbortSignal, topics: string[]): AsyncIterableIterator<SettlementEvent>;

    /** Stream transaction notifications emitted by the Arkade server. */
    getTransactionsStream(signal: AbortSignal): AsyncIterableIterator<{
        commitmentTx?: TxNotification;
        arkTx?: TxNotification;
    }>;

    /** Fetch pending transactions for a signed get-pending-tx intent. */
    getPendingTxs(intent: SignedIntent<Intent.GetPendingTxMessage>): Promise<PendingTx[]>;
}

/**
 * REST-based Arkade provider implementation.
 *
 * @see https://buf.build/arkade-os/arkd/docs/main:ark.v1#ark.v1.ArkService
 * @example
 * ```typescript
 * const provider = new RestArkProvider('https://arkade.computer');
 * const info = await provider.getInfo();
 * ```
 */
export class RestArkProvider implements ArkProvider {
    constructor(public serverUrl: string = DEFAULT_ARKADE_SERVER_URL) {}

    /**
     * Last server-info digest seen (from {@link getInfo}). Sent as `X-Digest`
     * on outgoing requests so arkd can reject a client whose cached info is
     * stale. Empty until the first {@link getInfo}.
     */
    private _digest = "";

    private _serverInfoListeners = new Set<(info: ArkInfo) => void>();

    /**
     * Subscribe to server-info changes. Fired when a request is rejected with
     * `DIGEST_MISMATCH` and fresh info is re-fetched, so consumers (the wallet)
     * can re-derive signer-dependent state mid-session without polling. Returns
     * an unsubscribe function.
     */
    onServerInfoChanged(listener: (info: ArkInfo) => void): () => void {
        this._serverInfoListeners.add(listener);
        return () => {
            this._serverInfoListeners.delete(listener);
        };
    }

    private emitServerInfoChanged(info: ArkInfo): void {
        for (const listener of this._serverInfoListeners) {
            try {
                listener(info);
            } catch (e) {
                console.warn("onServerInfoChanged listener threw", e);
            }
        }
    }

    /**
     * `fetch` wrapper for arkd requests that participates in server-info digest
     * negotiation. Sends the cached `X-Digest`; when arkd rejects a request with
     * `DIGEST_MISMATCH`, refreshes {@link getInfo} (updating the digest), fires
     * {@link onServerInfoChanged}, and THROWS {@link DigestMismatchError} — it
     * never silently retries, since the in-flight request was built against the
     * now-stale config. Dormant until arkd returns the error — then it is the
     * instant, event-driven signer-rotation trigger. {@link getInfo} itself never
     * routes through here: it is the refresh path and must not be digest-gated.
     */
    private async authedFetch(url: string, init: RequestInit): Promise<Response> {
        // Read the cached digest once, in the method body where `this` is
        // unambiguously the provider, and build the header set imperatively. A
        // prior nested-arrow form (`() => this._digest ? ... : init`) read
        // `this._digest` as empty on some CI runners and dropped the header.
        const digest = this._digest;
        const headers: Record<string, string> = {
            ...(init.headers as Record<string, string> | undefined),
        };
        if (digest) headers["X-Digest"] = digest;
        const response = await fetch(url, { ...init, headers });
        if (response.ok) return response;
        let body: string;
        try {
            body = await response.clone().text();
        } catch (e) {
            // Couldn't read the body to classify it (e.g. the connection dropped
            // mid-body). Detection is only deferred to the next getInfo(), not
            // lost — but surface it rather than swallowing silently. Return the
            // original response so the caller still sees the underlying error.
            console.warn("authedFetch could not read response body for digest check", e);
            return response;
        }
        // Only arkd's *structured* digest error counts: a grpc-gateway
        // ErrorDetails whose name is DIGEST_MISMATCH (arkd's X-Digest guard,
        // v0.9.9-rc.1 #1104), parsed via the shared maybeArkError. A raw
        // substring match would let an unrelated error body that merely mentions
        // the token trigger a spurious refresh + signer rotation.
        if (maybeArkError(new Error(body))?.name !== "DIGEST_MISMATCH") return response;
        // arkd rejected this request because our cached server info is stale
        // (e.g. the operator rotated its signer). Mirror NArk's BuildVersionHandler
        // (dotnet-sdk #131): clear the digest, refetch info, fire onServerInfoChanged
        // so the wallet re-derives signer-dependent state, then THROW. The SDK does
        // NOT silently retry — the in-flight request was built against the old config,
        // so the caller must rebuild and retry it under the refreshed server info.
        this._digest = "";
        const info = await this.getInfo();
        this.emitServerInfoChanged(info);
        throw new DigestMismatchError(
            "Arkade server reported a configuration digest mismatch; server info was " +
                "refreshed. Rebuild and retry the request under the new server info.",
        );
    }

    async getInfo(): Promise<ArkInfo> {
        const url = `${this.serverUrl}/v1/info`;
        const response = await fetch(url);
        if (!response.ok) {
            const errorText = await response.text();
            handleError(errorText, `Failed to get server info: ${response.statusText}`);
        }
        const fromServer = await response.json();
        const info: ArkInfo = {
            boardingExitDelay: BigInt(fromServer.boardingExitDelay ?? 0),
            checkpointTapscript: fromServer.checkpointTapscript ?? "",
            deprecatedSigners:
                fromServer.deprecatedSigners?.map((signer: any) => ({
                    // arkd advertises `cutoffDate` as a non-nullable field, so it
                    // is always a bigint here — `0n` is the sentinel for "no
                    // cutoff" (the classifier maps it to DUE_NOW). The grpc-gateway
                    // marshals with EmitUnpopulated, so an unset `cutoff_date`
                    // already arrives as `"0"`; a genuinely missing field defaults
                    // to `0n` too. Never collapse to `undefined`.
                    cutoffDate: BigInt(signer.cutoffDate ?? 0),
                    pubkey: signer.pubkey ?? "",
                })) ?? [],
            digest: fromServer.digest ?? "",
            dust: BigInt(fromServer.dust ?? 0),
            fees: {
                intentFee: fromServer.fees?.intentFee ?? {},
                txFeeRate: fromServer?.fees?.txFeeRate ?? "",
            },
            forfeitAddress: fromServer.forfeitAddress ?? "",
            forfeitPubkey: fromServer.forfeitPubkey ?? "",
            network: fromServer.network ?? "",
            scheduledSession:
                "scheduledSession" in fromServer && fromServer.scheduledSession != null
                    ? {
                          duration: BigInt(fromServer.scheduledSession.duration ?? 0),
                          nextStartTime: BigInt(fromServer.scheduledSession.nextStartTime ?? 0),
                          nextEndTime: BigInt(fromServer.scheduledSession.nextEndTime ?? 0),
                          period: BigInt(fromServer.scheduledSession.period ?? 0),
                          fees: fromServer.scheduledSession.fees ?? {},
                      }
                    : undefined,
            serviceStatus: fromServer.serviceStatus ?? {},
            sessionDuration: BigInt(fromServer.sessionDuration ?? 0),
            signerPubkey: fromServer.signerPubkey ?? "",
            unilateralExitDelay: BigInt(fromServer.unilateralExitDelay ?? 0),
            utxoMaxAmount: BigInt(fromServer.utxoMaxAmount ?? -1),
            utxoMinAmount: BigInt(fromServer.utxoMinAmount ?? 0),
            version: fromServer.version ?? "",
            vtxoMaxAmount: BigInt(fromServer.vtxoMaxAmount ?? -1),
            vtxoMinAmount: BigInt(fromServer.vtxoMinAmount ?? 0),
        };
        this._digest = info.digest;
        return info;
    }

    async submitTx(
        signedArkTx: string,
        checkpointTxs: string[],
    ): Promise<{
        arkTxid: string;
        finalArkTx: string;
        signedCheckpointTxs: string[];
    }> {
        const url = `${this.serverUrl}/v1/tx/submit`;
        const response = await this.authedFetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                signedArkTx,
                checkpointTxs,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            handleError(errorText, `Failed to submit virtual transaction: ${errorText}`);
        }

        const data = await response.json();
        return {
            arkTxid: data.arkTxid,
            finalArkTx: data.finalArkTx,
            signedCheckpointTxs: data.signedCheckpointTxs,
        };
    }

    async finalizeTx(arkTxid: string, finalCheckpointTxs: string[]): Promise<void> {
        const url = `${this.serverUrl}/v1/tx/finalize`;
        const response = await this.authedFetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                arkTxid,
                finalCheckpointTxs,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            handleError(errorText, `Failed to finalize offchain transaction: ${errorText}`);
        }
    }

    async registerIntent(intent: SignedIntent<Intent.RegisterMessage>): Promise<string> {
        const url = `${this.serverUrl}/v1/batch/registerIntent`;
        const response = await this.authedFetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                intent: {
                    proof: intent.proof,
                    message: Intent.encodeMessage(intent.message),
                },
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            handleError(errorText, `Failed to register intent: ${errorText}`);
        }

        const data = await response.json();
        return data.intentId;
    }

    async deleteIntent(intent: SignedIntent<Intent.DeleteMessage>): Promise<void> {
        const url = `${this.serverUrl}/v1/batch/deleteIntent`;
        const response = await this.authedFetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                intent: {
                    proof: intent.proof,
                    message: Intent.encodeMessage(intent.message),
                },
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            handleError(errorText, `Failed to delete intent: ${errorText}`);
        }
    }

    async confirmRegistration(intentId: string): Promise<void> {
        const url = `${this.serverUrl}/v1/batch/ack`;
        const response = await this.authedFetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                intentId,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            handleError(errorText, `Failed to confirm registration: ${errorText}`);
        }
    }

    async submitTreeNonces(batchId: string, pubkey: string, nonces: TreeNonces): Promise<void> {
        const url = `${this.serverUrl}/v1/batch/tree/submitNonces`;
        const response = await this.authedFetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                batchId,
                pubkey,
                treeNonces: encodeMusig2Nonces(nonces),
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            handleError(errorText, `Failed to submit tree nonces: ${errorText}`);
        }
    }

    async submitTreeSignatures(
        batchId: string,
        pubkey: string,
        signatures: TreePartialSigs,
    ): Promise<void> {
        const url = `${this.serverUrl}/v1/batch/tree/submitSignatures`;
        const response = await this.authedFetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                batchId,
                pubkey,
                treeSignatures: encodeMusig2Signatures(signatures),
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            handleError(errorText, `Failed to submit tree signatures: ${errorText}`);
        }
    }

    async submitSignedForfeitTxs(
        signedForfeitTxs: string[],
        signedCommitmentTx?: string,
    ): Promise<void> {
        const url = `${this.serverUrl}/v1/batch/submitForfeitTxs`;
        const response = await this.authedFetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                signedForfeitTxs: signedForfeitTxs,
                signedCommitmentTx: signedCommitmentTx,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            handleError(errorText, `Failed to submit forfeit transactions: ${response.statusText}`);
        }
    }

    getEventStream(signal: AbortSignal, topics: string[]): AsyncIterableIterator<SettlementEvent> {
        const url = `${this.serverUrl}/v1/batch/events`;
        const queryParams =
            topics.length > 0
                ? `?${topics.map((topic) => `topics=${encodeURIComponent(topic)}`).join("&")}`
                : "";

        // The EventSource is allocated inside the generator body so that
        // abandoning the returned iterator before iteration starts does not
        // leak the underlying SSE connection. `return()` is overridden below
        // so that closing the generator also closes the connection even when
        // the body is currently suspended at an await point.
        let iterator: ReturnType<typeof eventSourceIterator> | null = null;
        const closeIterator = () => iterator?.close();

        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;
        const gen = (async function* () {
            const abortHandler = closeIterator;
            signal?.addEventListener("abort", abortHandler);

            try {
                while (!signal?.aborted) {
                    const currentIterator = eventSourceIterator(new EventSource(url + queryParams));
                    iterator = currentIterator;

                    try {
                        for await (const event of currentIterator) {
                            if (signal?.aborted) break;

                            try {
                                const data = JSON.parse(event.data);
                                const settlementEvent = self.parseSettlementEvent(data);
                                if (settlementEvent) {
                                    yield settlementEvent;
                                }
                            } catch (err) {
                                console.error("Failed to parse event:", err);
                                throw err;
                            }
                        }
                    } catch (error) {
                        if (
                            signal?.aborted ||
                            (error instanceof Error && error.name === "AbortError")
                        ) {
                            break;
                        }

                        // ignore timeout errors, they're expected when the server is not sending anything for 5 min
                        if (isFetchTimeoutError(error)) {
                            console.debug("Timeout error ignored");
                            continue;
                        }

                        if (isEventSourceError(error)) {
                            throw error;
                        }

                        console.error("Event stream error:", error);
                        throw error;
                    } finally {
                        currentIterator.close();
                        iterator = null;
                    }
                }
            } finally {
                signal?.removeEventListener("abort", abortHandler);
                closeIterator();
            }
        })();

        const origReturn = gen.return.bind(gen);
        gen.return = (value) => {
            closeIterator();
            return origReturn(value);
        };

        return gen;
    }

    getTransactionsStream(signal: AbortSignal): AsyncIterableIterator<{
        commitmentTx?: TxNotification;
        arkTx?: TxNotification;
    }> {
        const url = `${this.serverUrl}/v1/txs`;
        let iterator: ReturnType<typeof eventSourceIterator> | null = null;
        const closeIterator = () => iterator?.close();

        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;
        const gen = (async function* () {
            const abortHandler = closeIterator;
            signal?.addEventListener("abort", abortHandler);

            try {
                while (!signal?.aborted) {
                    try {
                        const currentIterator = eventSourceIterator(new EventSource(url));
                        iterator = currentIterator;

                        for await (const event of currentIterator) {
                            if (signal?.aborted) break;

                            try {
                                const data = JSON.parse(event.data);
                                const txNotification = self.parseTransactionNotification(data);
                                if (txNotification) {
                                    yield txNotification;
                                }
                            } catch (err) {
                                console.error("Failed to parse transaction notification:", err);
                                throw err;
                            }
                        }
                    } catch (error) {
                        if (
                            signal?.aborted ||
                            (error instanceof Error && error.name === "AbortError")
                        ) {
                            break;
                        }

                        // ignore timeout errors, they're expected when the server is not sending anything for 5 min
                        if (isFetchTimeoutError(error)) {
                            console.debug("Timeout error ignored");
                            continue;
                        }

                        if (isEventSourceError(error)) {
                            throw error;
                        }

                        console.error("Transaction stream error:", error);
                        throw error;
                    } finally {
                        closeIterator();
                        iterator = null;
                    }
                }
            } finally {
                signal?.removeEventListener("abort", abortHandler);
                closeIterator();
            }
        })();

        const origReturn = gen.return.bind(gen);
        gen.return = (value) => {
            closeIterator();
            return origReturn(value);
        };

        return gen;
    }

    async getPendingTxs(intent: SignedIntent<Intent.GetPendingTxMessage>): Promise<PendingTx[]> {
        const url = `${this.serverUrl}/v1/tx/pending`;
        const response = await this.authedFetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                intent: {
                    proof: intent.proof,
                    message: Intent.encodeMessage(intent.message),
                },
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            handleError(errorText, `Failed to get pending transactions: ${errorText}`);
        }

        const data = await response.json();
        return data.pendingTxs;
    }

    protected parseSettlementEvent(
        data: ProtoTypes.GetEventStreamResponse,
    ): SettlementEvent | null {
        // Check for BatchStarted event
        if (data.batchStarted) {
            return {
                type: SettlementEventType.BatchStarted,
                id: data.batchStarted.id,
                intentIdHashes: data.batchStarted.intentIdHashes,
                batchExpiry: BigInt(data.batchStarted.batchExpiry),
            };
        }

        // Check for BatchFinalization event
        if (data.batchFinalization) {
            return {
                type: SettlementEventType.BatchFinalization,
                id: data.batchFinalization.id,
                commitmentTx: data.batchFinalization.commitmentTx,
            };
        }

        // Check for BatchFinalized event
        if (data.batchFinalized) {
            return {
                type: SettlementEventType.BatchFinalized,
                id: data.batchFinalized.id,
                commitmentTxid: data.batchFinalized.commitmentTxid,
            };
        }

        // Check for BatchFailed event
        if (data.batchFailed) {
            return {
                type: SettlementEventType.BatchFailed,
                id: data.batchFailed.id,
                reason: data.batchFailed.reason,
            };
        }

        // Check for TreeSigningStarted event
        if (data.treeSigningStarted) {
            return {
                type: SettlementEventType.TreeSigningStarted,
                id: data.treeSigningStarted.id,
                cosignersPublicKeys: data.treeSigningStarted.cosignersPubkeys,
                unsignedCommitmentTx: data.treeSigningStarted.unsignedCommitmentTx,
            };
        }

        // Check for TreeNoncesAggregated event
        if (data.treeNoncesAggregated) {
            // skip treeNoncesAggregated event, deprecated
            return null;
        }

        if (data.treeNonces) {
            return {
                type: SettlementEventType.TreeNonces,
                id: data.treeNonces.id,
                topic: data.treeNonces.topic,
                txid: data.treeNonces.txid,
                nonces: decodeMusig2Nonces(data.treeNonces.nonces), // pubkey -> public nonce
            };
        }

        // Check for TreeTx event
        if (data.treeTx) {
            const children = Object.fromEntries(
                Object.entries(data.treeTx.children).map(([outputIndex, txid]) => {
                    return [parseInt(outputIndex), txid];
                }),
            );

            return {
                type: SettlementEventType.TreeTx,
                id: data.treeTx.id,
                topic: data.treeTx.topic,
                batchIndex: data.treeTx.batchIndex,
                chunk: {
                    txid: data.treeTx.txid,
                    tx: data.treeTx.tx,
                    children,
                },
            };
        }

        if (data.treeSignature) {
            return {
                type: SettlementEventType.TreeSignature,
                id: data.treeSignature.id,
                topic: data.treeSignature.topic,
                batchIndex: data.treeSignature.batchIndex,
                txid: data.treeSignature.txid,
                signature: data.treeSignature.signature,
            };
        }

        if (data.streamStarted) {
            return {
                type: SettlementEventType.StreamStarted,
                id: data.streamStarted.id,
            };
        }

        // Skip heartbeat events
        if (data.heartbeat) {
            return null;
        }

        console.warn("Unknown event type:", data);
        return null;
    }

    protected parseTransactionNotification(
        data: ProtoTypes.GetTransactionsStreamResponse,
    ): { commitmentTx?: TxNotification; arkTx?: TxNotification } | null {
        if (data.commitmentTx) {
            return {
                commitmentTx: {
                    txid: data.commitmentTx.txid,
                    tx: data.commitmentTx.tx,
                    spentVtxos: data.commitmentTx.spentVtxos.map(mapVtxo),
                    spendableVtxos: data.commitmentTx.spendableVtxos.map(mapVtxo),
                    checkpointTxs: data.commitmentTx.checkpointTxs,
                },
            };
        }

        if (data.arkTx) {
            return {
                arkTx: {
                    txid: data.arkTx.txid,
                    tx: data.arkTx.tx,
                    spentVtxos: data.arkTx.spentVtxos.map(mapVtxo),
                    spendableVtxos: data.arkTx.spendableVtxos.map(mapVtxo),
                    checkpointTxs: data.arkTx.checkpointTxs,
                },
            };
        }

        // Skip heartbeat events
        if (data.heartbeat) {
            return null;
        }

        console.warn("Unknown transaction notification type:", data);
        return null;
    }
}

function encodeMusig2Nonces(nonces: TreeNonces): Record<string, string> {
    const noncesObject: Record<string, string> = {};
    for (const [txid, nonce] of nonces) {
        noncesObject[txid] = hex.encode(nonce.pubNonce);
    }
    return noncesObject;
}

function encodeMusig2Signatures(signatures: TreePartialSigs): Record<string, string> {
    const sigObject: Record<string, string> = {};
    for (const [txid, sig] of signatures) {
        sigObject[txid] = hex.encode(sig.encode());
    }
    return sigObject;
}

function decodeMusig2Nonces(noncesObject: Record<string, string>): TreeNonces {
    return new Map(
        Object.entries(noncesObject).map(([txid, nonce]) => {
            if (typeof nonce !== "string") {
                throw new Error("invalid nonce");
            }
            return [txid, { pubNonce: hex.decode(nonce) }];
        }),
    );
}

// ProtoTypes namespace defines unexported types representing the raw data received from the server
namespace ProtoTypes {
    interface BatchStartedEvent {
        id: string;
        intentIdHashes: string[];
        batchExpiry: number;
    }

    interface BatchFailed {
        id: string;
        reason: string;
    }

    export interface BatchFinalizationEvent {
        id: string;
        commitmentTx: string;
    }

    interface BatchFinalizedEvent {
        id: string;
        commitmentTxid: string;
    }

    interface TreeSigningStartedEvent {
        id: string;
        cosignersPubkeys: string[];
        unsignedCommitmentTx: string;
    }

    interface TreeNoncesAggregatedEvent {
        id: string;
        treeNonces: Record<string, string>;
    }

    interface TreeNoncesEvent {
        id: string;
        topic: string[];
        txid: string;
        nonces: Record<string, string>;
    }

    interface TreeTxEvent {
        id: string;
        topic: string[];
        batchIndex: number;
        txid: string;
        tx: string;
        children: Record<string, string>;
    }

    interface TreeSignatureEvent {
        id: string;
        topic: string[];
        batchIndex: number;
        txid: string;
        signature: string;
    }

    interface StreamStartedEvent {
        id: string;
    }

    interface Heartbeat {
        // Empty interface for heartbeat events
    }

    export interface VtxoData {
        outpoint: {
            txid: string;
            vout: number;
        };
        amount: string;
        script: string;
        createdAt: string;
        expiresAt: string | null;
        commitmentTxids: string[];
        isPreconfirmed: boolean;
        isSwept: boolean;
        isUnrolled: boolean;
        isSpent: boolean;
        spentBy: string;
        settledBy?: string;
        arkTxid?: string;
    }

    export interface GetEventStreamResponse {
        batchStarted?: BatchStartedEvent;
        batchFailed?: BatchFailed;
        batchFinalization?: BatchFinalizationEvent;
        batchFinalized?: BatchFinalizedEvent;
        treeSigningStarted?: TreeSigningStartedEvent;
        treeNoncesAggregated?: TreeNoncesAggregatedEvent;
        treeNonces?: TreeNoncesEvent;
        treeTx?: TreeTxEvent;
        treeSignature?: TreeSignatureEvent;
        streamStarted?: StreamStartedEvent;
        heartbeat?: Heartbeat;
    }

    export interface GetTransactionsStreamResponse {
        commitmentTx?: {
            txid: string;
            tx: string;
            spentVtxos: VtxoData[];
            spendableVtxos: VtxoData[];
            checkpointTxs?: Record<string, { txid: string; tx: string }>;
        };
        arkTx?: {
            txid: string;
            tx: string;
            spentVtxos: VtxoData[];
            spendableVtxos: VtxoData[];
            checkpointTxs?: Record<string, { txid: string; tx: string }>;
        };
        heartbeat?: Heartbeat;
    }

    // Legacy types for backward compatibility
    export interface EventData {
        batchStarted?: BatchStartedEvent;
        batchFailed?: BatchFailed;
        batchFinalization?: BatchFinalizationEvent;
        batchFinalized?: BatchFinalizedEvent;
        treeSigningStarted?: TreeSigningStartedEvent;
        treeNoncesAggregated?: TreeNoncesAggregatedEvent;
        treeTx?: TreeTxEvent;
        treeSignature?: TreeSignatureEvent;
    }

    export interface TransactionData {
        commitmentTx?: {
            txid: string;
            tx: string;
            spentVtxos: VtxoData[];
            spendableVtxos: VtxoData[];
            checkpointTxs?: Record<string, { txid: string; tx: string }>;
        };
        arkTx?: {
            txid: string;
            tx: string;
            spentVtxos: VtxoData[];
            spendableVtxos: VtxoData[];
            checkpointTxs?: Record<string, { txid: string; tx: string }>;
        };
    }
}

export function isFetchTimeoutError(err: any): boolean {
    const checkError = (error: any) => {
        if (!(error instanceof Error)) return false;

        // TODO: get something more robust than this
        const isCloudflare524 = error.name === "TypeError" && error.message === "Failed to fetch";

        return (
            isCloudflare524 ||
            error.name === "HeadersTimeoutError" ||
            error.name === "BodyTimeoutError" ||
            (error as any).code === "UND_ERR_HEADERS_TIMEOUT" ||
            (error as any).code === "UND_ERR_BODY_TIMEOUT"
        );
    };

    return checkError(err) || checkError((err as any).cause);
}

function mapVtxo(vtxo: ProtoTypes.VtxoData): Vtxo {
    return {
        outpoint: {
            txid: vtxo.outpoint.txid,
            vout: vtxo.outpoint.vout,
        },
        amount: vtxo.amount,
        script: vtxo.script,
        createdAt: vtxo.createdAt,
        expiresAt: vtxo.expiresAt,
        commitmentTxids: vtxo.commitmentTxids,
        isPreconfirmed: vtxo.isPreconfirmed,
        isSwept: vtxo.isSwept,
        isUnrolled: vtxo.isUnrolled,
        isSpent: vtxo.isSpent,
        spentBy: vtxo.spentBy,
        settledBy: vtxo.settledBy,
        arkTxid: vtxo.arkTxid,
    };
}

function handleError(errorText: string, defaultMessage: string): never {
    const error = new Error(errorText);
    const arkError = maybeArkError(error);
    throw arkError ?? new Error(defaultMessage);
}
