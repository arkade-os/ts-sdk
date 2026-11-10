import { hex } from "@scure/base";
import { arkadeCashId, type ArkadeCashTx } from "./tracker";
import { ArkadeCash } from ".";
import type { VirtualCoin } from "../wallet";
import type { IndexerProvider } from "../providers/indexer";
import type { OnchainProvider } from "../providers/onchain";
import type { ArkadeInfo } from "../providers/ark";
import { classifyAgainstSignerSet, signerSetFromInfo } from "../wallet/signerRotation";
import { getAllNormalizedVtxos, isVtxoSpent, resolveTimeHeight } from "../wallet/vtxo";

export type ArkadeCashStatus =
    | "available"
    | "claimed"
    | "recovering"
    | "expired"
    | "exitable"
    | "exited"
    | "unissued";

export interface ArkadeCashStatusReport {
    status: ArkadeCashStatus;
    amount: number;
    /** Funding transactions, each with the voucher's own share of it. */
    issues: ArkadeCashTx[];
    /** Spending transactions, each with the voucher's own share of it. */
    claims: ArkadeCashTx[];
}

/** Sum coin values per transaction id, keeping first-seen order. */
function groupByTxid(coins: { txid: string; value: number }[]): ArkadeCashTx[] {
    const totals = new Map<string, number>();
    for (const { txid, value } of coins) totals.set(txid, (totals.get(txid) ?? 0) + value);
    return [...totals].map(([txid, amount]) => ({ txid, amount }));
}

export async function readArkadeCash(
    token: string,
    indexer: IndexerProvider,
    info: ArkadeInfo,
    onchain?: OnchainProvider,
    exitThreshold?: { seconds: number } | { blocks: number },
): Promise<ArkadeCashStatusReport> {
    const cash = ArkadeCash.fromString(token);
    const signer = classifyAgainstSignerSet(hex.encode(cash.serverPubKey), signerSetFromInfo(info));
    if (signer.status === "UNKNOWN_SIGNER") {
        throw new Error("ArkadeCash belongs to another operator");
    }
    const coins = await getAllNormalizedVtxos(indexer, [arkadeCashId(cash)]);
    return classifyArkadeCash(
        coins,
        info.dust,
        await resolveTimeHeight(onchain),
        exitThreshold,
        signer.status === "EXPIRED",
    );
}

export function classifyArkadeCash(
    coins: VirtualCoin[],
    dust: bigint,
    now: { timestamp: Date; height?: number },
    exitThreshold?: { seconds: number } | { blocks: number },
    awaitingSweep = false,
): ArkadeCashStatusReport {
    const eligible = coins.filter(
        (coin) => coin.value >= Number(dust) && !(coin.assets && coin.assets.length > 0),
    );
    const hasSpent = eligible.some(isVtxoSpent);
    const hasLive = eligible.some((coin) => !isVtxoSpent(coin) && !coin.isUnrolled);
    const hasExit = eligible.some((coin) => !isVtxoSpent(coin) && coin.isUnrolled);
    const recoverable = eligible.some((coin) => !isVtxoSpent(coin) && coin.isSwept);
    const elapsedBatch = eligible.some(
        (coin) =>
            !isVtxoSpent(coin) &&
            !coin.isSwept &&
            ((coin.expiresAt !== undefined &&
                coin.expiresAt.getTime() <= now.timestamp.getTime()) ||
                (coin.expiresAtHeight !== undefined &&
                    now.height !== undefined &&
                    coin.expiresAtHeight <= now.height)),
    );
    const exitReady =
        hasLive &&
        exitThreshold !== undefined &&
        eligible.every((coin) => {
            if (isVtxoSpent(coin)) return true;
            if ("blocks" in exitThreshold && coin.expiresAtHeight !== undefined) {
                const confirmedAt = coin.expiresAtHeight - exitThreshold.blocks;
                return now.height !== undefined && now.height - confirmedAt >= exitThreshold.blocks;
            }
            return (
                !("blocks" in exitThreshold) &&
                now.timestamp.getTime() - coin.createdAt.getTime() >= exitThreshold.seconds * 1000
            );
        });
    return {
        status:
            eligible.length === 0
                ? "unissued"
                : hasExit && !hasLive
                  ? "exited"
                  : hasSpent && !hasLive
                    ? "claimed"
                    : recoverable
                      ? "recovering"
                      : exitReady
                        ? "exitable"
                        : elapsedBatch
                          ? "expired"
                          : awaitingSweep
                            ? "expired"
                            : "available",
        amount: eligible.reduce((sum, coin) => sum + (isVtxoSpent(coin) ? 0 : coin.value), 0),
        issues: groupByTxid(eligible),
        claims: groupByTxid(
            eligible.flatMap((coin) =>
                coin.arkTxId ? [{ txid: coin.arkTxId, value: coin.value }] : [],
            ),
        ),
    };
}
