/**
 * Rebuild swap records after a wallet restore.
 *
 * The swap store dies with its storage backend, but everything a consumer
 * needs is recomputable from chain data: the funding tx we sent carries the
 * offer packet (type 0x03) in its extension, the covenant vtxo at the offer's
 * script holds the deposit, and that vtxo's spender is the completion (or
 * cancel) tx. Scan the sent virtual txs, decode the offers, and bind each
 * funding vtxo to its spend.
 *
 * The scan is incremental: txids checked with an authoritative answer are
 * remembered, so late-synced history is picked up by later scans and nothing
 * is ever fetched twice.
 */
import { base64, hex } from "@scure/base";
import { Extension, RestIndexerProvider, Transaction } from "@arkade-os/sdk";
import { decodeOffer, Offer, OFFER_PACKET_TYPE } from "./offer";
import type { AssetSwap, AssetSwapStatus } from "./store";

// ponytail: fixed request size; tune only if histories outgrow it
const TXS_PER_REQUEST = 50;

/** The subset of a wallet transaction record the swap scan reads. */
export interface Tx {
    type: string;
    /** The virtual (ark) txid; the funding tx's identity. */
    redeemTxid: string;
    boardingTxid?: string;
    roundTxid?: string;
    /** Unix seconds. */
    createdAt?: number;
    assets?: { assetId: string; amount: bigint }[];
}

/** The indexer surface the restore scan needs — narrower than a full provider. */
export type RestoreIndexer = Pick<RestIndexerProvider, "getVirtualTxs" | "getVtxos">;

/** The candidate txs a scan would fetch: sent virtual txs with no stored swap
 * record and no previous authoritative answer. */
