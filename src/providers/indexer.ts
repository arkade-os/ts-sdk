import { Outpoint, VirtualCoin } from "../wallet";
import { hex } from "@scure/base";

export interface IndexerVtxo {
    outpoint: {
        txid: string;
        vout: number;
    };
    createdAt: bigint;
    expiresAt: bigint;
    amount: bigint;
    script: string;
    isLeaf: boolean;
    isSwept: boolean;
    isSpent: boolean;
    spentBy: string;
    commitmentTxid: string;
}

export interface IndexerBatch {
    totalOutputAmount: bigint;
    totalOutputVtxos: number;
    expiresAt: bigint;
    swept: boolean;
}

export interface IndexerNode {
    txid: string;
    parentTxid: string;
    level: number;
    levelIndex: number;
}

export interface IndexerOutpoint {
    txid: string;
    vout: number;
}

export interface IndexerChainedTx {
    txid: string;
    type:
        | "INDEXER_CHAINED_TX_TYPE_UNSPECIFIED"
        | "INDEXER_CHAINED_TX_TYPE_VIRTUAL"
        | "INDEXER_CHAINED_TX_TYPE_COMMITMENT";
}

export interface IndexerChain {
    txid: string;
    spends: IndexerChainedTx[];
    expiresAt: bigint;
}

export interface IndexerTxHistoryRecord {
    commitmentTxid: string;
    virtualTxid: string;
    type:
        | "INDEXER_TX_TYPE_UNSPECIFIED"
        | "INDEXER_TX_TYPE_RECEIVED"
        | "INDEXER_TX_TYPE_SENT";
    amount: bigint;
    createdAt: bigint;
    isSettled: boolean;
    settledBy: string;
}

export interface PageRequest {
    size?: number;
    index?: number;
}

export interface PageResponse {
    current: number;
    next: number;
    total: number;
}

export interface IndexerProvider {
    getVtxos(
        address: string,
        options?: {
            spendableOnly?: boolean;
            spentOnly?: boolean;
            page?: PageRequest;
        }
    ): Promise<{
        vtxos: IndexerVtxo[];
        page?: PageResponse;
    }>;

    getVirtualTxs(
        txids: string[],
        page?: PageRequest
    ): Promise<{
        txs: string[];
        page?: PageResponse;
    }>;

    getVtxoChain(
        outpoint: Outpoint,
        page?: PageRequest
    ): Promise<{
        chain: IndexerChain[];
        depth: number;
        rootCommitmentTxid: string;
        page?: PageResponse;
    }>;

    getTransactionHistory(
        address: string,
        options?: { startTime?: bigint; endTime?: bigint; page?: PageRequest }
    ): Promise<{
        history: IndexerTxHistoryRecord[];
        page?: PageResponse;
    }>;

    getCommitmentTx(txid: string): Promise<{
        startedAt: bigint;
        endedAt: bigint;
        batches: Record<string, IndexerBatch>;
        totalInputAmount: bigint;
        totalInputVtxos: number;
        totalOutputAmount: bigint;
        totalOutputVtxos: number;
    }>;

    getCommitmentTxLeaves(
        txid: string,
        page?: PageRequest
    ): Promise<{
        leaves: IndexerOutpoint[];
        page?: PageResponse;
    }>;

    getSweptCommitmentTx(txid: string): Promise<{
        sweptBy: string[];
    }>;

    getVtxoTree(
        batchOutpoint: Outpoint,
        page?: PageRequest
    ): Promise<{
        vtxoTree: IndexerNode[];
        page?: PageResponse;
    }>;

    getVtxoTreeLeaves(
        batchOutpoint: Outpoint,
        page?: PageRequest
    ): Promise<{
        leaves: IndexerOutpoint[];
        page?: PageResponse;
    }>;

    getConnectors(
        batchOutpoint: Outpoint,
        page?: PageRequest
    ): Promise<{
        connectors: IndexerNode[];
        page?: PageResponse;
    }>;

    getForfeitTxs(
        batchOutpoint: Outpoint,
        page?: PageRequest
    ): Promise<{
        txids: string[];
        page?: PageResponse;
    }>;
}

export class RestIndexerProvider implements IndexerProvider {
    constructor(public serverUrl: string) {}

