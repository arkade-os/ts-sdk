import { Outpoint, VirtualCoin } from "../wallet";
import { isFetchTimeoutError } from "./ark";

export type PaginationOptions = {
    pageIndex?: number;
    pageSize?: number;
};

export enum IndexerTxType {
    INDEXER_TX_TYPE_UNSPECIFIED = 0,
    INDEXER_TX_TYPE_RECEIVED = 1,
    INDEXER_TX_TYPE_SENT = 2,
}

export enum ChainTxType {
    UNSPECIFIED = "INDEXER_CHAINED_TX_TYPE_UNSPECIFIED",
    COMMITMENT = "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
    ARK = "INDEXER_CHAINED_TX_TYPE_ARK",
    TREE = "INDEXER_CHAINED_TX_TYPE_TREE",
    CHECKPOINT = "INDEXER_CHAINED_TX_TYPE_CHECKPOINT",
}

export interface PageResponse {
    current: number;
    next: number;
    total: number;
}

export interface Batch {
    totalOutputAmount: string;
    totalOutputVtxos: number;
    expiresAt: string;
    swept: boolean;
}

export interface ChainTx {
    txid: string;
    expiresAt: string;
    type: ChainTxType;
    spends: string[]; // txids of the transactions in the chain used as input of the current tx
}

export interface CommitmentTx {
    startedAt: string;
    endedAt: string;
    batches: { [key: string]: Batch };
    totalInputAmount: string;
    totalInputVtxos: number;
    totalOutputAmount: string;
    totalOutputVtxos: number;
}

export interface Tx {
    txid: string;
    children: Record<number, string>;
}

export interface TxHistoryRecord {
    commitmentTxid?: string;
    virtualTxid?: string;
    type: IndexerTxType;
    amount: string;
    createdAt: string;
    isSettled: boolean;
    settledBy: string;
}

export interface Vtxo {
    outpoint: Outpoint;
    createdAt: string;
    expiresAt: string | null;
    amount: string;
    script: string;
    isPreconfirmed: boolean;
    isSwept: boolean;
    isUnrolled: boolean;
    isSpent: boolean;
    spentBy: string | null;
    commitmentTxids: string[];
    settledBy?: string;
    arkTxid?: string;
}

export interface VtxoChain {
    chain: ChainTx[];
    page?: PageResponse;
}

export interface SubscriptionResponse {
    txid?: string;
    scripts: string[];
    newVtxos: VirtualCoin[];
    spentVtxos: VirtualCoin[];
    tx?: string;
    checkpointTxs?: Record<string, { txid: string; tx: string }>;
}

export interface IndexerProvider {
    getVtxoTree(
        batchOutpoint: Outpoint,
        opts?: PaginationOptions
    ): Promise<{ vtxoTree: Tx[]; page?: PageResponse }>;
    getVtxoTreeLeaves(
        batchOutpoint: Outpoint,
        opts?: PaginationOptions
    ): Promise<{ leaves: Outpoint[]; page?: PageResponse }>;
    getBatchSweepTransactions(
        batchOutpoint: Outpoint
    ): Promise<{ sweptBy: string[] }>;
    getCommitmentTx(txid: string): Promise<CommitmentTx>;
    getCommitmentTxConnectors(
        txid: string,
        opts?: PaginationOptions
    ): Promise<{ connectors: Tx[]; page?: PageResponse }>;
    getCommitmentTxForfeitTxs(
        txid: string,
        opts?: PaginationOptions
    ): Promise<{ txids: string[]; page?: PageResponse }>;
    getSubscription(
        subscriptionId: string,
        abortSignal: AbortSignal
    ): AsyncIterableIterator<SubscriptionResponse>;
    getVirtualTxs(
        txids: string[],
        opts?: PaginationOptions
    ): Promise<{ txs: string[]; page?: PageResponse }>;
    getVtxoChain(
        vtxoOutpoint: Outpoint,
        opts?: PaginationOptions
    ): Promise<VtxoChain>;
    getVtxos(
        opts?: PaginationOptions & {
            scripts?: string[];
            outpoints?: Outpoint[];
            spendableOnly?: boolean;
            spentOnly?: boolean;
            recoverableOnly?: boolean;
        }
    ): Promise<{ vtxos: VirtualCoin[]; page?: PageResponse }>;
    subscribeForScripts(
        scripts: string[],
        subscriptionId?: string
    ): Promise<string>;
    unsubscribeForScripts(
        subscriptionId: string,
        scripts?: string[]
    ): Promise<void>;
}

