import { ArkTransaction, Asset, BuiltinTxTag, TxKey, TxType, VirtualCoin } from "../wallet";
import { normalizeVtxo, type NormalizedVirtualCoin } from "../wallet/vtxo";
import { isGatedVtxo, type GatedContracts } from "../contracts/spendability";

type ExtendedArkTransaction = ArkTransaction & {
    tag: BuiltinTxTag;
};

/**
 * When each transaction the wallet holds an output of was created, keyed by
 * txid. Every coin counts, gated or not: holding *any* output of a transaction
 * is what makes its creation time known without asking the indexer.
 *
 * Stating that once is what keeps the gate from complicating it. The rule is
 * older than the gate — a spend that left change has always read its time off
 * that change — and the partition below must not turn it into a per-partition
 * special case, or a swap deposit with no change would be dated from the *input*
 * coin and filed at the wrong end of the history.
 */
function localCreatedAtByTxid(vtxos: readonly NormalizedVirtualCoin[]): Map<string, number> {
    const createdAt = new Map<string, number>();
    for (const vtxo of vtxos) {
        // Outputs of one transaction share a creation time, so the first write
        // settles it; the caller's ascending sort makes that the earliest.
        if (vtxo.txid && !createdAt.has(vtxo.txid)) {
            createdAt.set(vtxo.txid, vtxo.createdAt.getTime());
        }
    }
    return createdAt;
}

/**
 * Where an Arkade transaction touched one of the wallet's gated contracts:
 * `paidIn` holds the txids that created a gated output, `paidOut` the txids that
 * spent one. Membership tags the row facing the contract, so a consumer can tell
 * "into my own escrow" from "to a stranger" rather than the movement arriving
 * unattributed.
 *
 * Offchain only. A gated coin settled in a batch carries `settledBy` and no
 * `arkTxId`, so it reaches neither set and the exit or batch row facing it stays
 * untagged — the corridor case this change deliberately does not interpret.
 */
function gatedTouchpoints(gated: readonly NormalizedVirtualCoin[]): {
    paidIn: ReadonlySet<string>;
    paidOut: ReadonlySet<string>;
} {
    const paidIn = new Set<string>();
    const paidOut = new Set<string>();
    for (const vtxo of gated) {
        if (vtxo.txid) paidIn.add(vtxo.txid);
        if (vtxo.isSpent && vtxo.arkTxId) paidOut.add(vtxo.arkTxId);
    }
    return { paidIn, paidOut };
}

const txKey: TxKey = {
    commitmentTxid: "",
    boardingTxid: "",
    arkTxid: "",
};

function consumeBoardingReceive(
    boardingTxs: ArkTransaction[],
    predicate: (tx: ArkTransaction) => boolean,
): boolean {
    const index = boardingTxs.findIndex(predicate);
    if (index === -1) return false;
    boardingTxs.splice(index, 1);
    return true;
}

function isSettledBoardingReceive(tx: ArkTransaction): boolean {
    return tx.type === TxType.TxReceived && tx.settled && tx.key.boardingTxid !== "";
}

function collectAssets(vtxos: VirtualCoin[]): Asset[] | undefined {
    const map = new Map<string, bigint>();
    for (const vtxo of vtxos) {
        if (vtxo.assets) {
            for (const a of vtxo.assets) {
                map.set(a.assetId, (map.get(a.assetId) ?? 0n) + a.amount);
            }
        }
    }
    if (map.size === 0) return undefined;
    return Array.from(map, ([assetId, amount]) => ({ assetId, amount }));
}

function subtractAssets(spent: VirtualCoin[], change: VirtualCoin[]): Asset[] | undefined {
    const map = new Map<string, bigint>();
    for (const vtxo of change) {
        if (vtxo.assets) {
            for (const a of vtxo.assets) {
                map.set(a.assetId, (map.get(a.assetId) ?? 0n) + a.amount);
            }
        }
    }
    for (const vtxo of spent) {
        if (vtxo.assets) {
            for (const a of vtxo.assets) {
                const current = map.get(a.assetId) ?? 0n;
                const remaining = current - a.amount;
                if (remaining !== 0n) {
                    map.set(a.assetId, remaining);
                } else {
                    map.delete(a.assetId);
                }
            }
        }
    }
    if (map.size === 0) return undefined;
    return Array.from(map, ([assetId, amount]) => ({ assetId, amount }));
}

