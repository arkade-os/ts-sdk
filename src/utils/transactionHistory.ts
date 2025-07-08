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
        if (v.settledBy) {
            if (!vtxosByTxid.has(v.settledBy)) {
                vtxosByTxid.set(v.settledBy, []);
            }
            const currentVtxos = vtxosByTxid.get(v.settledBy)!;
            vtxosByTxid.set(v.settledBy, [...currentVtxos, v]);
        }

        if (!v.arkTxId) {
            continue;
        }

        if (!vtxosByTxid.has(v.arkTxId)) {
            vtxosByTxid.set(v.arkTxId, []);
        }
        const currentVtxos = vtxosByTxid.get(v.arkTxId)!;
        vtxosByTxid.set(v.arkTxId, [...currentVtxos, v]);
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
        if (vtxo.virtualStatus.state === "preconfirmed") {
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
