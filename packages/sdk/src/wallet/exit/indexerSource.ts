import { base64 } from "@scure/base";
import { DEFAULT_PAGE_SIZE } from "../../contracts/constants";
import { ChainTx, IndexerProvider } from "../../providers/indexer";
import { Transaction } from "../../utils/transaction";
import { Outpoint } from "../index";
import { indexerPages } from "../vtxo";
import { ExitDataSource } from "./resolver";

/** Exit-data source backed by the Ark indexer. */
export class IndexerExitDataSource implements ExitDataSource {
    readonly name = "indexer";

    constructor(private readonly indexer: IndexerProvider) {}

    async getVtxoChain(vtxo: Outpoint): Promise<ChainTx[]> {
        const chain: ChainTx[] = [];
        for await (const { chain: page } of indexerPages((pageIndex) =>
            this.indexer.getVtxoChain(
                { txid: vtxo.txid, vout: vtxo.vout },
                { pageIndex, pageSize: DEFAULT_PAGE_SIZE },
            ),
        )) {
            chain.push(...page);
        }
        return chain;
    }

    async getVirtualTxs(txids: string[]): Promise<Map<string, string>> {
        const out = new Map<string, string>();
        for await (const { txs } of indexerPages((pageIndex) =>
            this.indexer.getVirtualTxs(txids, { pageIndex, pageSize: DEFAULT_PAGE_SIZE }),
        )) {
            for (const psbt of txs) {
                out.set(Transaction.fromPSBT(base64.decode(psbt)).id, psbt);
            }
        }
        return out;
    }
}
