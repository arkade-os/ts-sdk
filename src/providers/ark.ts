import { TxTreeNode } from "../tree/txTree";
import { TreeNonces, TreePartialSigs } from "../tree/signingSession";
import { hex } from "@scure/base";
import { Vtxo } from "./indexer";
import { eventSourceIterator } from "./utils";

export type Output = {
    address: string; // onchain or off-chain
    amount: bigint; // Amount to send in satoshis
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
    nonces: TreeNonces; // pubkey -> public nonce
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

export type SettlementEvent =
    | BatchFinalizationEvent
    | BatchFinalizedEvent
    | BatchFailedEvent
    | TreeSigningStartedEvent
    | TreeNoncesEvent
    | BatchStartedEvent
    | TreeTxEvent
    | TreeSignatureEvent;

export interface MarketHour {
    nextStartTime: bigint;
    nextEndTime: bigint;
    period: bigint;
    roundInterval: bigint;
}

export interface IntentFeeInfo {
    offchainInput: string;
    offchainOutput: string;
    onchainInput: string;
    onchainOutput: string;
}

export interface FeeInfo {
    intentFee: IntentFeeInfo;
    txFeeRate: string;
}

export interface PendingTx {
    arkTxid: string;
    finalArkTx: string;
    signedCheckpointTxs: string[];
}

export interface DeprecatedSigner {
    cutoffDate: bigint;
    pubkey: string;
}

export interface ArkInfo {
    boardingExitDelay: bigint;
    checkpointTapscript: string;
    deprecatedSigners: DeprecatedSigner[];
    digest: string;
    dust: bigint;
    fees: FeeInfo;
    forfeitAddress: string;
    forfeitPubkey: string;
    marketHour?: MarketHour;
    network: string;
    roundInterval: bigint;
    signerPubkey: string;
    unilateralExitDelay: bigint;
    utxoMaxAmount: bigint; // -1 means no limit (default), 0 means boarding not allowed
    utxoMinAmount: bigint;
    version: string;
    vtxoMaxAmount: bigint; // -1 means no limit (default)
    vtxoMinAmount: bigint;
    vtxoTreeExpiry: bigint;
}

export interface SignedIntent {
    proof: string;
    message: string;
}

export interface TxNotification {
    txid: string;
    tx: string;
    spentVtxos: Vtxo[];
    spendableVtxos: Vtxo[];
    checkpointTxs?: Record<string, { txid: string; tx: string }>;
}

export interface ArkProvider {
    getInfo(): Promise<ArkInfo>;
    submitTx(
        signedArkTx: string,
        checkpointTxs: string[]
    ): Promise<{
        arkTxid: string;
        finalArkTx: string;
        signedCheckpointTxs: string[];
    }>;
    finalizeTx(arkTxid: string, finalCheckpointTxs: string[]): Promise<void>;
    registerIntent(intent: SignedIntent): Promise<string>;
    deleteIntent(intent: SignedIntent): Promise<void>;
    confirmRegistration(intentId: string): Promise<void>;
    submitTreeNonces(
        batchId: string,
        pubkey: string,
        nonces: TreeNonces
    ): Promise<void>;
    submitTreeSignatures(
        batchId: string,
        pubkey: string,
        signatures: TreePartialSigs
    ): Promise<void>;
    submitSignedForfeitTxs(
        signedForfeitTxs: string[],
        signedCommitmentTx?: string
    ): Promise<void>;
    getEventStream(
        signal: AbortSignal,
        topics: string[]
    ): AsyncIterableIterator<SettlementEvent>;
    getTransactionsStream(signal: AbortSignal): AsyncIterableIterator<{
        commitmentTx?: TxNotification;
        arkTx?: TxNotification;
    }>;
    getPendingTxs(intent: SignedIntent): Promise<PendingTx[]>;
}

/**
 * REST-based Ark provider implementation.
 * @see https://buf.build/arkade-os/arkd/docs/main:ark.v1#ark.v1.ArkService
 * @example
 * ```typescript
 * const provider = new RestArkProvider('https://ark.example.com');
 * const info = await provider.getInfo();
 * ```
 */
export class RestArkProvider implements ArkProvider {
    constructor(public serverUrl: string) {}

    async getInfo(): Promise<ArkInfo> {
        const url = `${this.serverUrl}/v1/info`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(
                `Failed to get server info: ${response.statusText}`
            );
        }
        const fromServer = await response.json();
        return {
            ...fromServer,
            boardingExitDelay: BigInt(fromServer.boardingExitDelay ?? 0),
            checkpointTapscript: fromServer.checkpointTapscript ?? "",
            deprecatedSigners:
                fromServer.deprecatedSigners?.map((signer: any) => ({
                    cutoffDate: BigInt(signer.cutoffDate ?? 0),
                    pubkey: signer.pubkey ?? "",
                })) ?? [],
            digest: fromServer.digest ?? "",
            dust: BigInt(fromServer.dust ?? 0),
            fees: fromServer.fees,
            marketHour:
                "marketHour" in fromServer && fromServer.marketHour != null
                    ? {
                          nextStartTime: BigInt(
                              fromServer.marketHour.nextStartTime ?? 0
                          ),
                          nextEndTime: BigInt(
                              fromServer.marketHour.nextEndTime ?? 0
                          ),
                          period: BigInt(fromServer.marketHour.period ?? 0),
                          roundInterval: BigInt(
                              fromServer.marketHour.roundInterval ?? 0
                          ),
                      }
                    : undefined,
            roundInterval: BigInt(fromServer.roundInterval ?? 0),
            unilateralExitDelay: BigInt(fromServer.unilateralExitDelay ?? 0),
            utxoMaxAmount: BigInt(fromServer.utxoMaxAmount ?? -1),
            utxoMinAmount: BigInt(fromServer.utxoMinAmount ?? 0),
            vtxoMaxAmount: BigInt(fromServer.vtxoMaxAmount ?? -1),
            vtxoMinAmount: BigInt(fromServer.vtxoMinAmount ?? 0),
            vtxoTreeExpiry: BigInt(fromServer.vtxoTreeExpiry ?? 0),
        };
    }

    async submitTx(
        signedArkTx: string,
        checkpointTxs: string[]
    ): Promise<{
        arkTxid: string;
        finalArkTx: string;
        signedCheckpointTxs: string[];
    }> {
        const url = `${this.serverUrl}/v1/tx/submit`;
        const response = await fetch(url, {
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
            try {
                const grpcError = JSON.parse(errorText);
                // gRPC errors usually have a message and code field
                throw new Error(
                    `Failed to submit virtual transaction: ${grpcError.message || grpcError.error || errorText}`
                );
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
            } catch (_) {
                // If JSON parse fails, use the raw error text
                throw new Error(
                    `Failed to submit virtual transaction: ${errorText}`
                );
            }
        }

        const data = await response.json();
        return {
            arkTxid: data.arkTxid,
            finalArkTx: data.finalArkTx,
            signedCheckpointTxs: data.signedCheckpointTxs,
        };
    }

    async finalizeTx(
        arkTxid: string,
        finalCheckpointTxs: string[]
    ): Promise<void> {
        const url = `${this.serverUrl}/v1/tx/finalize`;
        const response = await fetch(url, {
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
            throw new Error(
                `Failed to finalize offchain transaction: ${errorText}`
            );
        }
    }

    async registerIntent(intent: SignedIntent): Promise<string> {
        const url = `${this.serverUrl}/v1/batch/registerIntent`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                intent: {
                    proof: intent.proof,
                    message: intent.message,
                },
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to register intent: ${errorText}`);
        }

        const data = await response.json();
        return data.intentId;
    }

    async deleteIntent(intent: SignedIntent): Promise<void> {
        const url = `${this.serverUrl}/v1/batch/deleteIntent`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                proof: {
                    proof: intent.proof,
                    message: intent.message,
                },
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to delete intent: ${errorText}`);
        }
    }

    async confirmRegistration(intentId: string): Promise<void> {
        const url = `${this.serverUrl}/v1/batch/ack`;
        const response = await fetch(url, {
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
            throw new Error(`Failed to confirm registration: ${errorText}`);
        }
    }

    async submitTreeNonces(
        batchId: string,
        pubkey: string,
        nonces: TreeNonces
    ): Promise<void> {
        const url = `${this.serverUrl}/v1/batch/tree/submitNonces`;
        const response = await fetch(url, {
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
            throw new Error(`Failed to submit tree nonces: ${errorText}`);
        }
    }

    async submitTreeSignatures(
        batchId: string,
        pubkey: string,
        signatures: TreePartialSigs
    ): Promise<void> {
        const url = `${this.serverUrl}/v1/batch/tree/submitSignatures`;
        const response = await fetch(url, {
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
            throw new Error(`Failed to submit tree signatures: ${errorText}`);
        }
    }

    async submitSignedForfeitTxs(
        signedForfeitTxs: string[],
        signedCommitmentTx?: string
    ): Promise<void> {
        const url = `${this.serverUrl}/v1/batch/submitForfeitTxs`;
        const response = await fetch(url, {
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
            throw new Error(
                `Failed to submit forfeit transactions: ${response.statusText}`
            );
        }
    }

    async *getEventStream(
        signal: AbortSignal,
        topics: string[]
    ): AsyncIterableIterator<SettlementEvent> {
        const url = `${this.serverUrl}/v1/batch/events`;
        const queryParams =
            topics.length > 0
                ? `?${topics.map((topic) => `topics=${encodeURIComponent(topic)}`).join("&")}`
                : "";

        while (!signal?.aborted) {
            try {
                const eventSource = new EventSource(url + queryParams);

                // Set up abort handling
                const abortHandler = () => {
                    eventSource.close();
                };
                signal?.addEventListener("abort", abortHandler);

                try {
                    for await (const event of eventSourceIterator(
                        eventSource
                    )) {
                        if (signal?.aborted) break;

                        try {
                            const data = JSON.parse(event.data);
                            const settlementEvent =
                                this.parseSettlementEvent(data);
                            if (settlementEvent) {
                                yield settlementEvent;
                            }
                        } catch (err) {
                            console.error("Failed to parse event:", err);
                            throw err;
                        }
                    }
                } finally {
                    signal?.removeEventListener("abort", abortHandler);
                    eventSource.close();
                }
            } catch (error) {
                if (error instanceof Error && error.name === "AbortError") {
                    break;
                }

                // ignore timeout errors, they're expected when the server is not sending anything for 5 min
                if (isFetchTimeoutError(error)) {
                    console.debug("Timeout error ignored");
                    continue;
                }

                console.error("Event stream error:", error);
                throw error;
            }
        }
    }

    async *getTransactionsStream(signal: AbortSignal): AsyncIterableIterator<{
        commitmentTx?: TxNotification;
        arkTx?: TxNotification;
    }> {
        const url = `${this.serverUrl}/v1/txs`;

        while (!signal?.aborted) {
            try {
                const eventSource = new EventSource(url);

                // Set up abort handling
                const abortHandler = () => {
                    eventSource.close();
                };
                signal?.addEventListener("abort", abortHandler);

                try {
                    for await (const event of eventSourceIterator(
                        eventSource
                    )) {
                        if (signal?.aborted) break;

                        try {
                            const data = JSON.parse(event.data);
                            const txNotification =
                                this.parseTransactionNotification(data);
                            if (txNotification) {
                                yield txNotification;
                            }
                        } catch (err) {
                            console.error(
                                "Failed to parse transaction notification:",
                                err
                            );
                            throw err;
                        }
                    }
                } finally {
                    signal?.removeEventListener("abort", abortHandler);
                    eventSource.close();
                }
            } catch (error) {
                if (error instanceof Error && error.name === "AbortError") {
                    break;
                }

                // ignore timeout errors, they're expected when the server is not sending anything for 5 min
                if (isFetchTimeoutError(error)) {
                    console.debug("Timeout error ignored");
                    continue;
                }

                console.error("Transaction stream error:", error);
                throw error;
            }
        }
    }

    async getPendingTxs(intent: SignedIntent): Promise<PendingTx[]> {
        const url = `${this.serverUrl}/v1/tx/pending`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ intent }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            try {
                const grpcError = JSON.parse(errorText);
                // gRPC errors usually have a message and code field
                throw new Error(
                    `Failed to get pending transactions: ${grpcError.message || grpcError.error || errorText}`
                );
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
            } catch (_) {
                // If JSON parse fails, use the raw error text
                throw new Error(
                    `Failed to get pending transactions: ${errorText}`
                );
            }
        }

        const data = await response.json();
        return data.pendingTxs;
    }

    protected parseSettlementEvent(
        data: ProtoTypes.GetEventStreamResponse
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
                unsignedCommitmentTx:
                    data.treeSigningStarted.unsignedCommitmentTx,
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
                Object.entries(data.treeTx.children).map(
                    ([outputIndex, txid]) => {
                        return [parseInt(outputIndex), txid];
                    }
                )
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

        // Skip heartbeat events
        if (data.heartbeat) {
            return null;
        }

        console.warn("Unknown event type:", data);
        return null;
    }

    protected parseTransactionNotification(
        data: ProtoTypes.GetTransactionsStreamResponse
    ): { commitmentTx?: TxNotification; arkTx?: TxNotification } | null {
        if (data.commitmentTx) {
            return {
                commitmentTx: {
                    txid: data.commitmentTx.txid,
                    tx: data.commitmentTx.tx,
                    spentVtxos: data.commitmentTx.spentVtxos.map(mapVtxo),
                    spendableVtxos:
                        data.commitmentTx.spendableVtxos.map(mapVtxo),
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

function encodeMusig2Signatures(
    signatures: TreePartialSigs
): Record<string, string> {
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
        })
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
        const isCloudflare524 =
            error.name === "TypeError" && error.message === "Failed to fetch";

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
