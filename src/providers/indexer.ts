import { Outpoint, VirtualCoin } from "../wallet";

export interface IndexerProvider {
    GetCommitmentTx(txid: string): Promise<ProtoTypes.CommitmentTx>;
    GetCommitmentTxConnectors(
        txid: string,
        opts?: {
            pageIndex?: number;
            pageSize?: number;
        }
    ): Promise<ProtoTypes.Node[]>;
    GetCommitmentTxForfeitTxs(
        txid: string,
        opts?: {
            pageIndex?: number;
            pageSize?: number;
        }
    ): Promise<string[]>;
    GetCommitmentTxLeaves(
        txid: string,
        opts?: {
            pageIndex?: number;
            pageSize?: number;
        }
    ): Promise<Outpoint[]>;
    GetCommitmentTxSwept(txid: string): Promise<string[]>;
    GetTransactionHistory(
        address: string,
        opts?: {
            startTime?: number;
            endTime?: number;
            pageIndex?: number;
            pageSize?: number;
        }
    ): Promise<ProtoTypes.TxHistoryRecord[]>;
    GetSubscription(
        subscriptionId: string,
        abortSignal: AbortSignal
    ): AsyncIterableIterator<{
        scripts: string[];
        newVtxos: VirtualCoin[];
        spentVtxos: VirtualCoin[];
    }>;
    GetVirtualTxs(txids: string[]): Promise<string[]>;
    GetVtxoChain(outpoint: Outpoint): Promise<{
        rootCommitmentTxid: string;
        chain: ProtoTypes.Chain[];
        depth: number;
    }>;
    GetVtxos(
        addresses: string[],
        opts?: {
            spendableOnly?: boolean;
            spentOnly?: boolean;
            pageIndex?: number;
            pageSize?: number;
        }
    ): Promise<VirtualCoin[]>;
    GetVtxosByOutpoints(oupoints: Outpoint[]): Promise<VirtualCoin[]>;
    GetVtxoTree(batch: Outpoint): Promise<ProtoTypes.Node[]>;
    GetVtxoTreeLeaves(batch: Outpoint): Promise<Outpoint[]>;
    SubscribeForScripts(
        scripts: string[],
        subscriptionId?: string
    ): Promise<string>;
    UnsubscribeForScripts(
        subscriptionId: string,
        scripts?: string[]
    ): Promise<void>;
}

export class RestIndexerProvider implements IndexerProvider {
    constructor(public serverUrl: string) {}

