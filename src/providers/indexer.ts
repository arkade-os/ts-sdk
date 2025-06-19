import { ArkTransaction, TxType } from "@arklabs/wallet-sdk";
import { Outpoint, VirtualCoin } from "../wallet";

export interface IndexerProvider {
    GetCommitmentTx(txid: string): Promise<Response.CommitmentTx>;
    GetCommitmentTxConnectors(
        txid: string,
        opts?: {
            pageIndex?: number;
            pageSize?: number;
        }
    ): Promise<Response.Node[]>;
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
    ): Promise<ArkTransaction[]>;
    GetSubscription(
        subscriptionId: string,
        abortSignal: AbortSignal
    ): AsyncIterableIterator<{
        scripts: string[];
        newVtxos: VirtualCoin[];
        spentVtxos: VirtualCoin[];
    }>;
    GetVirtualCoins(address: string): Promise<{
        spendableVtxos: VirtualCoin[];
        spentVtxos: VirtualCoin[];
    }>;
    GetVirtualTxs(txids: string[]): Promise<string[]>;
    GetVtxoChain(vtxoOutpoint: Outpoint): Promise<Response.VtxoChain>;
    GetVtxos(
        addresses: string[],
        opts?: {
            spendableOnly?: boolean;
            spentOnly?: boolean;
            pageIndex?: number;
            pageSize?: number;
        }
    ): Promise<VirtualCoin[]>;
    GetVtxosByOutpoints(vtxoOupoints: Outpoint[]): Promise<VirtualCoin[]>;
    GetVtxoTree(batchOutpoint: Outpoint): Promise<Response.Node[]>;
    GetVtxoTreeLeaves(batchOutpoint: Outpoint): Promise<Outpoint[]>;
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

    async GetCommitmentTx(txid: string): Promise<Response.CommitmentTx> {
        const url = `${this.serverUrl}/v1/commitmentTx/${txid}`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch commitment tx: ${res.statusText}`);
        }
        const data = await res.json();
        if (!Response.isCommitmentTx(data)) {
            throw new Error("Invalid commitment tx data received");
        }
        return data;
    }

    async GetCommitmentTxConnectors(
        txid: string,
        opts?: {
            pageIndex?: number;
            pageSize?: number;
        }
    ): Promise<Response.Node[]> {
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
        const data = await res.json();
        if (!Response.isNodeArray(data.connectors)) {
            throw new Error("Invalid commitment tx connectors data received");
        }
        return data.connectors;
    }

    async GetCommitmentTxForfeitTxs(
        txid: string,
        opts?: {
            pageIndex?: number;
            pageSize?: number;
        }
    ): Promise<Response.Txid[]> {
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
        const data = await res.json();
        if (!Response.isTxidArray(data.txids)) {
            throw new Error("Invalid commitment tx forfeitTxs data received");
        }
        return data.txids;
    }

    async GetCommitmentTxLeaves(
        txid: string,
        opts?: {
            pageIndex?: number;
            pageSize?: number;
        }
    ): Promise<Response.Outp[]> {
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
        const data = await res.json();
        if (!Response.isOutpointArray(data.leaves)) {
            throw new Error("Invalid commitment tx leaves data received");
        }
        return data.leaves;
    }

    async GetCommitmentTxSwept(txid: string): Promise<Response.Txid[]> {
        const url = `${this.serverUrl}/v1/commitmentTx/${txid}/swept`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(
                `Failed to fetch commitment tx swept: ${res.statusText}`
            );
        }
        const data = await res.json();
        if (!Response.isTxidArray(data.sweptBy)) {
            throw new Error("Invalid commitment tx swept data received");
        }
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
    ): Promise<ArkTransaction[]> {
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
        const data = await res.json();
        if (!Response.isTxHistoryRecordArray(data.history)) {
            throw new Error("Invalid transaction history data received");
        }
        return data.history.map(convertTransaction);
    }

    async GetVirtualCoins(address: string): Promise<{
        spendableVtxos: VirtualCoin[];
        spentVtxos: VirtualCoin[];
    }> {
        const vtxos = await this.GetVtxos([address]);
        return {
            spendableVtxos: vtxos.filter(({ spentBy }) => !Boolean(spentBy)),
            spentVtxos: vtxos.filter(({ spentBy }) => Boolean(spentBy)),
        };
    }

    async GetVirtualTxs(txids: string[]): Promise<Response.Txid[]> {
        const url = `${this.serverUrl}/v1/virtualTx/${txids.join(",")}`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch virtual txs: ${res.statusText}`);
        }
        const data = await res.json();
        if (!Response.isTxidArray(data.txs)) {
            throw new Error("Invalid virtual txs data received");
        }
        return data.txs;
    }

    async GetVtxoChain(vtxoOutpoint: Outpoint): Promise<Response.VtxoChain> {
        const url = `${this.serverUrl}/v1/vtxo/${vtxoOutpoint.txid}/${vtxoOutpoint.vout}/chain`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch vtxo chain: ${res.statusText}`);
        }
        const data = await res.json();
        if (!Response.isVtxoChain(data)) {
            throw new Error("Invalid vtxo chain data received");
        }
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
        const data = await res.json();
        if (!Response.isVtxoArray(data.vtxos)) {
            console.error("Invalid vtxos data received:", data);
            throw new Error("Invalid vtxos data received");
        }
        return data.vtxos.map(convertVtxo);
    }

    async GetVtxosByOutpoints(
        vtxoOutpoints: Outpoint[]
    ): Promise<VirtualCoin[]> {
        const url = `${this.serverUrl}/v1/getVtxosByOutpoint/${vtxoOutpoints.join(",")}`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(
                `Failed to fetch vtxos by outpoints: ${res.statusText}`
            );
        }
        const data = await res.json();
        if (!Response.isVtxoArray(data.vtxos)) {
            throw new Error("Invalid vtxos by outpoints data received");
        }
        return data.vtxos.map(convertVtxo);
    }

    async GetVtxoTree(batchOutpoint: Outpoint): Promise<Response.Node[]> {
        const url = `${this.serverUrl}/v1/batch/${batchOutpoint.txid}/${batchOutpoint.vout}/tree`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch vtxo tree: ${res.statusText}`);
        }
        const data = await res.json();
        if (!Response.isNodeArray(data.vtxoTree)) {
            throw new Error("Invalid vtxo tree data received");
        }
        return data.vtxoTree;
    }

    async GetVtxoTreeLeaves(batchOutpoint: Outpoint): Promise<Outpoint[]> {
        const url = `${this.serverUrl}/v1/batch/${batchOutpoint.txid}/${batchOutpoint.vout}/tree/leaves`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(
                `Failed to fetch vtxo tree leaves: ${res.statusText}`
            );
        }
        const data = await res.json();
        if (!Response.isOutpointArray(data.leaves)) {
            throw new Error("Invalid vtxos tree leaves data received");
        }
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