/**
 * Ark txids the main loop needs a `createdAt` for: spent virtual outputs whose
 * spending transaction left the wallet no output to read the time off. Exactly
 * the loop's fetch set, and exactly the complement of {@link localCreatedAtByTxid}
 * — which is why gating history costs no extra indexer call, even though it
 * moves a swap deposit's only local output out of the loop's own set.
 */
function collectArkTxidsNeedingCreatedAt(
    vtxos: readonly NormalizedVirtualCoin[],
    localCreatedAt: ReadonlyMap<string, number>,
): string[] {
    // Set, not a scan per vtxo: this runs over the whole history, and the wallets
    // that need the batching are the ones large enough for O(n²) to hurt.
    const txids = new Set<string>();
    for (const vtxo of vtxos) {
        if (vtxo.isSpent && vtxo.arkTxId && !localCreatedAt.has(vtxo.arkTxId)) {
            txids.add(vtxo.arkTxId);
        }
    }
    return [...txids];
}

/**
 * Builds the transaction history by analyzing virtual outputs, boarding transactions, and ignored commitments.
 * History is sorted from newest to oldest and is composed only of SENT and RECEIVED transactions.
 *
 * @param {VirtualCoin[]} vtxos - An array of virtual outputs representing the user's transactions and balances.
 * @param {ArkTransaction[]} allBoardingTxs - An array of boarding transactions to include in the history.
 * @param {Set<string>} commitmentsToIgnore - A set of commitment IDs that should be excluded from processing.
 * @param resolveTxCreatedAt - Batched `createdAt` resolver, called at most once; missing txids
 * fall back to the spent output's `createdAt + 1`.
 * @param gatedScripts - The contracts generic spending is closed on, as
 * `gatedContracts()` returns them. Their VTXOs are read as an external
 * counterparty: they are not the wallet's own coins, so a deposit into one is a
 * send and its return is a receive, rather than both cancelling out as change.
 * The rows facing them are tagged `"gated"`. It defaults to empty — every VTXO
 * counts as the wallet's own, the behaviour that predates the gate — so that
 * histories with no contract rows to judge, the unit suite's included, stay
 * source-compatible. Every SDK read path passes it; a new one that means to
 * report a wallet's own money must too.
 * @return {ExtendedArkTransaction[]} A sorted array of extended Arkade transactions, representing the transaction history.
 */