    async GetCommitmentTx(txid: string): Promise<ProtoTypes.CommitmentTx> {
        const url = `${this.serverUrl}/v1/commitmentTx/${txid}`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch commitment tx: ${res.statusText}`);
        }

        const data = (await res.json()) as ProtoTypes.CommitmentTx;
        return data;
    }

    async GetCommitmentTxConnectors(
        txid: string,
        opts?: {
            pageIndex?: number;
            pageSize?: number;
        }
    ): Promise<ProtoTypes.Node[]> {
        let url = `${this.serverUrl}/v1/commitmentTx/${txid}/connectors`;
        if (opts) {
            url += "?";
            if (opts.pageIndex !== undefined)
                url += `page.index=${opts.pageIndex}&`;
            if (opts.pageSize !== undefined)
                url += `page.index=${opts.pageSize}&`;
        }
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(
                `Failed to fetch commitment tx connectors: ${res.statusText}`
            );
        }
        const data = (await res.json()) as {
            connectors: ProtoTypes.Node[];
        };
        return data.connectors;
    }

    async GetCommitmentTxForfeitTxs(
        txid: string,
        opts?: {
            pageIndex?: number;
            pageSize?: number;
        }
    ): Promise<string[]> {
        let url = `${this.serverUrl}/v1/commitmentTx/${txid}/forfeitTxs`;
        if (opts) {
            url += "?";
            if (opts.pageIndex !== undefined)
                url += `page.index=${opts.pageIndex}&`;
            if (opts.pageSize !== undefined)
                url += `page.index=${opts.pageSize}&`;
        }
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(
                `Failed to fetch commitment tx forfeitTxs: ${res.statusText}`
            );
        }
        const data = (await res.json()) as { txids: string[] };
        return data.txids;
    }

    async GetCommitmentTxLeaves(
        txid: string,
        opts?: {
            pageIndex?: number;
            pageSize?: number;
        }
    ): Promise<Outpoint[]> {
        let url = `${this.serverUrl}/v1/commitmentTx/${txid}/leaves`;
        if (opts) {
            url += "?";
            if (opts.pageIndex !== undefined)
                url += `page.index=${opts.pageIndex}&`;
            if (opts.pageSize !== undefined)
                url += `page.index=${opts.pageSize}&`;
        }
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(
                `Failed to fetch commitment tx leaves: ${res.statusText}`
            );
        }
        const data = (await res.json()) as { leaves: Outpoint[] };
        return data.leaves;
    }

    async GetCommitmentTxSwept(txid: string): Promise<string[]> {
        const url = `${this.serverUrl}/v1/commitmentTx/${txid}/swept`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(
                `Failed to fetch swept commitment tx: ${res.statusText}`
            );
        }
        const data = (await res.json()) as { sweptBy: string[] };
        return data.sweptBy;
    }

    async *GetSubscription(subscriptionId: string, abortSignal: AbortSignal) {
        const url = `${this.serverUrl}/v1/script/subscription/${subscriptionId}`;

        while (!abortSignal.aborted) {
            try {
                const res = await fetch(url, {
                    headers: {
                        Accept: "application/json",
                    },
                });

                if (!res.ok) {
                    throw new Error(
                        `Unexpected status ${res.status} when subscribing to address updates`
                    );
                }

                if (!res.body) {
                    throw new Error("Response body is null");
                }

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

                while (!abortSignal.aborted) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");

                    for (let i = 0; i < lines.length - 1; i++) {
                        const line = lines[i].trim();
                        if (!line) continue;

                        try {
                            const data = JSON.parse(line);
                            if ("result" in data) {
                                yield {
                                    scripts: data.result.scripts || [],
                                    newVtxos: (data.result.newVtxos || []).map(
                                        convertVtxo
                                    ),
                                    spentVtxos: (
                                        data.result.spentVtxos || []
                                    ).map(convertVtxo),
                                };
                            }
                        } catch (err) {
                            console.error(
                                "Failed to parse address update:",
                                err
                            );
                            throw err;
                        }
                    }

                    buffer = lines[lines.length - 1];
                }
            } catch (error) {
                console.error("Address subscription error:", error);
                throw error;
            }
        }
    }

    async GetTransactionHistory(
        address: string,
        opts?: {
            startTime?: number;
            endTime?: number;
            pageIndex?: number;
            pageSize?: number;
        }
    ): Promise<ProtoTypes.TxHistoryRecord[]> {
        let url = `${this.serverUrl}/v1/history/${address}`;
        if (opts) {
            url += "?";
            if (opts.startTime !== undefined)
                url += `startTime=${opts.startTime}&`;
            if (opts.endTime !== undefined) url += `endTime=${opts.endTime}&`;
            if (opts.pageIndex !== undefined)
                url += `page.index=${opts.pageIndex}&`;
            if (opts.pageSize !== undefined)
                url += `page.index=${opts.pageSize}&`;
        }
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch tx history: ${res.statusText}`);
        }
        const data = (await res.json()) as {
            history: ProtoTypes.TxHistoryRecord[];
        };
        return data.history;
    }

    async GetVirtualTxs(txids: string[]): Promise<string[]> {
        const url = `${this.serverUrl}/v1/virtualTx/${txids.join(",")}`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch virtual txs: ${res.statusText}`);
        }
        const data = (await res.json()) as { txs: string[] };
        return data.txs;
    }

    async GetVtxoChain(outpoint: Outpoint): Promise<{
        chain: ProtoTypes.Chain[];
        depth: number;
        rootCommitmentTxid: string;
    }> {
        const url = `${this.serverUrl}/v1/vtxo/${outpoint.txid}/${outpoint.vout}/chain`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch tx history: ${res.statusText}`);
        }
        const data = (await res.json()) as {
            rootCommitmentTxid: string;
            chain: ProtoTypes.Chain[];
            depth: number;
        };
        return data;
    }

    async GetVtxos(
        addresses: string[],
        opts?: {
            spendableOnly?: boolean;
            spentOnly?: boolean;
            pageIndex?: number;
            pageSize?: number;
        }
    ): Promise<VirtualCoin[]> {
        let url = `${this.serverUrl}/v1/getVtxos/${addresses.join(",")}`;
        if (opts) {
            url += "?";
            if (opts.spendableOnly !== undefined)
                url += `spendableOnly=${opts.spendableOnly}&`;
            if (opts.spentOnly !== undefined)
                url += `spentOnly=${opts.spentOnly}&`;
            if (opts.pageIndex !== undefined)
                url += `page.index=${opts.pageIndex}&`;
            if (opts.pageSize !== undefined)
                url += `page.index=${opts.pageSize}&`;
        }
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch vtxos: ${res.statusText}`);
        }
        const data = (await res.json()) as { vtxos: ProtoTypes.Vtxo[] };
        return data.vtxos.map(convertVtxo);
    }

    async GetVtxosByOutpoints(oupoints: Outpoint[]): Promise<VirtualCoin[]> {
        const url = `${this.serverUrl}/v1/getVtxosByOutpoint/${oupoints.join(",")}`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(
                `Failed to fetch vtxos by outpoints: ${res.statusText}`
            );
        }
        const data = (await res.json()) as { vtxos: ProtoTypes.Vtxo[] };
        return data.vtxos.map(convertVtxo);
    }

    async GetVtxoTree(outpoint: Outpoint): Promise<ProtoTypes.Node[]> {
        const url = `${this.serverUrl}/v1/batch/${outpoint.txid}/${outpoint.vout}/tree`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch virtual txs: ${res.statusText}`);
        }
        const data = (await res.json()) as {
            vtxoTree: ProtoTypes.Node[];
        };
        return data.vtxoTree;
    }

    async GetVtxoTreeLeaves(outpoint: Outpoint): Promise<Outpoint[]> {
        const url = `${this.serverUrl}/v1/batch/${outpoint.txid}/${outpoint.vout}/tree/leaves`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch virtual txs: ${res.statusText}`);
        }
        const data = (await res.json()) as { leaves: Outpoint[] };
        return data.leaves;
    }

    async SubscribeForScripts(
        scripts: string[],
        subscriptionId?: string
    ): Promise<string> {
        const url = `${this.serverUrl}/v1/script/subscribe`;
        const res = await fetch(url, {
            headers: {
                Accept: "application/json",
            },
            method: "POST",
            body: JSON.stringify({ scripts, subscriptionId }),
        });
        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`Failed to subscribe to scripts: ${errorText}`);
        }
        const data = await res.json();
        if (!data.subscriptionId) throw new Error(`Subscription ID not found`);
        return data.subscriptionId;
    }

    async UnsubscribeForScripts(
        subscriptionId: string,
        scripts?: string[]
    ): Promise<void> {
        const url = `${this.serverUrl}/v1/script/unsubscribe`;
        const res = await fetch(url, {
            headers: {
                Accept: "application/json",
            },
            method: "POST",
            body: JSON.stringify({ subscriptionId, scripts }),
        });
        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`Failed to unsubscribe to scripts: ${errorText}`);
        }
    }
}

function convertVtxo(vtxo: ProtoTypes.Vtxo): VirtualCoin {
    return {
        txid: vtxo.outpoint.txid,
        vout: vtxo.outpoint.vout,
        value: Number(vtxo.amount),
        status: {
            confirmed: !!vtxo.commitmentTxid,
        },
        virtualStatus: {
            state: vtxo.isLeaf ? "settled" : "pending",
            batchTxID: vtxo.commitmentTxid,
            batchExpiry: vtxo.expiresAt ? Number(vtxo.expiresAt) : undefined,
        },
        spentBy: vtxo.spentBy,
        createdAt: new Date(Number(vtxo.createdAt) * 1000),
    };
}

// ProtoTypes namespace defines unexported types representing the raw data received from the server
namespace ProtoTypes {
    enum TxType {
        UNKNOWN = 0,
        DEPOSIT = 1,
        WITHDRAWAL = 2,
    }

    enum ChainedTxType {
        UNKNOWN = 0,
        VIRTUAL = 1,
        COMMITMENT = 2,
    }

    interface Batch {
        totalOutputAmount: bigint;
        totalOutputVtxos: number;
        expiresAt: number;
        swept: boolean;
    }

    export interface Chain {
        txid: string;
        spends: ChainedTx[];
        expiresAt: number;
    }

    interface ChainedTx {
        txid: string;
        type: ChainedTxType;
    }

    export interface CommitmentTx {
        startedAt: number;
        endedAt: number;
        batches: { [key: string]: Batch };
        totalInputAmount: bigint;
        totalInputVtxos: number;
        totalOutputAmount: bigint;
        totalOutputVtxos: number;
    }

    export interface Node {
        txid: string;
        parentTxid: string;
        level: number;
        levelIndex: number;
    }

    export interface TxHistoryRecord {
        // Only one of these will be present at a time
        commitmentTxid?: string;
        virtualTxid?: string;

        type: TxType;
        amount: bigint;
        createdAt: number;
        isSettled: boolean;
        settledBy: string;
    }

    export interface Vtxo {
        outpoint: Outpoint;
        createdAt: string;
        expiresAt: string;
        amount: string;
        script: string;
        isLeaf: boolean;
        isSwept: boolean;
        isSpent: boolean;
        spentBy: string;
        commitmentTxid: string;
    }
}
