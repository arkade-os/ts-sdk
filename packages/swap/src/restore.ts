/**
 * Rebuild swap records after a wallet restore, from chain data: the funding tx carries
 * the offer packet (type 0x03) in its extension, the covenant vtxo at the offer's script
 * holds the deposit, and that vtxo's spender is the fill or cancel tx.
 *
 * Incremental: txids with an authoritative answer are remembered and never refetched.
 */
import { base64, hex } from "@scure/base";
import {
    Extension,
    RestIndexerProvider,
    Transaction,
    scriptFromTapLeafScript,
} from "@arkade-os/sdk";
import { decodeOffer, Offer, OFFER_PACKET_TYPE, offerContract } from "./offer";
import { BTC_ASSET_ID, type AssetSwap, type AssetSwapStatus } from "./store";

// ponytail: fixed request size; tune only if histories outgrow it
const TXS_PER_REQUEST = 50;

/**
 * The subset of a wallet transaction record the swap scan reads. No `assets`: see
 * {@link classifySpend} for why a net asset delta cannot classify a spend.
 */
export interface Tx {
    type: string;
    /** The virtual (ark) txid; the funding tx's identity. */
    redeemTxid: string;
    boardingTxid?: string;
    roundTxid?: string;
    /** Unix seconds. */
    createdAt?: number;
}

/** The indexer surface the restore scan needs — narrower than a full provider. */
export type RestoreIndexer = Pick<RestIndexerProvider, "getVirtualTxs" | "getVtxos">;

type Found = {
    fundingTx: Tx;
    offer: Offer;
    offerHex: string;
    existing?: AssetSwap;
};

/**
 * Fetch and parse virtual txs, keyed by the psbt's own txid rather than response order.
 * A failed chunk or missing txid is simply absent, which callers read as "unanswered,
 * retry later", so a partial response never orphans a txid.
 */
async function fetchParsedTxs(
    indexer: RestoreIndexer,
    txids: string[],
): Promise<Map<string, Transaction>> {
    const parsedByTxid = new Map<string, Transaction>();
    if (txids.length === 0) return parsedByTxid;

    const chunks: string[][] = [];
    for (let i = 0; i < txids.length; i += TXS_PER_REQUEST) {
        chunks.push(txids.slice(i, i + TXS_PER_REQUEST));
    }
    const chunkResults = await Promise.allSettled(
        chunks.map(async (ids) => (await indexer.getVirtualTxs(ids)).txs),
    );

    for (const result of chunkResults) {
        if (result.status !== "fulfilled") continue;
        for (const psbt of result.value) {
            try {
                const parsed = Transaction.fromPSBT(base64.decode(psbt));
                parsedByTxid.set(parsed.id, parsed);
            } catch {
                // unattributable blob: its txid stays unanswered and retries
            }
        }
    }
    return parsedByTxid;
}

/** Sent virtual txs with no stored swap record and no previous authoritative answer. */
const unscannedSwapCandidates = (
    txs: Tx[],
    existingIds: ReadonlySet<string>,
    scanned: ReadonlySet<string>,
) =>
    txs.filter(
        (tx) =>
            tx.type === "sent" &&
            tx.redeemTxid &&
            !existingIds.has(tx.redeemTxid) &&
            !scanned.has(tx.redeemTxid),
    );

/**
 * What became of a deposit, as the spending transaction reports it. `indeterminate` is
 * the absence of an answer; the caller decides whether to retry.
 */
export type SpendKind = "cancelled" | "fulfilled" | "indeterminate";

/**
 * Classify a spend by the covenant leaf it took (a submitted ark tx keeps each input's
 * `tapLeafScript`). `fulfill` is the solver paying; every other leaf returns the deposit.
 * Not by asset movement: once registered, the deposit is the wallet's own coin, so an
 * asset offer's cancel nets to zero exactly like its fill. Leaves also survive batching.
 *
 * **`exit` reports `cancelled`, like `cancel`.** Reporting it `indeterminate` would leave
 * the swap `pending` forever: re-queued every scan, and never retired.
 *
 * **Pass the checkpoint (`vtxo.spentBy`), not the ark tx.** Only the checkpoint spends the
 * deposit outpoint; the ark tx spends the checkpoint's output, so it always yields
 * `indeterminate`. {@link classifyDepositSpend} tries both.
 *
 * @param operatorPubkey - The key the covenant was *funded* against. A rotated key fails
 *   the script match and yields `indeterminate` rather than a guess.
 */