export async function buildTransactionHistory(
    vtxos: VirtualCoin[],
    allBoardingTxs: ArkTransaction[],
    commitmentsToIgnore: Set<string>,
    resolveTxCreatedAt?: (txids: string[]) => Promise<Map<string, number>>,
    gatedScripts: GatedContracts = new Map(),
): Promise<ExtendedArkTransaction[]> {
    const normalized = vtxos
        .map(normalizeVtxo)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // `getBalance`'s predicate, put to a different question. Balance asks what
    // may be spent, and still counts a gated coin in `total`; history asks whose
    // money moved, and everything below cross-references this set to decide
    // change, receives and spent totals — so a gated coin left in it is one the
    // history reads as the user's, which is exactly how an escrowed deposit and
    // its return used to cancel each other out and vanish.
    // Built over every coin, before the partition: which transactions the wallet
    // can date locally does not depend on which side of the gate a coin fell.
    const localCreatedAt = localCreatedAtByTxid(normalized);
    const gatedVtxos = normalized.filter((vtxo) => isGatedVtxo(vtxo, gatedScripts));
    const fromOldestVtxo = normalized.filter((vtxo) => !isGatedVtxo(vtxo, gatedScripts));
    const { paidIn: paidIntoGated, paidOut: paidOutOfGated } = gatedTouchpoints(gatedVtxos);

    const txidsNeedingCreatedAt = resolveTxCreatedAt
        ? collectArkTxidsNeedingCreatedAt(fromOldestVtxo, localCreatedAt)
        : [];
    const resolvedCreatedAt =
        resolveTxCreatedAt && txidsNeedingCreatedAt.length > 0
            ? await resolveTxCreatedAt(txidsNeedingCreatedAt)
            : new Map<string, number>();
    const unmatchedSettledBoardingTxs = allBoardingTxs
        .filter(isSettledBoardingReceive)
        .sort((a, b) => a.createdAt - b.createdAt);

    const sent: ExtendedArkTransaction[] = [];
    let received: ExtendedArkTransaction[] = [];

    for (const vtxo of fromOldestVtxo) {
        if (vtxo.status.isLeaf) {
            // If this virtual output is a leaf and it's not the settlement of a boarding or there's no virtual output refreshed by it,
            // it's translated into a received batch transaction
            const commitmentTxid = vtxo.commitmentTxIds[0];
            const vtxoCreatedAt = vtxo.createdAt.getTime();
            const ignoredCommitment =
                commitmentsToIgnore.has(commitmentTxid) ||
                (!!vtxo.settledBy && commitmentsToIgnore.has(vtxo.settledBy));

            if (ignoredCommitment) {
                consumeBoardingReceive(
                    unmatchedSettledBoardingTxs,
                    (tx) =>
                        tx.createdAt <= vtxoCreatedAt &&
                        (tx.key.commitmentTxid === commitmentTxid ||
                            tx.key.commitmentTxid === vtxo.settledBy),
                );
            } else if (
                fromOldestVtxo.filter((v) => v.settledBy === vtxo.commitmentTxIds[0]).length === 0
            ) {
                const duplicateBoardingReceive = consumeBoardingReceive(
                    unmatchedSettledBoardingTxs,
                    (tx) => tx.amount === vtxo.value && tx.createdAt <= vtxoCreatedAt,
                );

                if (!duplicateBoardingReceive) {
                    const assets = collectAssets([vtxo]);
                    received.push({
                        key: {
                            ...txKey,
                            commitmentTxid,
                        },
                        tag: "batch",
                        type: TxType.TxReceived,
                        amount: vtxo.value,
                        settled: vtxo.status.isLeaf || vtxo.isSpent!,
                        createdAt: vtxoCreatedAt,
                        ...(assets && { assets }),
                    });
                }
            }
        } else if (fromOldestVtxo.filter((v) => v.arkTxId === vtxo.txid).length === 0) {
            // If this virtual output is preconfirmed and does not spend any other virtual outputs,
            // it's translated into a received offchain transaction
            const assets = collectAssets([vtxo]);
            received.push({
                key: { ...txKey, arkTxid: vtxo.txid! },
                // The escrow paying out: a swap fill or a cancel spends the
                // gated coin and lands the proceeds here. Nothing else about
                // the row changes — the tag only names the counterparty.
                tag: paidOutOfGated.has(vtxo.txid!) ? "gated" : "offchain",
                type: TxType.TxReceived,
                amount: vtxo.value,
                settled: vtxo.status.isLeaf || vtxo.isSpent!,
                createdAt: vtxo.createdAt.getTime(),
                ...(assets && { assets }),
            });
        }

        // If the virtual output is spent, it's translated into a sent transaction unless:
        // - it's been refreshed (we don't want to add any record in this case)
        // - a sent transaction has been already added to avoid duplicates (can happen if many virtual outputs have been spent in the same tx or forfeited in the same batch)
        if (vtxo.isSpent) {
            // If the virtual output is spent offchain, it's translated into an offchain sent tx
            if (vtxo.arkTxId && !sent.some((s) => s.key.arkTxid === vtxo.arkTxId)) {
                const changes = fromOldestVtxo.filter((_) => _.txid === vtxo.arkTxId);

                // We want to find all the other virtual outputs spent by the same transaction to
                // calculate the full amount of the change.
                const allSpent = fromOldestVtxo.filter((v) => v.arkTxId === vtxo.arkTxId);
                const spentAmount = allSpent.reduce((acc, v) => acc + v.value, 0);

                let txAmount = 0;
                let txTime = 0;
                if (changes.length > 0) {
                    const changeAmount = changes.reduce((acc, v) => acc + v.value, 0);
                    txAmount = spentAmount - changeAmount;
                    txTime = changes[0].createdAt.getTime();
                } else {
                    txAmount = spentAmount;
                    // No change to read the time off, but the wallet may still
                    // hold another of this tx's outputs — an escrow deposit does.
                    // Failing that the resolver answers, and the input coin's
                    // timestamp is the last resort, only approximately right.
                    txTime =
                        localCreatedAt.get(vtxo.arkTxId) ??
                        resolvedCreatedAt.get(vtxo.arkTxId) ??
                        vtxo.createdAt.getTime() + 1;
                }

                const assets = subtractAssets(allSpent, changes);

                // A pure self-transfer returns the full spent amount as change and moves
                // no assets, so nothing actually leaves the wallet. This happens when all
                // VTXOs are spent to a self address (e.g. migrating to a new signer after a
                // server key rotation). Don't record a ghost zero-amount sent transaction.
                // Note: zero-amount sends that do move assets (issuance/reissuance/burn)
                // are kept because `assets` is set in those cases.
                if (txAmount !== 0 || assets) {
                    sent.push({
                        key: { ...txKey, arkTxid: vtxo.arkTxId },
                        // Funding the escrow: an output of this tx landed on a
                        // gated contract of the wallet's, so the send is to the
                        // user's own covenant rather than to a stranger.
                        tag: paidIntoGated.has(vtxo.arkTxId) ? "gated" : "offchain",
                        type: TxType.TxSent,
                        amount: txAmount,
                        settled: true,
                        createdAt: txTime,
                        ...(assets && { assets }),
                    });
                }
            }

            // If the virtual output is forfeited in a batch and the total sum of forfeited virtual outputs is bigger than the sum of new virtual outputs,
            // it's translated into an exit sent tx
            if (
                vtxo.settledBy &&
                !commitmentsToIgnore.has(vtxo.settledBy) &&
                !sent.some((s) => s.key.commitmentTxid === vtxo.settledBy)
            ) {
                const changes = fromOldestVtxo.filter(
                    (v) =>
                        v.status.isLeaf &&
                        v.commitmentTxIds.length > 0 &&
                        v.commitmentTxIds.every((_) => vtxo.settledBy === _),
                );

                const forfeitVtxos = fromOldestVtxo.filter((v) => v.settledBy === vtxo.settledBy);
                const forfeitAmount = forfeitVtxos.reduce((acc, v) => acc + v.value, 0);

                if (changes.length > 0) {
                    const settledAmount = changes.reduce((acc, v) => acc + v.value, 0);

                    // forfeitAmount > settledAmount --> collaborative exit with offchain change
                    // TODO: make this support fees!
                    if (forfeitAmount > settledAmount) {
                        const assets = subtractAssets(forfeitVtxos, changes);
                        sent.push({
                            key: { ...txKey, commitmentTxid: vtxo.settledBy },
                            tag: "exit",
                            type: TxType.TxSent,
                            amount: forfeitAmount - settledAmount,
                            settled: true,
                            createdAt: changes[0].createdAt.getTime(),
                            ...(assets && { assets }),
                        });
                    }
                } else {
                    // forfeitAmount > 0 && settledAmount == 0 --> collaborative exit without any offchain change
                    const assets = subtractAssets(forfeitVtxos, []);
                    sent.push({
                        key: { ...txKey, commitmentTxid: vtxo.settledBy },
                        tag: "exit",
                        type: TxType.TxSent,
                        amount: forfeitAmount,
                        settled: true,
                        // TODO: fetch commitment tx with /v1/indexer/commitmentTx/<commitmentTxid> to know when the tx was made
                        createdAt: vtxo.createdAt.getTime() + 1,
                        ...(assets && { assets }),
                    });
                }
            }
        }
    }

    // Boardings are always inbound amounts, and we only hide the ones to ignore.
    const boardingTx = allBoardingTxs.map((tx) => ({ ...tx, tag: "boarding" }));

    const sorted = [...boardingTx, ...sent, ...received].sort((a, b) => b.createdAt - a.createdAt);

    return sorted as ExtendedArkTransaction[];
}
