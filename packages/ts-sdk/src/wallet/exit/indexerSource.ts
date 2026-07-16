import { base64 } from "@scure/base";
import { DEFAULT_PAGE_SIZE } from "../../contracts/constants";
import { ChainTx, IndexerProvider } from "../../providers/indexer";
import { Transaction } from "../../utils/transaction";
import { Outpoint } from "../index";
import { ExitDataSource } from "./resolver";

/**
 * Exit-data source backed by the Ark indexer. Behavior-preserving vs. the
 * pre-resolver code: the same paginated getVtxoChain / getVirtualTxs walks.
 */
export class IndexerExitDataSource implements ExitDataSource {
    readonly name = "indexer";

    constructor(private readonly indexer: IndexerProvider) {}

    async getVtxoChain(vtxo: Outpoint): Promise<ChainTx[]> {
        const chain: ChainTx[] = [];
        let pageIndex = 0;
        let hasMore = true;
        while (hasMore) {
            const { chain: page, page: meta } = await this.indexer.getVtxoChain(
                { txid: vtxo.txid, vout: vtxo.vout },
                { pageIndex, pageSize: DEFAULT_PAGE_SIZE },
            );
            chain.push(...page);
            hasMore = meta ? page.length === DEFAULT_PAGE_SIZE : false;
            pageIndex++;
        }
        return chain;
    }

    async getVirtualTxs(txids: string[]): Promise<Map<string, string>> {
        const out = new Map<string, string>();
        let pageIndex = 0;
        let hasMore = true;
        while (hasMore) {
            const { txs, page } = await this.indexer.getVirtualTxs(txids, {
                pageIndex,
                pageSize: DEFAULT_PAGE_SIZE,
            });
            for (const psbt of txs) {
                out.set(Transaction.fromPSBT(base64.decode(psbt)).id, psbt);
            }
            hasMore = page ? txs.length === DEFAULT_PAGE_SIZE : false;
            pageIndex++;
        }
        return out;
    }
}
