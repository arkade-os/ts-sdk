import { ArkTransaction, TxKey, TxType, VirtualCoin } from "../wallet";

type ExtendedArkTransaction = ArkTransaction & {
    tag: "offchain" | "onchain" | "boarding" | "exit";
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
export function buildTransactionHistory(
    vtxos: VirtualCoin[],
    allBoardingTxs: ArkTransaction[],
    commitmentsToIgnore: Set<string>
): ExtendedArkTransaction[] {
    const fromOldestVtxo = [...vtxos].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    );

    const sent: ExtendedArkTransaction[] = [];
    let received: ExtendedArkTransaction[] = [];

    // Track all settled VTXOs
    const settledBy = new Map<string, VirtualCoin[]>();

    for (const vtxo of fromOldestVtxo) {
        if (vtxo.settledBy) {
            const existing = settledBy.get(vtxo.settledBy) ?? [];
            settledBy.set(vtxo.settledBy, [...existing, vtxo]);
        }

        // In this part, we only handle VTXOs spent offchain
        if (vtxo.isSpent) {
            // The arkTxId is the outpoint.txid of the VTXO that spent this one
            if (vtxo.arkTxId) {
                const change = fromOldestVtxo.find(
                    (_) => _.txid === vtxo.arkTxId
                );

                if (change) {
                    // If there is already the outgoing amount for this change,
                    // there is nothing to do here
                    if (!sent.some((s) => s.key.arkTxid === change.txid)) {
                        // We want to find all the other VTXOs spent by the same transaction to
                        // calculate the full amount of the change.
                        const allSpent = fromOldestVtxo.filter(
                            (v) => v.arkTxId === change.txid
                        );
                        const spentAmount = allSpent.reduce(
                            (acc, v) => acc + v.value,
                            0
                        );

                        // This outgoing movement in the history will represent the event that created the change
                        sent.push({
                            key: { ...txKey, arkTxid: change.txid },
                            tag: "offchain",
                            type: TxType.TxSent,
                            amount: spentAmount - change.value,
                            settled: true,
                            createdAt: change.createdAt.getTime(),
                        });
                    }
                } else {
                    // Spent onchain, but never received a change for it
                    // TODO: test it with a real tx like NOW!
                }
            }
        }

        // If not preconfirmed and all its commitments are to be ignored,
        // the VTXO is not present in the history
        if (
            vtxo.virtualStatus.state !== "preconfirmed" &&
            vtxo.virtualStatus.commitmentTxIds?.every((c) =>
                commitmentsToIgnore.has(c)
            )
        ) {
            continue;
        }

        // This list represnts all the commitment IDs in this VTXO which
        // settle one or more VTXOs
        const commitmentIdsSettling =
            vtxo.virtualStatus.commitmentTxIds?.filter((_) =>
                settledBy.has(_)
            ) ?? [];

        if (commitmentIdsSettling.length > 0 && vtxo.status.isLeaf) {
            // This VTXO is the result of coin renewal.
            // A normal renewal doesn't affect the user's balance and we don't show
            // it in the history.
            // But if the renewal returns less satoshis than the original one,
            // it means that an exit occurred (onchain) and this case must be shown
            // as a SENT movement in the history.
            for (const commitmentTxid of commitmentIdsSettling) {
                // Collect all the VTXOs that settled in this commitment to ensure
                // we consider the whole renewed amount.
                const settled = fromOldestVtxo.filter(
                    (v) => v.settledBy === commitmentTxid
                );

                if (settled.length === 0) continue; // this is impossible

                const settledAmount = settled.reduce(
                    (acc, v) => acc + v.value,
                    0
                );
                // TODO: look for all the vtxos involved in the settledBy (they have same commitmentIds)
                if (vtxo.value < settledAmount) {
                    // We renewed an amount and got back less: this is an exit!
                    sent.push({
                        key: { ...txKey, commitmentTxid },
                        tag: "exit",
                        type: TxType.TxSent,
                        amount: settledAmount - vtxo.value,
                        settled: true,
                        createdAt: vtxo.createdAt.getTime(),
                    });
                }
            }
        } else {
            // If it's not a renewal, it must be shown on the UI because it affects the balance.
            // Ensure that it only appears once. Note that the spending scenario was handled above.
            const foundInSpent = sent.find((s) => s.key.arkTxid === vtxo.txid);
            if (!foundInSpent) {
                received.push({
                    key: { ...txKey, arkTxid: vtxo.txid },
                    tag: "offchain",
                    type: TxType.TxReceived,
                    amount: vtxo.value,
                    settled: true,
                    createdAt: vtxo.createdAt.getTime(),
                });
            }
        }
    }

    // Boardings are always inbound amounts, and we only hide the ones to ignore.
    const boardingTx = allBoardingTxs
        .filter((tx) => !commitmentsToIgnore.has(tx.key.commitmentTxid))
        .map((tx) => ({ ...tx, tag: "boarding" }));

    const sorted = [...boardingTx, ...sent, ...received].sort(
        (a, b) => b.createdAt - a.createdAt
    );

    return sorted as ExtendedArkTransaction[];
}