    async getVtxos(
        address: string,
        options?: {
            spendableOnly?: boolean;
            spentOnly?: boolean;
            page?: PageRequest;
        }
    ): Promise<{ vtxos: IndexerVtxo[]; page?: PageResponse }> {
        let url = `${this.serverUrl}/v1/getVtxos/${address}`;

        const queryParams: string[] = [];
        if (options?.spendableOnly) {
            queryParams.push(`spendableOnly=${options.spendableOnly}`);
        }
        if (options?.spentOnly) {
            queryParams.push(`spentOnly=${options.spentOnly}`);
        }
        if (options?.page) {
            if (options.page.size) {
                queryParams.push(`page.size=${options.page.size}`);
            }
            if (options.page.index) {
                queryParams.push(`page.index=${options.page.index}`);
            }
        }

        if (queryParams.length > 0) {
            url += `?${queryParams.join("&")}`;
        }

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch VTXOs: ${response.statusText}`);
        }

        const data = await response.json();

        return {
            vtxos: data.vtxos.map((vtxo: any) => ({
                ...vtxo,
                createdAt: BigInt(vtxo.createdAt || 0),
                expiresAt: BigInt(vtxo.expiresAt || 0),
                amount: BigInt(vtxo.amount || 0),
            })),
            page: data.page,
        };
    }

    async getVirtualTxs(
        txids: string[],
        page?: PageRequest
    ): Promise<{ txs: string[]; page?: PageResponse }> {
        let url = `${this.serverUrl}/v1/virtualTx/${txids.join(",")}`;

        const queryParams: string[] = [];
        if (page) {
            if (page.size) {
                queryParams.push(`page.size=${page.size}`);
            }
            if (page.index) {
                queryParams.push(`page.index=${page.index}`);
            }
        }

        if (queryParams.length > 0) {
            url += `?${queryParams.join("&")}`;
        }

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(
                `Failed to fetch virtual transactions: ${response.statusText}`
            );
        }

        const data = await response.json();

        return {
            txs: data.txs || [],
            page: data.page,
        };
    }

    async getVtxoChain(
        outpoint: Outpoint,
        page?: PageRequest
    ): Promise<{
        chain: IndexerChain[];
        depth: number;
        rootCommitmentTxid: string;
        page?: PageResponse;
    }> {
        let url = `${this.serverUrl}/v1/vtxo/${outpoint.txid}/${outpoint.vout}/chain`;

        const queryParams: string[] = [];
        if (page) {
            if (page.size) {
                queryParams.push(`page.size=${page.size}`);
            }
            if (page.index) {
                queryParams.push(`page.index=${page.index}`);
            }
        }

        if (queryParams.length > 0) {
            url += `?${queryParams.join("&")}`;
        }

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(
                `Failed to fetch VTXO chain: ${response.statusText}`
            );
        }

        const data = await response.json();

        return {
            chain: (data.chain || []).map((chain: any) => ({
                ...chain,
                expiresAt: BigInt(chain.expiresAt || 0),
            })),
            depth: data.depth || 0,
            rootCommitmentTxid: data.rootCommitmentTxid || "",
            page: data.page,
        };
    }

    async getTransactionHistory(
        address: string,
        options?: { startTime?: bigint; endTime?: bigint; page?: PageRequest }
    ): Promise<{ history: IndexerTxHistoryRecord[]; page?: PageResponse }> {
        let url = `${this.serverUrl}/v1/history/${address}`;

        const queryParams: string[] = [];
        if (options?.startTime) {
            queryParams.push(`startTime=${options.startTime.toString()}`);
        }
        if (options?.endTime) {
            queryParams.push(`endTime=${options.endTime.toString()}`);
        }
        if (options?.page) {
            if (options.page.size) {
                queryParams.push(`page.size=${options.page.size}`);
            }
            if (options.page.index) {
                queryParams.push(`page.index=${options.page.index}`);
            }
        }

        if (queryParams.length > 0) {
            url += `?${queryParams.join("&")}`;
        }

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(
                `Failed to fetch transaction history: ${response.statusText}`
            );
        }

        const data = await response.json();

        return {
            history: (data.history || []).map((record: any) => ({
                ...record,
                amount: BigInt(record.amount || 0),
                createdAt: BigInt(record.createdAt || 0),
            })),
            page: data.page,
        };
    }

    async getCommitmentTx(txid: string): Promise<{
        startedAt: bigint;
        endedAt: bigint;
        batches: Record<string, IndexerBatch>;
        totalInputAmount: bigint;
        totalInputVtxos: number;
        totalOutputAmount: bigint;
        totalOutputVtxos: number;
    }> {
        const url = `${this.serverUrl}/v1/commitmentTx/${txid}`;

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(
                `Failed to fetch commitment transaction: ${response.statusText}`
            );
        }

        const data = await response.json();

        // Process batches to convert string values to BigInt
        const processedBatches: Record<string, IndexerBatch> = {};
        if (data.batches) {
            for (const [key, batch] of Object.entries(data.batches)) {
                const typedBatch = batch as any;
                processedBatches[key] = {
                    totalOutputAmount: BigInt(
                        typedBatch.totalOutputAmount || 0
                    ),
                    totalOutputVtxos: typedBatch.totalOutputVtxos || 0,
                    expiresAt: BigInt(typedBatch.expiresAt || 0),
                    swept: typedBatch.swept || false,
                };
            }
        }

        return {
            startedAt: BigInt(data.startedAt || 0),
            endedAt: BigInt(data.endedAt || 0),
            batches: processedBatches,
            totalInputAmount: BigInt(data.totalInputAmount || 0),
            totalInputVtxos: data.totalInputVtxos || 0,
            totalOutputAmount: BigInt(data.totalOutputAmount || 0),
            totalOutputVtxos: data.totalOutputVtxos || 0,
        };
    }

    async getCommitmentTxLeaves(
        txid: string,
        page?: PageRequest
    ): Promise<{ leaves: IndexerOutpoint[]; page?: PageResponse }> {
        let url = `${this.serverUrl}/v1/commitmentTx/${txid}/leaves`;

        const queryParams: string[] = [];
        if (page) {
            if (page.size) {
                queryParams.push(`page.size=${page.size}`);
            }
            if (page.index) {
                queryParams.push(`page.index=${page.index}`);
            }
        }

        if (queryParams.length > 0) {
            url += `?${queryParams.join("&")}`;
        }

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(
                `Failed to fetch commitment transaction leaves: ${response.statusText}`
            );
        }

        const data = await response.json();

        return {
            leaves: data.leaves || [],
            page: data.page,
        };
    }

    async getSweptCommitmentTx(txid: string): Promise<{ sweptBy: string[] }> {
        const url = `${this.serverUrl}/v1/commitmentTx/${txid}/swept`;

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(
                `Failed to fetch swept commitment transaction: ${response.statusText}`
            );
        }

        const data = await response.json();

        return {
            sweptBy: data.sweptBy || [],
        };
    }

    async getVtxoTree(
        batchOutpoint: Outpoint,
        page?: PageRequest
    ): Promise<{ vtxoTree: IndexerNode[]; page?: PageResponse }> {
        let url = `${this.serverUrl}/v1/batch/${batchOutpoint.txid}/${batchOutpoint.vout}/tree`;

        const queryParams: string[] = [];
        if (page) {
            if (page.size) {
                queryParams.push(`page.size=${page.size}`);
            }
            if (page.index) {
                queryParams.push(`page.index=${page.index}`);
            }
        }

        if (queryParams.length > 0) {
            url += `?${queryParams.join("&")}`;
        }

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(
                `Failed to fetch VTXO tree: ${response.statusText}`
            );
        }

        const data = await response.json();

        return {
            vtxoTree: data.vtxoTree || [],
            page: data.page,
        };
    }

    async getVtxoTreeLeaves(
        batchOutpoint: Outpoint,
        page?: PageRequest
    ): Promise<{ leaves: IndexerOutpoint[]; page?: PageResponse }> {
        let url = `${this.serverUrl}/v1/batch/${batchOutpoint.txid}/${batchOutpoint.vout}/tree/leaves`;

        const queryParams: string[] = [];
        if (page) {
            if (page.size) {
                queryParams.push(`page.size=${page.size}`);
            }
            if (page.index) {
                queryParams.push(`page.index=${page.index}`);
            }
        }

        if (queryParams.length > 0) {
            url += `?${queryParams.join("&")}`;
        }

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(
                `Failed to fetch VTXO tree leaves: ${response.statusText}`
            );
        }

        const data = await response.json();

        return {
            leaves: data.leaves || [],
            page: data.page,
        };
    }

    async getConnectors(
        batchOutpoint: Outpoint,
        page?: PageRequest
    ): Promise<{ connectors: IndexerNode[]; page?: PageResponse }> {
        let url = `${this.serverUrl}/v1/batch/${batchOutpoint.txid}/${batchOutpoint.vout}/connectors`;

        const queryParams: string[] = [];
        if (page) {
            if (page.size) {
                queryParams.push(`page.size=${page.size}`);
            }
            if (page.index) {
                queryParams.push(`page.index=${page.index}`);
            }
        }

        if (queryParams.length > 0) {
            url += `?${queryParams.join("&")}`;
        }

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(
                `Failed to fetch connectors: ${response.statusText}`
            );
        }

        const data = await response.json();

        return {
            connectors: data.connectors || [],
            page: data.page,
        };
    }

    async getForfeitTxs(
        batchOutpoint: Outpoint,
        page?: PageRequest
    ): Promise<{ txids: string[]; page?: PageResponse }> {
        let url = `${this.serverUrl}/v1/batch/${batchOutpoint.txid}/${batchOutpoint.vout}/forfeitTxs`;

        const queryParams: string[] = [];
        if (page) {
            if (page.size) {
                queryParams.push(`page.size=${page.size}`);
            }
            if (page.index) {
                queryParams.push(`page.index=${page.index}`);
            }
        }

        if (queryParams.length > 0) {
            url += `?${queryParams.join("&")}`;
        }

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(
                `Failed to fetch forfeit transactions: ${response.statusText}`
            );
        }

        const data = await response.json();

        return {
            txids: data.txids || [],
            page: data.page,
        };
    }
}