function convertVtxo(vtxo: Response.Vtxo): VirtualCoin {
    return {
        txid: vtxo.outpoint.txid,
        vout: vtxo.outpoint.vout,
        value: Number(vtxo.amount),
        status: {
            confirmed: !!vtxo.commitmentTxid,
        },
        virtualStatus: {
            state: vtxo.isSwept ? "swept" : vtxo.isLeaf ? "settled" : "pending",
            batchTxID: vtxo.commitmentTxid,
            batchExpiry: vtxo.expiresAt ? Number(vtxo.expiresAt) : undefined,
        },
        spentBy: vtxo.spentBy ?? "",
        createdAt: new Date(Number(vtxo.createdAt) * 1000),
    };
}

function convertType(type: Response.TxType): TxType {
    switch (type) {
        case Response.TxType.INDEXER_TX_TYPE_RECEIVED:
            return TxType.TxReceived;
        case Response.TxType.INDEXER_TX_TYPE_SENT:
            return TxType.TxSent;
        default:
            throw new Error(`Unknown transaction type: ${type}`);
    }
}

function convertTransaction(tx: Response.TxHistoryRecord): ArkTransaction {
    return {
        key: {
            boardingTxid: "",
            roundTxid: tx.commitmentTxid ?? "",
            redeemTxid: tx.virtualTxid ?? "",
        },
        amount: Number(tx.amount),
        type: convertType(tx.type),
        settled: tx.isSettled,
        createdAt: parseInt(tx.createdAt) * 1000,
    };
}

// Response namespace defines unexported types representing the raw data received from the server
namespace Response {
    export enum TxType {
        INDEXER_TX_TYPE_UNSPECIFIED = "INDEXER_TX_TYPE_UNSPECIFIED",
        INDEXER_TX_TYPE_RECEIVED = "INDEXER_TX_TYPE_RECEIVED",
        INDEXER_TX_TYPE_SENT = "INDEXER_TX_TYPE_SENT",
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

    interface Chain {
        txid: string;
        spends: ChainedTx[];
        expiresAt: number;
    }
    function isChain(data: any): data is Chain {
        return (
            typeof data === "object" &&
            typeof data.txid === "string" &&
            Array.isArray(data.spends) &&
            data.spends.every(isChainedTx) &&
            typeof data.expiresAt === "number"
        );
    }