export function classifySpend(
    offer: Offer,
    operatorPubkey: Uint8Array,
    spendTx: Transaction,
    deposit: { txid: string; vout: number },
): SpendKind {
    let leaves: { returned: Uint8Array[]; fulfill?: Uint8Array };
    try {
        const script = offerContract(offer, operatorPubkey);
        if (hex.encode(script.pkScript) !== hex.encode(offer.swapPkScript)) return "indeterminate";
        leaves = {
            // `exit` is absent on an offer with no exit closure, and drops out here
            returned: ["cancel", "exit"]
                .map((name) => script.functionByName(name)?.leafScript)
                .filter((leaf): leaf is Uint8Array => leaf !== undefined),
            fulfill: script.functionByName("fulfill")?.leafScript,
        };
    } catch {
        return "indeterminate"; // an offer whose covenant will not compile is not classifiable
    }

    for (let i = 0; i < spendTx.inputsLength; i++) {
        const input = spendTx.getInput(i);
        if (!input.txid || input.index !== deposit.vout) continue;
        // @scure exposes input txids in display/BE order (`txid`, not the raw
        // LE transaction hash), matching the indexer convention for vtxo txids.
        if (hex.encode(input.txid) !== deposit.txid) continue;
        for (const leaf of input.tapLeafScript ?? []) {
            const spent = hex.encode(scriptFromTapLeafScript(leaf));
            if (leaves.returned.some((back) => spent === hex.encode(back))) return "cancelled";
            if (leaves.fulfill && spent === hex.encode(leaves.fulfill)) return "fulfilled";
        }
    }
    // None of its leaves (e.g. a batch forfeit), no tapleaf, or the wrong half of the spend.
    return "indeterminate";
}

/** The txids that may hold a deposit's spend, checkpoint first (it carries the outpoint). */
export const spendTxidsOf = (vtxo: { spentBy?: string; arkTxId?: string }): string[] =>
    [vtxo.spentBy, vtxo.arkTxId].filter((id): id is string => Boolean(id));

/**
 * Classify a deposit's spend across both halves of it (`spentBy` and `arkTxId`, which
 * may be the same id for a settlement), taking the first definite answer.
 */
export function classifyDepositSpend(
    offer: Offer,
    operatorPubkey: Uint8Array,
    spendTxs: Iterable<Transaction>,
    deposit: { txid: string; vout: number },
): SpendKind {
    for (const tx of spendTxs) {
        const kind = classifySpend(offer, operatorPubkey, tx, deposit);
        if (kind !== "indeterminate") return kind;
    }
    return "indeterminate";
}

/**
 * Scan the given candidates for offer packets and rebuild the AssetSwap records the store
 * lost. Returns the rebuilt swaps plus the txids that got an authoritative answer, which
 * the caller persists so they are never fetched again.
 *
 * A spent deposit is classified from its spending tx's covenant leaf
 * ({@link classifySpend}), fetched from the indexer. An unclassifiable spend leaves the
 * funding txid unanswered for a later scan: nothing sticky is written on a guess.
 *
 * @param opts.operatorPubkey - The key the covenants were funded against. A rotated key
 *   leaves affected swaps unresolved rather than misclassified.
 */
