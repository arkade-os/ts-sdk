import { TxTreeNode } from "../tree/txTree";
import { TreeNonces, TreePartialSigs } from "../tree/signingSession";
import { hex } from "@scure/base";
import { Vtxo } from "./indexer";

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
    TreeNoncesAggregated = "tree_nonces_aggregated",
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

export type TreeNoncesAggregatedEvent = {
    type: SettlementEventType.TreeNoncesAggregated;
    id: string;
    treeNonces: TreeNonces;
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
    | TreeNoncesAggregatedEvent
    | BatchStartedEvent
    | TreeTxEvent
    | TreeSignatureEvent;

export interface MarketHour {
    nextStartTime: bigint;
    nextEndTime: bigint;
    period: bigint;
    roundInterval: bigint;
}

export interface ArkInfo {
    signerPubkey: string;
    vtxoTreeExpiry: bigint;
    unilateralExitDelay: bigint;
    roundInterval: bigint;
    network: string;
    dust: bigint;
    forfeitAddress: string;
    marketHour?: MarketHour;
    version: string;
    utxoMinAmount: bigint;
    utxoMaxAmount: bigint; // -1 means no limit (default), 0 means boarding not allowed
    vtxoMinAmount: bigint;
    vtxoMaxAmount: bigint; // -1 means no limit (default)
    boardingExitDelay: bigint;
}

export interface Intent {
    signature: string;
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
    registerIntent(intent: Intent): Promise<string>;
    deleteIntent(intent: Intent): Promise<void>;
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
            vtxoTreeExpiry: BigInt(fromServer.vtxoTreeExpiry ?? 0),
            unilateralExitDelay: BigInt(fromServer.unilateralExitDelay ?? 0),
            roundInterval: BigInt(fromServer.roundInterval ?? 0),
            dust: BigInt(fromServer.dust ?? 0),
            utxoMinAmount: BigInt(fromServer.utxoMinAmount ?? 0),
            utxoMaxAmount: BigInt(fromServer.utxoMaxAmount ?? -1),
            vtxoMinAmount: BigInt(fromServer.vtxoMinAmount ?? 0),
            vtxoMaxAmount: BigInt(fromServer.vtxoMaxAmount ?? -1),
            boardingExitDelay: BigInt(fromServer.boardingExitDelay ?? 0),
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
                signedArkTx: signedArkTx,
                checkpointTxs: checkpointTxs,
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

    async registerIntent(intent: Intent): Promise<string> {
        const url = `${this.serverUrl}/v1/batch/registerIntent`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                intent: {
                    signature: intent.signature,
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

    async deleteIntent(intent: Intent): Promise<void> {
        const url = `${this.serverUrl}/v1/batch/deleteIntent`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                proof: {
                    signature: intent.signature,
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
                const response = await fetch(url + queryParams, {
                    headers: {
                        Accept: "application/json",
                    },
                    signal,
                });

                if (!response.ok) {
                    throw new Error(
                        `Unexpected status ${response.status} when fetching event stream`
                    );
                }

                if (!response.body) {
                    throw new Error("Response body is null");
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

                while (!signal?.aborted) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }

                    // Append new data to buffer and split by newlines
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");

                    // Process all complete lines
                    for (let i = 0; i < lines.length - 1; i++) {
                        const line = lines[i].trim();
                        if (!line) continue;

                        try {
                            const data = JSON.parse(line);
                            const event = this.parseSettlementEvent(
                                data.result
                            );
                            if (event) {
                                yield event;
                            }
                        } catch (err) {
                            console.error("Failed to parse event:", err);
                            throw err;
                        }
                    }

                    // Keep the last partial line in the buffer
                    buffer = lines[lines.length - 1];
                }
            } catch (error) {
                if (error instanceof Error && error.name === "AbortError") {
                    break;
                }

                // ignore timeout errors, they're expected when the server is not sending anything for 5 min
                // these timeouts are set by builtin fetch function
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
                const response = await fetch(url, {
                    headers: {
                        Accept: "application/json",
                    },
                    signal,
                });

                if (!response.ok) {
                    throw new Error(
                        `Unexpected status ${response.status} when fetching transaction stream`
                    );
                }

                if (!response.body) {
                    throw new Error("Response body is null");
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

                while (!signal?.aborted) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }

                    // Append new data to buffer and split by newlines
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");

                    // Process all complete lines
                    for (let i = 0; i < lines.length - 1; i++) {
                        const line = lines[i].trim();
                        if (!line) continue;

                        const data = JSON.parse(line);
                        const txNotification =
                            this.parseTransactionNotification(data.result);
                        if (txNotification) {
                            yield txNotification;
                        }
                    }

                    // Keep the last partial line in the buffer
                    buffer = lines[lines.length - 1];
                }
            } catch (error) {
                if (error instanceof Error && error.name === "AbortError") {
                    break;
                }

                // ignore timeout errors, they're expected when the server is not sending anything for 5 min
                // these timeouts are set by builtin fetch function
                if (isFetchTimeoutError(error)) {
                    console.debug("Timeout error ignored");
                    continue;
                }

                console.error("Address subscription error:", error);
                throw error;
            }
        }
    }

    private parseSettlementEvent(
        data: ProtoTypes.EventData
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
            return {
                type: SettlementEventType.TreeNoncesAggregated,
                id: data.treeNoncesAggregated.id,
                treeNonces: decodeMusig2Nonces(
                    data.treeNoncesAggregated.treeNonces
                ),
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

        console.warn("Unknown event type:", data);
        return null;
    }

    private parseTransactionNotification(
        data: ProtoTypes.TransactionData
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

        console.warn("Unknown transaction notification type:", data);
        return null;
    }
}

function encodeMusig2Nonces(nonces: TreeNonces): string {
    const noncesObject: Record<string, string> = {};
    for (const [txid, nonce] of nonces) {
        noncesObject[txid] = hex.encode(nonce.pubNonce);
    }
    return JSON.stringify(noncesObject);
}

function encodeMusig2Signatures(signatures: TreePartialSigs): string {
    const sigObject: Record<string, string> = {};
    for (const [txid, sig] of signatures) {
        sigObject[txid] = hex.encode(sig.encode());
    }
    return JSON.stringify(sigObject);
}

function decodeMusig2Nonces(str: string): TreeNonces {
    const noncesObject = JSON.parse(str);
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
        batchExpiry: string;
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
        treeNonces: string;
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

    export interface VtxoData {
        outpoint: {
            txid: string;
            vout: number;
        };
        amount: string;
        script: string;
        createdAt: string;
        expiresAt: string;
        commitmentTxids: string[];
        isPreconfirmed: boolean;
        isSwept: boolean;
        isUnrolled: boolean;
        isSpent: boolean;
        spentBy: string;
        settledBy?: string;
        arkTxid?: string;
    }

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
        return (
            error instanceof Error &&
            (error.name === "HeadersTimeoutError" ||
                error.name === "BodyTimeoutError" ||
                (error as any).code === "UND_ERR_HEADERS_TIMEOUT" ||
                (error as any).code === "UND_ERR_BODY_TIMEOUT")
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