    interface ChainedTx {
        txid: string;
        type: ChainedTxType;
    }
    function isChainedTx(data: any): data is ChainedTx {
        return (
            typeof data === "object" &&
            typeof data.txid === "string" &&
            Object.values(ChainedTxType).includes(data.type)
        );
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
    export function isCommitmentTx(data: any): data is CommitmentTx {
        return (
            typeof data === "object" &&
            typeof data.startedAt === "number" &&
            typeof data.endedAt === "number" &&
            typeof data.totalInputAmount === "bigint" &&
            typeof data.totalInputVtxos === "number" &&
            typeof data.totalOutputAmount === "bigint" &&
            typeof data.totalOutputVtxos === "number" &&
            typeof data.batches === "object" &&
            Object.values(data.batches).every(
                (batch: any) =>
                    typeof batch === "object" &&
                    typeof batch.totalOutputAmount === "bigint" &&
                    typeof batch.totalOutputVtxos === "number" &&
                    typeof batch.expiresAt === "number" &&
                    typeof batch.swept === "boolean"
            )
        );
    }

    export type Outp = Outpoint;
    export function isOutpoint(data: any): data is Outp {
        return (
            typeof data === "object" &&
            typeof data.txid === "string" &&
            typeof data.vout === "number"
        );
    }
    export function isOutpointArray(data: any): data is Outp[] {
        return Array.isArray(data) && data.every(isOutpoint);
    }

    export interface Node {
        txid: string;
        parentTxid: string;
        level: number;
        levelIndex: number;
    }
    function isNode(data: any): data is Node {
        return (
            typeof data === "object" &&
            typeof data.txid === "string" &&
            typeof data.parentTxid === "string" &&
            typeof data.level === "number" &&
            typeof data.levelIndex === "number"
        );
    }
    export function isNodeArray(data: any): data is Node[] {
        return Array.isArray(data) && data.every(isNode);
    }

    export interface TxHistoryRecord {
        // Only one of these will be present at a time
        commitmentTxid?: string;
        virtualTxid?: string;

        type: TxType;
        amount: string;
        createdAt: string;
        isSettled: boolean;
        settledBy: string;
    }
    function isTxHistoryRecord(data: any): data is TxHistoryRecord {
        return (
            typeof data === "object" &&
            typeof data.amount === "string" &&
            typeof data.createdAt === "string" &&
            typeof data.isSettled === "boolean" &&
            typeof data.settledBy === "string" &&
            Object.values(TxType).includes(data.type) &&
            ((!data.commitmentTxid && typeof data.virtualTxid === "string") ||
                (typeof data.commitmentTxid === "string" && !data.virtualTxid))
        );
    }
    export function isTxHistoryRecordArray(
        data: any
    ): data is TxHistoryRecord[] {
        return Array.isArray(data) && data.every(isTxHistoryRecord);
    }

    export type Txid = string;
    function isTxid(data: any): data is Txid {
        return typeof data === "string";
    }
    export function isTxidArray(data: any): data is Txid[] {
        return Array.isArray(data) && data.every(isTxid);
    }

    export interface Vtxo {
        outpoint: Outpoint;
        createdAt: string;
        expiresAt: string | null;
        amount: string;
        script: string;
        isLeaf: boolean;
        isSwept: boolean;
        isSpent: boolean;
        spentBy: string | null;
        commitmentTxid: string;
    }
    function isVtxo(data: any): data is Vtxo {
        return (
            typeof data === "object" &&
            isOutpoint(data.outpoint) &&
            typeof data.createdAt === "string" &&
            (typeof data.expiresAt === "string" ||
                typeof data.expiresAt === "object") &&
            typeof data.amount === "string" &&
            typeof data.script === "string" &&
            typeof data.isLeaf === "boolean" &&
            typeof data.isSwept === "boolean" &&
            typeof data.isSpent === "boolean" &&
            (typeof data.spentBy === "string" ||
                typeof data.spentBy === "object") &&
            typeof data.commitmentTxid === "string"
        );
    }
    export function isVtxoArray(data: any): data is Vtxo[] {
        return Array.isArray(data) && data.every(isVtxo);
    }

    export interface VtxoChain {
        chain: Chain[];
        depth: number;
        rootCommitmentTxid: string;
    }
    export function isVtxoChain(data: any): data is VtxoChain {
        return (
            typeof data === "object" &&
            Array.isArray(data.chain) &&
            data.chain.every(isChain) &&
            typeof data.depth === "number" &&
            typeof data.rootCommitmentTxid === "string"
        );
    }
}
