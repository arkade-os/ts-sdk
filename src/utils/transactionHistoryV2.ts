import { ArkTransaction, TxKey, TxType, VirtualCoin } from "../wallet";

type ExtendedArkTransaction = ArkTransaction & {
    tag: "offchain" | "onchain" | "boarding" | "exit";
};
const txKey: TxKey = {
    commitmentTxid: "",
    boardingTxid: "",
    arkTxid: "",
};

export function transactionHistoryV2(
    vtxos: VirtualCoin[],
    allBoardingTxs: ArkTransaction[],
    commitmentsToIgnore: Set<string>
): ExtendedArkTransaction[] {
    const fromOldestVtxo = [...vtxos].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    );

    const sent: ExtendedArkTransaction[] = [];
    let received: ExtendedArkTransaction[] = [];
    const settled = new Set<string>();
    const used = new Set<string>();
    const settledBy = new Map<string, VirtualCoin[]>();
    const alreadySettled = new Set<string>();
    const changes = new Map<string, number>();
    const swept = new Set<string>();

    for (const vtxo of fromOldestVtxo) {
        if (
            vtxo.virtualStatus.commitmentTxIds?.every((c) =>
                commitmentsToIgnore.has(c)
            )
        ) {
            continue;
        }

        if (vtxo.settledBy) {
            const existing = settledBy.get(vtxo.settledBy) ?? [];
            settledBy.set(vtxo.settledBy, [...existing, vtxo]);
        }

        const commitmentIdsSettling =
            vtxo.virtualStatus.commitmentTxIds?.filter(
                (_) => !commitmentsToIgnore.has(_) && settledBy.has(_)
            ) ?? [];

        // Case 1 - spent
        if (vtxo.isSpent) {
            if (vtxo.arkTxId) {
                // txid is the outpoint.txid
                const change = fromOldestVtxo.find(
                    (_) => _.txid === vtxo.arkTxId
                );

                if (change) {
                    if (!used.has(change.txid)) {
                        // Offchain
                        const allSpent = fromOldestVtxo.filter(
                            (v) => v.arkTxId === change.txid
                        );
                        const spentAmount = allSpent.reduce(
                            (acc, v) => acc + v.value,
                            0
                        );

                        const changeLeft =
                            (changes.get(change.txid) ?? spentAmount) -
                            vtxo.value;
                        changes.set(change.txid, changeLeft);

                        // settlements do not appear in tx history
                        if (
                            commitmentIdsSettling.length === 0 &&
                            !used.has(vtxo.txid)
                        ) {
                            received.push({
                                key: { ...txKey, arkTxid: vtxo.txid },
                                tag: "offchain",
                                type: TxType.TxReceived,
                                amount: vtxo.value,
                                settled: true,
                                createdAt: vtxo.createdAt.getTime(),
                            });
                        }
                        sent.push({
                            key: { ...txKey, arkTxid: change.txid },
                            tag: "offchain",
                            type: TxType.TxSent,
                            amount: spentAmount - change.value,
                            settled: true,
                            createdAt: change.createdAt.getTime(),
                        });
                        used.add(change.txid);
                    } else {
                        // already seen but could still be enough amount to spend
                        // Offchain
                        const allSpent = fromOldestVtxo.filter(
                            (v) => v.arkTxId === change.txid
                        );
                        const spentAmount = allSpent.reduce(
                            (acc, v) => acc + v.value,
                            0
                        );

                        const changeLeft =
                            (changes.get(change.txid) ?? spentAmount) -
                            vtxo.value;
                        changes.set(change.txid, changeLeft);

                        if (changeLeft >= 0) {
                            if (!used.has(vtxo.txid)) {
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
                } else {
                    // Onchain
                    // it should be safe to ignore it
                }
            } else if (!changes.has(vtxo.txid) && !swept.has(vtxo.txid)) {
                received.push({
                    key: { ...txKey, arkTxid: vtxo.txid },
                    tag: "offchain",
                    type: TxType.TxReceived,
                    amount: vtxo.value,
                    settled: true,
                    createdAt: vtxo.createdAt.getTime(),
                });
                used.add(vtxo.txid);
            }
        } else if (!changes.has(vtxo.txid)) {
            received.push({
                key: { ...txKey, arkTxid: vtxo.txid },
                tag: "offchain",
                type: TxType.TxReceived,
                amount: vtxo.value,
                settled: true,
                createdAt: vtxo.createdAt.getTime(),
            });
        }

        // Case 2 - renewal

        if (commitmentIdsSettling.length > 0) {
            // this VTXO is the result of coin renewal
            // We skip it unless is contains an exit
            for (const commitmentTxid of commitmentIdsSettling) {
                const settled = fromOldestVtxo.filter(
                    (v) =>
                        v.settledBy === commitmentTxid &&
                        !alreadySettled.has(v.txid)
                );
                if (settled.length === 0) continue;

                settled.forEach((v) => {
                    if (v.arkTxId === undefined || v.arkTxId === "") {
                        swept.add(v.txid);
                        if (received.some((v) => v.key.arkTxid === vtxo.txid)) {
                            received = received.filter(
                                (v) => v.key.arkTxid !== vtxo.txid
                            );
                        }
                    }
                    alreadySettled.add(v.txid);
                });

                const settledAmount = settled.reduce(
                    (acc, v) => acc + v.value,
                    0
                );
                if (vtxo.value < settledAmount) {
                    // EXIT!
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
            used.add(vtxo.txid);
        }
    }

    const boardingTx = allBoardingTxs
        .filter((tx) => !commitmentsToIgnore.has(tx.key.commitmentTxid))
        .map((tx) => ({ ...tx, tag: "boarding" }));

    const sorted = [...boardingTx, ...sent, ...received].sort(
        (a, b) => a.createdAt - b.createdAt
    );

    return sorted as ExtendedArkTransaction[];
}
