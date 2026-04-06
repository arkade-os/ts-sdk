import { base64, hex } from "@scure/base";
import type { IndexerProvider } from "../providers/indexer";
import { ChainTxType } from "../providers/indexer";
import type { Outpoint, VirtualCoin } from "../wallet";
import type { ExitData, ExitDataRepository } from "./exitDataStore";
import { collectExitData } from "./exitDataStore";
import type { TxTreeNode } from "../tree/txTree";
import { Transaction } from "../utils/transaction";

function buildTreeNodes(txids: string[], txs: string[]): TxTreeNode[] {
    const parsed = new Map<string, Transaction>();
    for (let i = 0; i < txids.length; i++) {
        parsed.set(txids[i], Transaction.fromPSBT(base64.decode(txs[i])));
    }

    const childrenByParent = new Map<string, Record<number, string>>();
    for (const txid of txids) {
        childrenByParent.set(txid, {});
    }

    for (const [childTxid, tx] of parsed) {
        for (let inputIndex = 0; inputIndex < tx.inputsLength; inputIndex++) {
            const input = tx.getInput(inputIndex);
            if (!input.txid) continue;
            const parentTxid = hex.encode(input.txid);
            if (!parsed.has(parentTxid)) continue;
            const parentChildren = childrenByParent.get(parentTxid)!;
            parentChildren[input.index ?? 0] = childTxid;
        }
    }

    return txids.map((txid, index) => ({
        txid,
        tx: txs[index],
        children: childrenByParent.get(txid) ?? {},
    }));
}

export async function buildExitDataForVtxo(
    vtxo: VirtualCoin,
    indexer: IndexerProvider
): Promise<ExitData> {
    const outpoint: Outpoint = { txid: vtxo.txid, vout: vtxo.vout };
    const { chain } = await indexer.getVtxoChain(outpoint);

    const virtualTxids = chain
        .filter((entry) => entry.type !== ChainTxType.COMMITMENT)
        .map((entry) => entry.txid);

    const { txs } =
        virtualTxids.length > 0
            ? await indexer.getVirtualTxs(virtualTxids)
            : { txs: [] };

    if (txs.length !== virtualTxids.length) {
        throw new Error(
            `Virtual tx count mismatch while collecting exit data: expected ${virtualTxids.length}, got ${txs.length}`
        );
    }

    const virtualTxMap = Object.fromEntries(
        virtualTxids.map((txid, index) => [txid, txs[index]])
    );

    return collectExitData(
        vtxo,
        chain,
        virtualTxMap,
        buildTreeNodes(virtualTxids, txs)
    );
}

export async function buildExitDataForVtxos(
    vtxos: VirtualCoin[],
    indexer: IndexerProvider
): Promise<ExitData[]> {
    return Promise.all(
        vtxos.map((vtxo) => buildExitDataForVtxo(vtxo, indexer))
    );
}

export async function syncExitData(
    vtxos: VirtualCoin[],
    indexer: IndexerProvider,
    repo: ExitDataRepository
): Promise<void> {
    const all = await buildExitDataForVtxos(vtxos, indexer);
    for (const entry of all) {
        await repo.saveExitData(entry);
    }
}