export const unscannedSwapCandidates = (
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

/** The cancel spend returns the deposit: a BTC offer gets its sats back (no
 * want-asset delivered), an asset offer gets the asset back. */
export function isCancelSpend(offer: Offer, spend: Tx): boolean {
    if (offer.wantAsset) {
        const wantId = offer.wantAsset.toString();
        return !spend.assets?.some((a) => a.assetId === wantId && a.amount > BigInt(0));
    }
    const offerId = offer.offerAsset!.toString();
    return Boolean(spend.assets?.some((a) => a.assetId === offerId && a.amount > BigInt(0)));
}

/**
 * Scan the given candidates for offer packets and rebuild the AssetSwap
 * records the store lost. Returns the rebuilt swaps plus the txids that got
 * an authoritative answer (fetched fine, vtxo lookup fine) — the caller
 * persists those so they are never fetched again.
 *
 * ## Caller contract: cancelled swaps can be restored as `fulfilled`
 *
 * Whether a spent deposit was filled or cancelled is only decidable from the
 * spending tx, which this scan looks up in the `txs` you pass. When the
 * deposit reads as spent but its spender is not in `txs` yet (the wallet's own
 * history still syncing), the swap is restored as `fulfilled` — the likelier
 * reading, since a maker-initiated cancel normally has its tx locally.
 *
 * That guess is **not** revisited: once you persist the record, its id lands
 * in `existingIds` and every later scan skips it. A swap the user cancelled
 * can therefore stay labelled `fulfilled` forever.
 *
 * A restore-only integration has no way to correct this, so callers should
 * also feed live spend events (the solver's SSE stream) into
 * `updateAssetSwap`, which is what closes the window in practice. If you
 * cannot, and a mislabel is worse for you than a re-scan, drop the affected
 * record from the repository: a swap that is no longer in `existingIds` is
 * scanned again and re-decided against a fuller `txs`.
 */
export async function restoreAssetSwaps(
    indexer: RestoreIndexer,
    txs: Tx[],
    existingIds: ReadonlySet<string>,
    scanned: ReadonlySet<string> = new Set(),
): Promise<{ restored: AssetSwap[]; scannedTxids: string[] }> {
    const candidates = unscannedSwapCandidates(txs, existingIds, scanned);
    if (candidates.length === 0) return { restored: [], scannedTxids: [] };

    // fetch the raw txs and pick out the ones carrying an offer packet, binding
    // by the PSBT's own unsigned txid rather than trusting response order; a
    // failed chunk is simply not marked scanned and retries on a later scan.
    // Chunks are independent requests, so fetch them all concurrently.
    const byTxid = new Map(candidates.map((tx) => [tx.redeemTxid, tx]));
    const chunks: string[][] = [];
    for (let i = 0; i < candidates.length; i += TXS_PER_REQUEST) {
        chunks.push(candidates.slice(i, i + TXS_PER_REQUEST).map((tx) => tx.redeemTxid));
    }
    const chunkResults = await Promise.allSettled(
        chunks.map(async (txids) => (await indexer.getVirtualTxs(txids)).txs),
    );

    const fetchedTxids: string[] = [];
    const found: { fundingTx: Tx; offer: Offer; offerHex: string }[] = [];
    for (const result of chunkResults) {
        if (result.status !== "fulfilled") continue;
        for (const psbt of result.value) {
            let parsed: Transaction;
            try {
                // the SDK's Transaction.fromPSBT already allows unknown fields/outputs
                parsed = Transaction.fromPSBT(base64.decode(psbt));
            } catch {
                continue; // unattributable blob: its txid stays unscanned and retries
            }
            const fundingTx = byTxid.get(parsed.id);
            if (!fundingTx) continue;
            // only a txid whose psbt actually came back is answered — a chunk may
            // return fewer than requested, and blanket-marking the request would
            // orphan the missing ones forever (scans skip answered txids)
            fetchedTxids.push(parsed.id);
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
    }
    if (found.length === 0) return { restored: [], scannedTxids: fetchedTxids };

    // one vtxo lookup binds every funding deposit to its (possible) spend; if
    // it fails, nothing is marked scanned and the whole batch retries later
    const scripts = [...new Set(found.map((f) => hex.encode(f.offer.swapPkScript)))];
    const { vtxos } = await indexer.getVtxos({ scripts });

    // index the deposits the same way txs are indexed below: one pass, O(1)
    // lookups per restored swap instead of a scan over every returned vtxo
    const vtxoByScriptAndTxid = new Map(vtxos.map((v) => [`${v.script}:${v.txid}`, v]));

    // one O(txs) pass so each restored swap's spend lookup below is O(1)
    const txByAnyId = new Map<string, Tx>();
    for (const tx of txs) {
        for (const id of [tx.boardingTxid, tx.redeemTxid, tx.roundTxid]) {
            if (id) txByAnyId.set(id, tx);
        }
    }

    const restored: AssetSwap[] = [];
    const unresolved = new Set<string>();
    for (const { fundingTx, offer, offerHex } of found) {
        const swapPkScript = hex.encode(offer.swapPkScript);
        const vtxo = vtxoByScriptAndTxid.get(`${swapPkScript}:${fundingTx.redeemTxid}`);
        if (!vtxo) {
            // the funding tx carries an offer but its deposit isn't listed yet
            // (indexer sync lag): leave the txid unscanned so a later scan retries
            // — the deposit vtxo must exist for a tx the wallet itself funded
            unresolved.add(fundingTx.redeemTxid);
            continue;
        }

        // the TLV names the deposit only for want-BTC offers; otherwise the
        // funding vtxo's own rider identifies it (asset↔asset swaps deposit an
        // asset under a want-asset offer, plain BTC deposits carry no rider).
        // Only an unambiguous single rider is authoritative — anything else
        // (out-of-spec extra riders) falls back to the BTC reading.
        const depositRider =
            vtxo.assets?.length === 1 && vtxo.assets[0].amount > BigInt(0)
                ? vtxo.assets[0]
                : undefined;
        const fromAsset = offer.offerAsset?.toString() ?? depositRider?.assetId ?? "btc";
        const toAsset = offer.wantAsset?.toString() ?? "btc";
        const depositAmount =
            fromAsset === "btc"
                ? BigInt(vtxo.value)
                : vtxo.assets?.find((a) => a.assetId === fromAsset)?.amount;
        if (depositAmount === undefined) {
            // the TLV declares a deposit asset the indexer hasn't attached to the
            // vtxo yet: retry later rather than persisting a zero-amount record
            unresolved.add(fundingTx.redeemTxid);
            continue;
        }
        const fromAmount = depositAmount.toString();

        const state = vtxo.virtualStatus.state;
        const spentTxid = state === "spent" ? (vtxo.arkTxId ?? vtxo.spentBy) : undefined;
        const spendTx = spentTxid ? txByAnyId.get(spentTxid) : undefined;
        // TODO(arkade-os/wallet#836): if state === 'spent' but spendTx hasn't synced
        // locally yet, status defaults to 'fulfilled' — a genuinely cancelled swap
        // could be permanently mislabeled, since a persisted swap is skipped by
        // future scans (see existingIds in unscannedSwapCandidates). No safer
        // default exists without local wallet-initiated-cancel tracking (the live
        // SSE monitor in the wallet has the same gap).
        let status: AssetSwapStatus = "pending";
        if (state === "swept") status = "recoverable";
        else if (state === "spent")
            status = spendTx && isCancelSpend(offer, spendTx) ? "cancelled" : "fulfilled";

        restored.push({
            id: fundingTx.redeemTxid,
            fromAsset,
            toAsset,
            fromAmount,
            toAmount: offer.wantAmount.toString(),
            // ponytail: empty address makes cancel fall back to the current server
            // key; store the funded address if server-key rotations become real
            swapAddress: "",
            swapPkScript,
            offerHex,
            fundingTxid: fundingTx.redeemTxid,
            spentTxid,
            status,
            createdAt: fundingTx.createdAt ? fundingTx.createdAt * 1000 : vtxo.createdAt.getTime(),
            ...(status === "fulfilled" && spendTx?.createdAt
                ? { completedAt: spendTx.createdAt * 1000 }
                : {}),
        });
    }
    return { restored, scannedTxids: fetchedTxids.filter((id) => !unresolved.has(id)) };
}
