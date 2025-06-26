import { TxGraph, TxGraphChunk } from "../tree/txGraph";
import { Outpoint } from "../wallet";
import { TreeNonces, TreePartialSigs } from "../tree/signingSession";
import { hex } from "@scure/base";
import { PartialSig } from "../musig2";

// Define event types
export interface ArkEvent {
    type: "vtxo_created" | "vtxo_spent" | "vtxo_swept" | "vtxo_expired";
    data: {
        txid?: string;
        address?: string;
        amount?: number;
        roundTxid?: string;
        expireAt?: number;
    };
}

export type VtxoInput = {
    outpoint: Outpoint;
    tapscripts: string[];
};

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
    connectorsIndex: Map<string, Outpoint>; // `vtxoTxid:vtxoIndex` -> connectorOutpoint
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
    chunk: TxGraphChunk;
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

export interface ArkInfo {
    pubkey: string;
    vtxoTreeExpiry: bigint;
    unilateralExitDelay: bigint;
    roundInterval: bigint;
    network: string;
    dust: bigint;
    forfeitAddress: string;
    marketHour?: {
        start: number;
        end: number;
    };
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
    spentVtxos: Vtxo[];
    spendableVtxos: Vtxo[];
    hex: string;
}

export interface Vtxo {
    outpoint: Outpoint;
    amount: bigint;
    script: string;
    createdAt: bigint;
    expiresAt: bigint;
    commitmentTxid: string;
    preconfirmed: boolean;
    swept: boolean;
    redeemed: boolean;
    spent: boolean;
    spentBy: string;
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
    confirmRegistration(intentId: string): Promise<{ blindedCreds: string }>;
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
    getEventStream(signal: AbortSignal): AsyncIterableIterator<SettlementEvent>;
    getTransactionsStream(signal: AbortSignal): AsyncIterableIterator<{
        commitmentTx?: TxNotification;
        arkTx?: TxNotification;
    }>;
}

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

    async confirmRegistration(
        intentId: string
    ): Promise<{ blindedCreds: string }> {
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

        const data = await response.json();
        return { blindedCreds: data.blindedCreds };
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
        signal: AbortSignal
    ): AsyncIterableIterator<SettlementEvent> {
        const url = `${this.serverUrl}/v1/batch/events`;

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

                        try {
                            const data = JSON.parse(line);
                            const txNotification =
                                this.parseTransactionNotification(data.result);
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

                    // Keep the last partial line in the buffer
                    buffer = lines[lines.length - 1];
                }
            } catch (error) {
                if (error instanceof Error && error.name === "AbortError") {
                    break;
                }
                console.error("Transaction stream error:", error);
                throw error;
            }
        }
    }

    private toConnectorsIndex(
        connectorsIndex: ProtoTypes.RoundFinalizationEvent["connectorsIndex"]
    ): Map<string, Outpoint> {
        return new Map(
            Object.entries(connectorsIndex).map(([key, value]) => [
                key,
                { txid: value.txid, vout: value.vout },
            ])
        );
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
                connectorsIndex: this.toConnectorsIndex(
                    data.batchFinalization.connectorsIndex
                ),
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
            return {
                type: SettlementEventType.TreeTx,
                id: data.treeTx.id,
                topic: data.treeTx.topic,
                batchIndex: data.treeTx.batchIndex,
                chunk: {
                    txid: data.treeTx.txid,
                    tx: data.treeTx.tx,
                    children: data.treeTx.children,
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
                    spentVtxos: data.commitmentTx.spentVtxos.map((vtxo) => ({
                        outpoint: {
                            txid: vtxo.outpoint.txid,
                            vout: vtxo.outpoint.vout,
                        },
                        amount: BigInt(vtxo.amount),
                        script: vtxo.script,
                        createdAt: BigInt(vtxo.createdAt),
                        expiresAt: BigInt(vtxo.expiresAt),
                        commitmentTxid: vtxo.commitmentTxid,
                        preconfirmed: vtxo.preconfirmed,
                        swept: vtxo.swept,
                        redeemed: vtxo.redeemed,
                        spent: vtxo.spent,
                        spentBy: vtxo.spentBy,
                    })),
                    spendableVtxos: data.commitmentTx.spendableVtxos.map(
                        (vtxo) => ({
                            outpoint: {
                                txid: vtxo.outpoint.txid,
                                vout: vtxo.outpoint.vout,
                            },
                            amount: BigInt(vtxo.amount),
                            script: vtxo.script,
                            createdAt: BigInt(vtxo.createdAt),
                            expiresAt: BigInt(vtxo.expiresAt),
                            commitmentTxid: vtxo.commitmentTxid,
                            preconfirmed: vtxo.preconfirmed,
                            swept: vtxo.swept,
                            redeemed: vtxo.redeemed,
                            spent: vtxo.spent,
                            spentBy: vtxo.spentBy,
                        })
                    ),
                    hex: data.commitmentTx.hex,
                },
            };
        }

        if (data.arkTx) {
            return {
                arkTx: {
                    txid: data.arkTx.txid,
                    spentVtxos: data.arkTx.spentVtxos.map((vtxo) => ({
                        outpoint: {
                            txid: vtxo.outpoint.txid,
                            vout: vtxo.outpoint.vout,
                        },
                        amount: BigInt(vtxo.amount),
                        script: vtxo.script,
                        createdAt: BigInt(vtxo.createdAt),
                        expiresAt: BigInt(vtxo.expiresAt),
                        commitmentTxid: vtxo.commitmentTxid,
                        preconfirmed: vtxo.preconfirmed,
                        swept: vtxo.swept,
                        redeemed: vtxo.redeemed,
                        spent: vtxo.spent,
                        spentBy: vtxo.spentBy,
                    })),
                    spendableVtxos: data.arkTx.spendableVtxos.map((vtxo) => ({
                        outpoint: {
                            txid: vtxo.outpoint.txid,
                            vout: vtxo.outpoint.vout,
                        },
                        amount: BigInt(vtxo.amount),
                        script: vtxo.script,
                        createdAt: BigInt(vtxo.createdAt),
                        expiresAt: BigInt(vtxo.expiresAt),
                        commitmentTxid: vtxo.commitmentTxid,
                        preconfirmed: vtxo.preconfirmed,
                        swept: vtxo.swept,
                        redeemed: vtxo.redeemed,
                        spent: vtxo.spent,
                        spentBy: vtxo.spentBy,
                    })),
                    hex: data.arkTx.hex,
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
        forfeitAddress: string;
    }

    interface RoundFailed {
        id: string;
        reason: string;
    }

    export interface RoundFinalizationEvent {
        id: string;
        commitmentTx: string;
        connectorsIndex: {
            [key: string]: {
                txid: string;
                vout: number;
            };
        };
    }

    interface RoundFinalizedEvent {
        id: string;
        commitmentTxid: string;
    }

    interface RoundSigningEvent {
        id: string;
        cosignersPubkeys: string[];
        unsignedCommitmentTx: string;
    }

    interface RoundSigningNoncesGeneratedEvent {
        id: string;
        treeNonces: string;
    }

    interface TreeTxEvent {
        id: string;
        topic: string[];
        batchIndex: number;
        txid: string;
        tx: string;
        children: Record<number, string>;
    }

    interface TreeSignatureEvent {
        id: string;
        topic: string[];
        batchIndex: number;
        txid: string;
        signature: string;
    }

    interface VtxoData {
        outpoint: {
            txid: string;
            vout: number;
        };
        amount: string;
        script: string;
        createdAt: string;
        expiresAt: string;
        commitmentTxid: string;
        preconfirmed: boolean;
        swept: boolean;
        redeemed: boolean;
        spent: boolean;
        spentBy: string;
    }

    export interface EventData {
        batchStarted?: BatchStartedEvent;
        batchFailed?: RoundFailed;
        batchFinalization?: RoundFinalizationEvent;
        batchFinalized?: RoundFinalizedEvent;
        treeSigningStarted?: RoundSigningEvent;
        treeNoncesAggregated?: RoundSigningNoncesGeneratedEvent;
        treeTx?: TreeTxEvent;
        treeSignature?: TreeSignatureEvent;
    }

    export interface TransactionData {
        commitmentTx?: {
            txid: string;
            spentVtxos: VtxoData[];
            spendableVtxos: VtxoData[];
            hex: string;
        };
        arkTx?: {
            txid: string;
            spentVtxos: VtxoData[];
            spendableVtxos: VtxoData[];
            hex: string;
        };
    }
}
