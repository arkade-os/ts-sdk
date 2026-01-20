import { ArkTransaction, TxKey, TxType, VirtualCoin } from "../wallet";

type ExtendedArkTransaction = ArkTransaction & {
    tag: "offchain" | "boarding" | "exit" | "batch";
};
const txKey: TxKey = {
    commitmentTxid: "",
    boardingTxid: "",
    arkTxid: "",
};

/**
 * Builds the transaction history by analyzing virtual coins (VTXOs), boarding transactions, and ignored commitments.
 * History is sorted from newest to oldest and is composed only of SENT and RECEIVED transactions.
 *
 * @param {VirtualCoin[]} vtxos - An array of virtual coins representing the user's transactions and balances.
 * @param {ArkTransaction[]} allBoardingTxs - An array of boarding transactions to include in the history.
 * @param {Set<string>} commitmentsToIgnore - A set of commitment IDs that should be excluded from processing.
 * @return {ExtendedArkTransaction[]} A sorted array of extended Ark transactions, representing the transaction history.
 */
export async function buildTransactionHistory(
    vtxos: VirtualCoin[],
    allBoardingTxs: ArkTransaction[],
    commitmentsToIgnore: Set<string>,
    getTxCreatedAt?: (txid: string) => Promise<number>
): Promise<ExtendedArkTransaction[]> {
    const fromOldestVtxo = [...vtxos].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    );

    const sent: ExtendedArkTransaction[] = [];
    let received: ExtendedArkTransaction[] = [];

    for (const vtxo of fromOldestVtxo) {
        if (vtxo.status.isLeaf) {
            // If this vtxo is a leaf and it's not the settlement of a boarding or there's no vtxo refreshed by it,
            // it's translated into a received batch transaction
            if (
                !commitmentsToIgnore.has(
                    vtxo.virtualStatus.commitmentTxIds![0]
                ) &&
                fromOldestVtxo.filter(
                    (v) =>
                        v.settledBy === vtxo.virtualStatus.commitmentTxIds![0]
                ).length === 0
            ) {
                received.push({
                    key: {
                        ...txKey,
                        commitmentTxid: vtxo.virtualStatus.commitmentTxIds![0],
                    },
                    tag: "batch",
                    type: TxType.TxReceived,
                    amount: vtxo.value,
                    settled: vtxo.status.isLeaf || vtxo.isSpent!,
                    createdAt: vtxo.createdAt.getTime(),
                });
            }
        } else if (
            fromOldestVtxo.filter((v) => v.arkTxId === vtxo.txid).length === 0
        ) {
            // If this vtxo is preconfirmed and does not spend any other vtxos,
            // it's translated into a received offchain transaction
            received.push({
                key: { ...txKey, arkTxid: vtxo.txid! },
                tag: "offchain",
                type: TxType.TxReceived,
                amount: vtxo.value,
                settled: vtxo.status.isLeaf || vtxo.isSpent!,
                createdAt: vtxo.createdAt.getTime(),
            });
        }

        // If the vtxo is spent, it's translated into a sent transaction unless:
        // - it's been refreshed (we don't want to add any record in this case)
        // - a sent transaction has been already added to avoid duplicates (can happen if many vtxos have been spent in the same tx or forfeited in the same batch)
        if (vtxo.isSpent) {
            // If the vtxo is spent offchain, it's translated into offchain sent tx
            if (
                vtxo.arkTxId &&
                !sent.some((s) => s.key.arkTxid === vtxo.arkTxId)
            ) {
                const changes = fromOldestVtxo.filter(
                    (_) => _.txid === vtxo.arkTxId
                );

                // We want to find all the other VTXOs spent by the same transaction to
                // calculate the full amount of the change.
                const allSpent = fromOldestVtxo.filter(
                    (v) => v.arkTxId === vtxo.arkTxId
                );
                const spentAmount = allSpent.reduce(
                    (acc, v) => acc + v.value,
                    0
                );

                let txAmount = 0;
                let txTime = 0;
                if (changes.length > 0) {
                    const changeAmount = changes.reduce(
                        (acc, v) => acc + v.value,
                        0
                    );
                    txAmount = spentAmount - changeAmount;
                    txTime = changes[0].createdAt.getTime();
                } else {
                    txAmount = spentAmount;
                    // TODO: fetch the vtxo with /v1/indexer/vtxos?outpoints=<vtxo.arkTxid:0> to know when the tx was made
                    txTime = getTxCreatedAt
                        ? await getTxCreatedAt(vtxo.arkTxId!)
                        : vtxo.createdAt.getTime() + 1;
                }

                sent.push({
                    key: { ...txKey, arkTxid: vtxo.arkTxId },
                    tag: "offchain",
                    type: TxType.TxSent,
                    amount: txAmount,
                    settled: true,
                    createdAt: txTime,
                });
            }

            // If the vtxo is forfeited in a batch and the total sum of forfeited vtxos is bigger than the sum of new vtxos,
            // it's translated into an exit sent tx
            if (
                vtxo.settledBy &&
                !commitmentsToIgnore.has(vtxo.settledBy) &&
                !sent.some((s) => s.key.commitmentTxid === vtxo.settledBy)
            ) {
                const changes = fromOldestVtxo.filter(
                    (v) =>
                        v.status.isLeaf &&
                        v.virtualStatus.commitmentTxIds?.every(
                            (_) => vtxo.settledBy === _
                        )
                );

                const forfeitVtxos = fromOldestVtxo.filter(
                    (v) => v.settledBy === vtxo.settledBy
                );
                const forfeitAmount = forfeitVtxos.reduce(
                    (acc, v) => acc + v.value,
                    0
                );

                if (changes.length > 0) {
                    const settledAmount = changes.reduce(
                        (acc, v) => acc + v.value,
                        0
                    );

                    // forfeitAmount > settledAmount --> collaborative exit with offchain change
                    // TODO: make this support fees!
                    if (forfeitAmount > settledAmount) {
                        sent.push({
                            key: { ...txKey, commitmentTxid: vtxo.settledBy },
                            tag: "exit",
                            type: TxType.TxSent,
                            amount: forfeitAmount - settledAmount,
                            settled: true,
                            createdAt: changes[0].createdAt.getTime(),
                        });
                    }
                } else {
                    // forfeitAmount > 0 && settledAmount == 0 --> collaborative exit without any offchain change
                    sent.push({
                        key: { ...txKey, commitmentTxid: vtxo.settledBy },
                        tag: "exit",
                        type: TxType.TxSent,
                        amount: forfeitAmount,
                        settled: true,
                        // TODO: fetch commitment tx with /v1/indexer/commitmentTx/<commitmentTxid> to know when the tx was made
                        createdAt: vtxo.createdAt.getTime() + 1,
                    });
                }
            }
        }
    }

    // Boardings are always inbound amounts, and we only hide the ones to ignore.
    const boardingTx = allBoardingTxs.map((tx) => ({ ...tx, tag: "boarding" }));

    const sorted = [...boardingTx, ...sent, ...received].sort(
        (a, b) => b.createdAt - a.createdAt
    );

    return sorted as ExtendedArkTransaction[];
}