/**
 * REST-based Indexer provider implementation.
 * @see https://buf.build/arkade-os/arkd/docs/main:ark.v1#ark.v1.IndexerService
 * @example
 * ```typescript
 * const provider = new RestIndexerProvider('https://ark.indexer.example.com');
 * const commitmentTx = await provider.getCommitmentTx("6686af8f3be3517880821f62e6c3d749b9d6713736a1d8e229a55daa659446b2");
 * ```
 */
export class RestIndexerProvider implements IndexerProvider {
    constructor(public serverUrl: string) {}

    async getVtxoTree(
        batchOutpoint: Outpoint,
        opts?: PaginationOptions
    ): Promise<{ vtxoTree: Tx[]; page?: PageResponse }> {
        let url = `${this.serverUrl}/v1/batch/${batchOutpoint.txid}/${batchOutpoint.vout}/tree`;
        const params = new URLSearchParams();
        if (opts) {
            if (opts.pageIndex !== undefined)
                params.append("page.index", opts.pageIndex.toString());
            if (opts.pageSize !== undefined)
                params.append("page.size", opts.pageSize.toString());
        }
        if (params.toString()) {
            url += "?" + params.toString();
        }
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch vtxo tree: ${res.statusText}`);
        }
        const data = await res.json();
        if (!Response.isVtxoTreeResponse(data)) {
            throw new Error("Invalid vtxo tree data received");
        }

        data.vtxoTree.forEach((tx) => {
            tx.children = Object.fromEntries(
                Object.entries(tx.children).map(([key, value]) => [
                    Number(key),
                    value,
                ])
            );
        });
        return data;
    }

    async getVtxoTreeLeaves(
        batchOutpoint: Outpoint,
        opts?: PaginationOptions
    ): Promise<{ leaves: Outpoint[]; page?: PageResponse }> {
        let url = `${this.serverUrl}/v1/batch/${batchOutpoint.txid}/${batchOutpoint.vout}/tree/leaves`;
        const params = new URLSearchParams();
        if (opts) {
            if (opts.pageIndex !== undefined)
                params.append("page.index", opts.pageIndex.toString());
            if (opts.pageSize !== undefined)
                params.append("page.size", opts.pageSize.toString());
        }
        if (params.toString()) {
            url += "?" + params.toString();
        }
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(
                `Failed to fetch vtxo tree leaves: ${res.statusText}`
            );
        }
        const data = await res.json();
        if (!Response.isVtxoTreeLeavesResponse(data)) {
            throw new Error("Invalid vtxos tree leaves data received");
        }
        return data;
    }

    async getBatchSweepTransactions(
        batchOutpoint: Outpoint
    ): Promise<{ sweptBy: string[] }> {
        const url = `${this.serverUrl}/v1/batch/${batchOutpoint.txid}/${batchOutpoint.vout}/sweepTxs`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(
                `Failed to fetch batch sweep transactions: ${res.statusText}`
            );
        }
        const data = await res.json();
        if (!Response.isBatchSweepTransactionsResponse(data)) {
            throw new Error("Invalid batch sweep transactions data received");
        }
        return data;
    }

    async getCommitmentTx(txid: string): Promise<CommitmentTx> {
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

    async getCommitmentTxConnectors(
        txid: string,
        opts?: PaginationOptions
    ): Promise<{ connectors: Tx[]; page?: PageResponse }> {
        let url = `${this.serverUrl}/v1/commitmentTx/${txid}/connectors`;
        const params = new URLSearchParams();
        if (opts) {
            if (opts.pageIndex !== undefined)
                params.append("page.index", opts.pageIndex.toString());
            if (opts.pageSize !== undefined)
                params.append("page.size", opts.pageSize.toString());
        }
        if (params.toString()) {
            url += "?" + params.toString();
        }
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(
                `Failed to fetch commitment tx connectors: ${res.statusText}`
            );
        }
        const data = await res.json();
        if (!Response.isConnectorsResponse(data)) {
            throw new Error("Invalid commitment tx connectors data received");
        }

        data.connectors.forEach((tx) => {
            tx.children = Object.fromEntries(
                Object.entries(tx.children).map(([key, value]) => [
                    Number(key),
                    value,
                ])
            );
        });
        return data;
    }

    async getCommitmentTxForfeitTxs(
        txid: string,
        opts?: PaginationOptions
    ): Promise<{ txids: string[]; page?: PageResponse }> {
        let url = `${this.serverUrl}/v1/commitmentTx/${txid}/forfeitTxs`;
        const params = new URLSearchParams();
        if (opts) {
            if (opts.pageIndex !== undefined)
                params.append("page.index", opts.pageIndex.toString());
            if (opts.pageSize !== undefined)
                params.append("page.size", opts.pageSize.toString());
        }
        if (params.toString()) {
            url += "?" + params.toString();
        }
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(
                `Failed to fetch commitment tx forfeitTxs: ${res.statusText}`
            );
        }
        const data = await res.json();
        if (!Response.isForfeitTxsResponse(data)) {
            throw new Error("Invalid commitment tx forfeitTxs data received");
        }
        return data;
    }

    async *getSubscription(subscriptionId: string, abortSignal: AbortSignal) {
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

                        const data = JSON.parse(line);
                        if ("result" in data) {
                            yield {
                                txid: data.result.txid,
                                scripts: data.result.scripts || [],
                                newVtxos: (data.result.newVtxos || []).map(
                                    convertVtxo
                                ),
                                spentVtxos: (data.result.spentVtxos || []).map(
                                    convertVtxo
                                ),
                                tx: data.result.tx,
                                checkpointTxs: data.result.checkpointTxs,
                            };
                        }
                    }

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

                console.error("Subscription error:", error);
                throw error;
            }
        }
    }

    async getVirtualTxs(
        txids: string[],
        opts?: PaginationOptions
    ): Promise<{ txs: string[]; page?: PageResponse }> {
        let url = `${this.serverUrl}/v1/virtualTx/${txids.join(",")}`;
        const params = new URLSearchParams();
        if (opts) {
            if (opts.pageIndex !== undefined)
                params.append("page.index", opts.pageIndex.toString());
            if (opts.pageSize !== undefined)
                params.append("page.size", opts.pageSize.toString());
        }
        if (params.toString()) {
            url += "?" + params.toString();
        }
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch virtual txs: ${res.statusText}`);
        }
        const data = await res.json();
        if (!Response.isVirtualTxsResponse(data)) {
            throw new Error("Invalid virtual txs data received");
        }
        return data;
    }

    async getVtxoChain(
        vtxoOutpoint: Outpoint,
        opts?: PaginationOptions
    ): Promise<VtxoChain> {
        let url = `${this.serverUrl}/v1/vtxo/${vtxoOutpoint.txid}/${vtxoOutpoint.vout}/chain`;
        const params = new URLSearchParams();
        if (opts) {
            if (opts.pageIndex !== undefined)
                params.append("page.index", opts.pageIndex.toString());
            if (opts.pageSize !== undefined)
                params.append("page.size", opts.pageSize.toString());
        }
        if (params.toString()) {
            url += "?" + params.toString();
        }
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch vtxo chain: ${res.statusText}`);
        }
        const data = await res.json();
        if (!Response.isVtxoChainResponse(data)) {
            throw new Error("Invalid vtxo chain data received");
        }
        return data;
    }

    async getVtxos(
        opts?: PaginationOptions & {
            scripts?: string[];
            outpoints?: Outpoint[];
            spendableOnly?: boolean;
            spentOnly?: boolean;
            recoverableOnly?: boolean;
        }
    ): Promise<{ vtxos: VirtualCoin[]; page?: PageResponse }> {
        // scripts and outpoints are mutually exclusive
        if (opts?.scripts && opts?.outpoints) {
            throw new Error(
                "scripts and outpoints are mutually exclusive options"
            );
        }

        if (!opts?.scripts && !opts?.outpoints) {
            throw new Error("Either scripts or outpoints must be provided");
        }

        let url = `${this.serverUrl}/v1/vtxos`;
        const params = new URLSearchParams();

        // Handle scripts with multi collection format
        if (opts?.scripts && opts.scripts.length > 0) {
            opts.scripts.forEach((script) => {
                params.append("scripts", script);
            });
        }

        // Handle outpoints with multi collection format
        if (opts?.outpoints && opts.outpoints.length > 0) {
            opts.outpoints.forEach((outpoint) => {
                params.append("outpoints", `${outpoint.txid}:${outpoint.vout}`);
            });
        }

        if (opts) {
            if (opts.spendableOnly !== undefined)
                params.append("spendableOnly", opts.spendableOnly.toString());
            if (opts.spentOnly !== undefined)
                params.append("spentOnly", opts.spentOnly.toString());
            if (opts.recoverableOnly !== undefined)
                params.append(
                    "recoverableOnly",
                    opts.recoverableOnly.toString()
                );
            if (opts.pageIndex !== undefined)
                params.append("page.index", opts.pageIndex.toString());
            if (opts.pageSize !== undefined)
                params.append("page.size", opts.pageSize.toString());
        }
        if (params.toString()) {
            url += "?" + params.toString();
        }
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch vtxos: ${res.statusText}`);
        }
        const data = await res.json();
        if (!Response.isVtxosResponse(data)) {
            throw new Error("Invalid vtxos data received");
        }
        return {
            vtxos: data.vtxos.map(convertVtxo),
            page: data.page,
        };
    }

    async subscribeForScripts(
        scripts: string[],
        subscriptionId?: string
    ): Promise<string> {
        const url = `${this.serverUrl}/v1/script/subscribe`;
        const res = await fetch(url, {
            headers: {
                "Content-Type": "application/json",
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

    async unsubscribeForScripts(
        subscriptionId: string,
        scripts?: string[]
    ): Promise<void> {
        const url = `${this.serverUrl}/v1/script/unsubscribe`;
        const res = await fetch(url, {
            headers: {
                "Content-Type": "application/json",
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

function convertVtxo(vtxo: Vtxo): VirtualCoin {
    return {
        txid: vtxo.outpoint.txid,
        vout: vtxo.outpoint.vout,
        value: Number(vtxo.amount),
        status: {
            confirmed: !vtxo.isSwept && !vtxo.isPreconfirmed,
        },
        virtualStatus: {
            state: vtxo.isSwept
                ? "swept"
                : vtxo.isPreconfirmed
                  ? "preconfirmed"
                  : "settled",
            commitmentTxIds: vtxo.commitmentTxids,
            batchExpiry: vtxo.expiresAt
                ? Number(vtxo.expiresAt) * 1000
                : undefined,
        },
        spentBy: vtxo.spentBy ?? "",
        settledBy: vtxo.settledBy,
        arkTxId: vtxo.arkTxid,
        createdAt: new Date(Number(vtxo.createdAt) * 1000),
        isUnrolled: vtxo.isUnrolled,
    };
}

// Unexported namespace for type guards only
namespace Response {
    function isBatch(data: any): data is Batch {
        return (
            typeof data === "object" &&
            typeof data.totalOutputAmount === "string" &&
            typeof data.totalOutputVtxos === "number" &&
            typeof data.expiresAt === "string" &&
            typeof data.swept === "boolean"
        );
    }

    function isChain(data: any): data is ChainTx {
        return (
            typeof data === "object" &&
            typeof data.txid === "string" &&
            typeof data.expiresAt === "string" &&
            Object.values(ChainTxType).includes(data.type) &&
            Array.isArray(data.spends) &&
            data.spends.every((spend: any) => typeof spend === "string")
        );
    }

    export function isCommitmentTx(data: any): data is CommitmentTx {
        return (
            typeof data === "object" &&
            typeof data.startedAt === "string" &&
            typeof data.endedAt === "string" &&
            typeof data.totalInputAmount === "string" &&
            typeof data.totalInputVtxos === "number" &&
            typeof data.totalOutputAmount === "string" &&
            typeof data.totalOutputVtxos === "number" &&
            typeof data.batches === "object" &&
            Object.values(data.batches).every(isBatch)
        );
    }

    export function isOutpoint(data: any): data is Outpoint {
        return (
            typeof data === "object" &&
            typeof data.txid === "string" &&
            typeof data.vout === "number"
        );
    }

    export function isOutpointArray(data: any): data is Outpoint[] {
        return Array.isArray(data) && data.every(isOutpoint);
    }

    function isTx(data: any): data is Tx {
        return (
            typeof data === "object" &&
            typeof data.txid === "string" &&
            typeof data.children === "object" &&
            Object.values(data.children).every(isTxid) &&
            Object.keys(data.children).every((k) => Number.isInteger(Number(k)))
        );
    }

    export function isTxsArray(data: any): data is Tx[] {
        return Array.isArray(data) && data.every(isTx);
    }

    function isTxHistoryRecord(data: any): data is TxHistoryRecord {
        return (
            typeof data === "object" &&
            typeof data.amount === "string" &&
            typeof data.createdAt === "string" &&
            typeof data.isSettled === "boolean" &&
            typeof data.settledBy === "string" &&
            Object.values(IndexerTxType).includes(data.type) &&
            ((!data.commitmentTxid && typeof data.virtualTxid === "string") ||
                (typeof data.commitmentTxid === "string" && !data.virtualTxid))
        );
    }

    export function isTxHistoryRecordArray(
        data: any
    ): data is TxHistoryRecord[] {
        return Array.isArray(data) && data.every(isTxHistoryRecord);
    }

    function isTxid(data: any): data is string {
        return typeof data === "string" && data.length === 64;
    }

    export function isTxidArray(data: any): data is string[] {
        return Array.isArray(data) && data.every(isTxid);
    }

    function isVtxo(data: any): data is Vtxo {
        return (
            typeof data === "object" &&
            isOutpoint(data.outpoint) &&
            typeof data.createdAt === "string" &&
            typeof data.expiresAt === "string" &&
            typeof data.amount === "string" &&
            typeof data.script === "string" &&
            typeof data.isPreconfirmed === "boolean" &&
            typeof data.isSwept === "boolean" &&
            typeof data.isUnrolled === "boolean" &&
            typeof data.isSpent === "boolean" &&
            (!data.spentBy || typeof data.spentBy === "string") &&
            (!data.settledBy || typeof data.settledBy === "string") &&
            (!data.arkTxid || typeof data.arkTxid === "string") &&
            Array.isArray(data.commitmentTxids) &&
            data.commitmentTxids.every(isTxid)
        );
    }

    function isPageResponse(data: any): data is PageResponse {
        return (
            typeof data === "object" &&
            typeof data.current === "number" &&
            typeof data.next === "number" &&
            typeof data.total === "number"
        );
    }

    export function isVtxoTreeResponse(
        data: any
    ): data is { vtxoTree: Tx[]; page?: PageResponse } {
        return (
            typeof data === "object" &&
            Array.isArray(data.vtxoTree) &&
            data.vtxoTree.every(isTx) &&
            (!data.page || isPageResponse(data.page))
        );
    }

    export function isVtxoTreeLeavesResponse(
        data: any
    ): data is { leaves: Outpoint[]; page?: PageResponse } {
        return (
            typeof data === "object" &&
            Array.isArray(data.leaves) &&
            data.leaves.every(isOutpoint) &&
            (!data.page || isPageResponse(data.page))
        );
    }

    export function isConnectorsResponse(
        data: any
    ): data is { connectors: Tx[]; page?: PageResponse } {
        return (
            typeof data === "object" &&
            Array.isArray(data.connectors) &&
            data.connectors.every(isTx) &&
            (!data.page || isPageResponse(data.page))
        );
    }

    export function isForfeitTxsResponse(
        data: any
    ): data is { txids: string[]; page?: PageResponse } {
        return (
            typeof data === "object" &&
            Array.isArray(data.txids) &&
            data.txids.every(isTxid) &&
            (!data.page || isPageResponse(data.page))
        );
    }

    export function isSweptCommitmentTxResponse(
        data: any
    ): data is { sweptBy: string[] } {
        return (
            typeof data === "object" &&
            Array.isArray(data.sweptBy) &&
            data.sweptBy.every(isTxid)
        );
    }

    export function isBatchSweepTransactionsResponse(
        data: any
    ): data is { sweptBy: string[] } {
        return (
            typeof data === "object" &&
            Array.isArray(data.sweptBy) &&
            data.sweptBy.every(isTxid)
        );
    }

    export function isVirtualTxsResponse(
        data: any
    ): data is { txs: string[]; page?: PageResponse } {
        return (
            typeof data === "object" &&
            Array.isArray(data.txs) &&
            data.txs.every((tx: any) => typeof tx === "string") &&
            (!data.page || isPageResponse(data.page))
        );
    }

    export function isVtxoChainResponse(data: any): data is VtxoChain {
        return (
            typeof data === "object" &&
            Array.isArray(data.chain) &&
            data.chain.every(isChain) &&
            (!data.page || isPageResponse(data.page))
        );
    }

    export function isVtxosResponse(
        data: any
    ): data is { vtxos: Vtxo[]; page?: PageResponse } {
        return (
            typeof data === "object" &&
            Array.isArray(data.vtxos) &&
            data.vtxos.every(isVtxo) &&
            (!data.page || isPageResponse(data.page))
        );
    }
}
