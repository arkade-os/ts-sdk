import { ArkTransaction, TxType, TxKey, VirtualCoin } from "../wallet";

/**
 * @param spendable - Vtxos that are spendable
 * @param spent - Vtxos that are spent
 * @param boardingBatchTxids - Set of boarding batch txids
 * @returns Ark transactions
 */
export function vtxosToTxs(
    spendable: VirtualCoin[],
    spent: VirtualCoin[],
    boardingBatchTxids: Set<string>
): ArkTransaction[] {
    const txs: ArkTransaction[] = [];

    // Receive case
    // All vtxos are received unless:
    // - they resulted from a settlement (either boarding or refresh)
    // - they are the change of a spend tx
    // - they were spent in a payment (have arkTxId set)
    // - they resulted from a payment (their txid matches an arkTxId of a spent vtxo)

    // First, collect all arkTxIds from spent vtxos to identify payment transactions
    const paymentArkTxIds = new Set(
        spent.filter((v) => v.arkTxId).map((v) => v.arkTxId!)
    );

    let vtxosLeftToCheck = [...spent];
    for (const vtxo of [...spendable, ...spent]) {
        if (
            vtxo.virtualStatus.state !== "preconfirmed" &&
            vtxo.virtualStatus.commitmentTxIds &&
            vtxo.virtualStatus.commitmentTxIds.some((txid) =>
                boardingBatchTxids.has(txid)
            )
        ) {
            continue;
        }

        // Skip vtxos that were spent in a payment transaction
        // These will be handled in the sent transaction section below
        if (vtxo.arkTxId) {
            continue;
        }

        // Skip vtxos that resulted from a payment transaction
        // (their txid matches an arkTxId from a spent vtxo)
        if (paymentArkTxIds.has(vtxo.txid)) {
            continue;
        }

        const settleVtxos = findVtxosSpentInSettlement(vtxosLeftToCheck, vtxo);
        vtxosLeftToCheck = removeVtxosFromList(vtxosLeftToCheck, settleVtxos);
        const settleAmount = reduceVtxosAmount(settleVtxos);
        if (vtxo.value <= settleAmount) {
            continue; // settlement or change, ignore
        }

        const spentVtxos = findVtxosSpentInPayment(vtxosLeftToCheck, vtxo);
        vtxosLeftToCheck = removeVtxosFromList(vtxosLeftToCheck, spentVtxos);
        const spentAmount = reduceVtxosAmount(spentVtxos);
        if (vtxo.value <= spentAmount) {
            continue; // settlement or change, ignore
        }

        const txKey: TxKey = {
            commitmentTxid: vtxo.spentBy || "",
            boardingTxid: "",
            arkTxid: "",
        };
        let settled = vtxo.virtualStatus.state !== "preconfirmed";
        if (vtxo.virtualStatus.state === "preconfirmed") {
            txKey.arkTxid = vtxo.txid;

            if (vtxo.spentBy) {
                settled = true;
            }
        }

        txs.push({
            key: txKey,
            amount: vtxo.value - settleAmount - spentAmount,
            type: TxType.TxReceived,
            createdAt: vtxo.createdAt.getTime(),
            settled,
        });
    }

    // vtxos by settled by or ark txid
    const vtxosByTxid = new Map<string, VirtualCoin[]>();
    for (const v of spent) {
        // Prefer arkTxId over settledBy to avoid duplicates
        // A vtxo should only be grouped once
        const groupKey = v.arkTxId || v.settledBy;

        if (!groupKey) {
            continue;
        }

        if (!vtxosByTxid.has(groupKey)) {
            vtxosByTxid.set(groupKey, []);
        }
        const currentVtxos = vtxosByTxid.get(groupKey)!;
        vtxosByTxid.set(groupKey, [...currentVtxos, v]);
    }

    for (const [sb, vtxos] of vtxosByTxid) {
        const resultedVtxos = findVtxosResultedFromTxid(
            [...spendable, ...spent],
            sb
        );
        const resultedAmount = reduceVtxosAmount(resultedVtxos);
        const spentAmount = reduceVtxosAmount(vtxos);
        if (spentAmount <= resultedAmount) {
            continue; // settlement or change, ignore
        }

        const vtxo = getVtxo(resultedVtxos, vtxos);

        const txKey: TxKey = {
            commitmentTxid: vtxo.virtualStatus.commitmentTxIds?.[0] || "",
            boardingTxid: "",
            arkTxid: "",
        };

        // Use the grouping key (sb) as arkTxid if it looks like an arkTxId
        // (i.e., if the spent vtxos had arkTxId set, use that instead of result vtxo's txid)
        const isArkTxId = vtxos.some((v) => v.arkTxId === sb);
        if (isArkTxId) {
            txKey.arkTxid = sb;
        } else if (vtxo.virtualStatus.state === "preconfirmed") {
            txKey.arkTxid = vtxo.txid;
        }

        txs.push({
            key: txKey,
            amount: spentAmount - resultedAmount,
            type: TxType.TxSent,
            createdAt: vtxo.createdAt.getTime(),
            settled: true,
        });
    }

    return txs;
}

/**
 * Helper function to find vtxos that were spent in a settlement
 */
function findVtxosSpentInSettlement(
    vtxos: VirtualCoin[],
    vtxo: VirtualCoin
): VirtualCoin[] {
    if (vtxo.virtualStatus.state === "preconfirmed") {
        return [];
    }

    return vtxos.filter((v) => {
        if (!v.settledBy) return false;
        return (
            vtxo.virtualStatus.commitmentTxIds?.includes(v.settledBy) ?? false
        );
    });
}

/**
 * Helper function to find vtxos that were spent in a payment
 */
function findVtxosSpentInPayment(
    vtxos: VirtualCoin[],
    vtxo: VirtualCoin
): VirtualCoin[] {
    return vtxos.filter((v) => {
        if (!v.arkTxId) return false;
        return v.arkTxId === vtxo.txid;
    });
}

/**
 * Helper function to find vtxos that resulted from a spentBy transaction
 */
function findVtxosResultedFromTxid(
    vtxos: VirtualCoin[],
    txid: string
): VirtualCoin[] {
    return vtxos.filter((v) => {
        if (
            v.virtualStatus.state !== "preconfirmed" &&
            v.virtualStatus.commitmentTxIds?.includes(txid)
        ) {
            return true;
        }
        return v.txid === txid;
    });
}

/**
 * Helper function to reduce vtxos to their total amount
 */
function reduceVtxosAmount(vtxos: VirtualCoin[]): number {
    return vtxos.reduce((sum, v) => sum + v.value, 0);
}

/**
 * Helper function to get a vtxo from a list of vtxos
 */
function getVtxo(
    resultedVtxos: VirtualCoin[],
    spentVtxos: VirtualCoin[]
): VirtualCoin {
    if (resultedVtxos.length === 0) {
        return spentVtxos[0];
    }
    return resultedVtxos[0];
}

function removeVtxosFromList(
    vtxos: VirtualCoin[],
    vtxosToRemove: VirtualCoin[]
): VirtualCoin[] {
    return vtxos.filter((v) => {
        for (const vtxoToRemove of vtxosToRemove) {
            if (v.txid === vtxoToRemove.txid && v.vout === vtxoToRemove.vout) {
                return false;
            }
        }
        return true;
    });
}