export async function restoreAssetSwaps(
    indexer: RestoreIndexer,
    txs: Tx[],
    existingIds: ReadonlySet<string>,
    opts: {
        operatorPubkey: Uint8Array;
        scanned?: ReadonlySet<string>;
        reopen?: AssetSwap[];
        /** Address prefix; given, a rebuilt record names the covenant's address (#680). */
        hrp?: string;
    },
): Promise<{ restored: AssetSwap[]; scannedTxids: string[] }> {
    const { operatorPubkey, scanned = new Set<string>(), reopen = [], hrp } = opts;
    const reopened: Found[] = [];
    for (const swap of reopen) {
        try {
            reopened.push({
                fundingTx: { type: "sent", redeemTxid: swap.fundingTxid },
                offer: decodeOffer(hex.decode(swap.offerHex)),
                offerHex: swap.offerHex,
                existing: swap,
            });
        } catch {}
    }
    const reopenedTxids = new Set(reopened.map(({ fundingTx }) => fundingTx.redeemTxid));
    const candidates = unscannedSwapCandidates(txs, existingIds, scanned).filter(
        ({ redeemTxid }) => !reopenedTxids.has(redeemTxid),
    );
    if (candidates.length === 0 && reopened.length === 0) {
        return { restored: [], scannedTxids: [] };
    }

    const byTxid = new Map(candidates.map((tx) => [tx.redeemTxid, tx]));
    const parsedByTxid = await fetchParsedTxs(
        indexer,
        candidates.map((tx) => tx.redeemTxid),
    );

    const fetchedTxids: string[] = [];
    const found: Found[] = [...reopened];
    for (const [txid, parsed] of parsedByTxid) {
        const fundingTx = byTxid.get(txid);
        if (!fundingTx) continue;
        // Only a txid whose psbt came back is answered; blanket-marking the request would
        // orphan missing ones forever.
        fetchedTxids.push(txid);
        try {
            const packet = Extension.fromTx(parsed).getPacketByType(OFFER_PACKET_TYPE);
            if (!packet) continue;
            const payload = packet.serialize();
            found.push({
                fundingTx,
                offer: decodeOffer(payload),
                offerHex: hex.encode(payload),
            });
        } catch {
            // no extension, foreign packet or malformed offer: not a swap funding
        }
    }
    if (found.length === 0) return { restored: [], scannedTxids: fetchedTxids };

    // If this lookup throws, nothing is marked scanned and the whole batch retries later.
    const scripts = [...new Set(found.map((f) => hex.encode(f.offer.swapPkScript)))];
    const { vtxos } = await indexer.getVtxos({ scripts });

    const vtxoByScriptAndTxid = new Map(vtxos.map((v) => [`${v.script}:${v.txid}`, v]));

    // The caller's records supply the completion *time* only, never the classification.
    const txByAnyId = new Map<string, Tx>();
    for (const tx of txs) {
        for (const id of [tx.boardingTxid, tx.redeemTxid, tx.roundTxid]) {
            if (id) txByAnyId.set(id, tx);
        }
    }

    // Both halves of every spent deposit, fetched once for the whole batch.
    const spendTxids = new Set<string>();
    for (const { fundingTx, offer } of found) {
        const vtxo = vtxoByScriptAndTxid.get(
            `${hex.encode(offer.swapPkScript)}:${fundingTx.redeemTxid}`,
        );
        if (!vtxo?.isSpent) continue;
        for (const txid of spendTxidsOf(vtxo)) spendTxids.add(txid);
    }
    const spendTxByTxid = await fetchParsedTxs(indexer, [...spendTxids]);

    const restored: AssetSwap[] = [];
    const unresolved = new Set<string>();
    for (const { fundingTx, offer, offerHex, existing } of found) {
        const swapPkScript = hex.encode(offer.swapPkScript);
        const vtxo = vtxoByScriptAndTxid.get(`${swapPkScript}:${fundingTx.redeemTxid}`);
        if (!vtxo) {
            // Indexer sync lag: the deposit must exist for a tx the wallet funded, so retry.
            unresolved.add(fundingTx.redeemTxid);
            continue;
        }

        // The TLV names the deposit asset only for want-BTC offers; otherwise the vtxo's
        // rider does. Only a single rider is authoritative; anything else reads as BTC.
        const depositRider =
            vtxo.assets?.length === 1 && vtxo.assets[0].amount > BigInt(0)
                ? vtxo.assets[0]
                : undefined;
        const fromAsset = offer.offerAsset?.toString() ?? depositRider?.assetId ?? BTC_ASSET_ID;
        const toAsset = offer.wantAsset?.toString() ?? BTC_ASSET_ID;
        const depositAmount =
            fromAsset === BTC_ASSET_ID
                ? BigInt(vtxo.value)
                : vtxo.assets?.find((a) => a.assetId === fromAsset)?.amount;
        if (depositAmount === undefined) {
            // Asset not yet attached by the indexer: retry, never persist a zero amount.
            unresolved.add(fundingTx.redeemTxid);
            continue;
        }
        const fromAmount = depositAmount.toString();

        const spentTxid = vtxo.isSpent ? vtxo.arkTxId || vtxo.spentBy : undefined;
        // Chain fate only: a stored `cancelling` reads back as `pending`, and
        // cancel() retries from there.
        let status: AssetSwapStatus = "pending";
        if (vtxo.isSwept) status = "recoverable";
        else if (vtxo.isSpent) {
            const spendTxs = spendTxidsOf(vtxo)
                .map((id) => spendTxByTxid.get(id))
                .filter((tx): tx is Transaction => tx !== undefined);
            const kind = classifyDepositSpend(offer, operatorPubkey, spendTxs, {
                txid: vtxo.txid,
                vout: vtxo.vout,
            });
            if (kind === "indeterminate") {
                // Retry rather than persist a label that later scans would skip.
                unresolved.add(fundingTx.redeemTxid);
                continue;
            }
            status = kind;
        }

        const completion =
            status === "fulfilled" && spentTxid && txByAnyId.get(spentTxid)?.createdAt
                ? { completedAt: txByAnyId.get(spentTxid)!.createdAt! * 1000 }
                : {};

        if (existing) {
            if (status === "pending") continue;
            restored.push({ ...existing, status, spentTxid, ...completion });
            continue;
        }

        let swapAddress = "";
        try {
            const compiled = offerContract(offer, operatorPubkey);
            // A mismatch is a rotated operator key: leave the deposit unresolved
            // rather than persist an address cancel cannot spend from.
            if (hex.encode(compiled.pkScript) !== swapPkScript) {
                unresolved.add(fundingTx.redeemTxid);
                continue;
            }
            // ponytail(arkade-os/ts-sdk#680): without the prefix the address is
            // empty and cancel falls back to the current operator key
            if (hrp !== undefined) {
                swapAddress = compiled.address(hrp, operatorPubkey).encode();
            }
        } catch {
            unresolved.add(fundingTx.redeemTxid);
            continue;
        }

        restored.push({
            id: fundingTx.redeemTxid,
            fromAsset,
            toAsset,
            fromAmount,
            toAmount: offer.wantAmount.toString(),
            swapAddress,
            swapPkScript,
            offerHex,
            fundingTxid: fundingTx.redeemTxid,
            spentTxid,
            status,
            createdAt: fundingTx.createdAt ? fundingTx.createdAt * 1000 : vtxo.createdAt.getTime(),
            ...completion,
        });
    }
    return { restored, scannedTxids: fetchedTxids.filter((id) => !unresolved.has(id)) };
}
