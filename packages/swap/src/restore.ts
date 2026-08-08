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
import {
    Extension,
    RestIndexerProvider,
    Transaction,
    scriptFromTapLeafScript,
} from "@arkade-os/sdk";
import { decodeOffer, Offer, OFFER_PACKET_TYPE, offerVtxoScript } from "./offer";
import { BTC_ASSET_ID, type AssetSwap, type AssetSwapStatus } from "./store";

// ponytail: fixed request size; tune only if histories outgrow it
const TXS_PER_REQUEST = 50;

/**
 * The subset of a wallet transaction record the swap scan reads.
 *
 * No `assets`: a spend is classified from the covenant leaf it took, read off
 * the spending transaction itself (see {@link classifySpend}). A wallet
 * record's asset field is a net delta — an asset offer's cancel moves the asset
 * out and back, netting to nothing — so it cannot answer the question.
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

/**
 * Fetch and parse virtual txs, keyed by the psbt's own unsigned txid rather
 * than by response order. Chunks are independent requests and are issued
 * concurrently; a chunk that fails or a txid that does not come back is simply
 * absent from the result, which every caller reads as "unanswered, retry later"
 * — the property that keeps a partial response from orphaning a txid forever.
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
                // the SDK's Transaction.fromPSBT already allows unknown fields/outputs
                const parsed = Transaction.fromPSBT(base64.decode(psbt));
                parsedByTxid.set(parsed.id, parsed);
            } catch {
                // unattributable blob: its txid stays unanswered and retries
            }
        }
    }
    return parsedByTxid;
}

/** The candidate txs a scan would fetch: sent virtual txs with no stored swap
 * record and no previous authoritative answer. Module-local: `restoreAssetSwaps`
 * is the only caller, and exporting it would freeze this three-set signature
 * into the package's public API. */
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
 * What became of a deposit, as the spending transaction reports it.
 *
 * `indeterminate` is not a third outcome — it is the absence of one, and the
 * caller decides whether to retry or accept a default.
 */
export type SpendKind = "cancelled" | "fulfilled" | "indeterminate";

/**
 * Classify a spend by the covenant leaf it took.
 *
 * The covenant's whole vocabulary is two leaves: `cancel` returns the deposit
 * to the maker, `fulfill` is the solver paying for it. A submitted ark tx keeps
 * each input's `tapLeafScript`, so the spend *states* which one it used — this
 * reads an answer rather than inferring one.
 *
 * What it replaces, and why: the previous test asked what the transaction
 * moved. That works only while the deposit is invisible to the wallet. Once the
 * covenant is a registered contract the deposit joins the wallet's own coins,
 * every wallet-level asset figure becomes a *net* delta, and an asset offer's
 * cancel — asset out of the covenant, same asset back to the maker — nets to
 * zero and reads exactly like its fill. Leaves do not have that failure mode,
 * and they also survive batching: a solver filling several offers in one tx
 * gives each input its own leaf.
 *
 * `serverPubkey` must be the key the covenant was *funded* against. If it has
 * rotated since, the rebuilt script will not match the offer's own
 * `swapPkScript` and this returns `indeterminate` rather than guessing —
 * `cancelOffer` diagnoses the same mismatch the same way.
 */
export function classifySpend(
    offer: Offer,
    serverPubkey: Uint8Array,
    spendTx: Transaction,
    deposit: { txid: string; vout: number },
): SpendKind {
    let leaves: { cancel?: Uint8Array; fulfill?: Uint8Array };
    try {
        const script = offerVtxoScript(offer, serverPubkey);
        if (hex.encode(script.pkScript) !== hex.encode(offer.swapPkScript)) return "indeterminate";
        leaves = {
            cancel: script.functionByName("cancel")?.leafScript,
            fulfill: script.functionByName("fulfill")?.leafScript,
        };
    } catch {
        return "indeterminate"; // an offer whose covenant will not compile is not classifiable
    }

    for (let i = 0; i < spendTx.inputsLength; i++) {
        const input = spendTx.getInput(i);
        if (!input.txid || input.index !== deposit.vout) continue;
        if (hex.encode(input.txid) !== deposit.txid) continue;
        for (const leaf of input.tapLeafScript ?? []) {
            const spent = hex.encode(scriptFromTapLeafScript(leaf));
            if (leaves.cancel && spent === hex.encode(leaves.cancel)) return "cancelled";
            if (leaves.fulfill && spent === hex.encode(leaves.fulfill)) return "fulfilled";
        }
    }
    // the deposit left the covenant by neither leaf (a batch forfeit, say), or
    // the spend carries no tapleaf at all
    return "indeterminate";
}

/**
 * Scan the given candidates for offer packets and rebuild the AssetSwap
 * records the store lost. Returns the rebuilt swaps plus the txids that got
 * an authoritative answer (fetched fine, vtxo lookup fine) — the caller
 * persists those so they are never fetched again.
 *
 * ## A spent deposit is classified or left alone — never guessed
 *
 * Whether a spent deposit was filled or cancelled is read from the spending
 * transaction's covenant leaf ({@link classifySpend}), fetched from the same
 * indexer as everything else rather than from the `txs` you pass. A spend that
 * cannot be classified — not fetchable yet, or gone by neither leaf — leaves
 * the funding txid unanswered, so nothing is persisted and a later scan decides
 * it. Nothing sticky is written on a guess.
 *
 * That is a deliberate reversal: this used to restore an unclassifiable spend
 * as `fulfilled`, which a persisted record then made permanent, because the
 * spending tx came from the caller's possibly-lagging history. It no longer
 * does, so the `existingIds` escape hatch is no longer a correction mechanism
 * for a wrong label — it is only a skip list.
 *
 * `serverPubkey` must be the server key the covenants were funded against; a
 * key that has rotated since makes every affected swap unclassifiable rather
 * than misclassified.
 */
export async function restoreAssetSwaps(
    indexer: RestoreIndexer,
    txs: Tx[],
    existingIds: ReadonlySet<string>,
    opts: { serverPubkey: Uint8Array; scanned?: ReadonlySet<string> },
): Promise<{ restored: AssetSwap[]; scannedTxids: string[] }> {
    const { serverPubkey, scanned = new Set<string>() } = opts;
    const candidates = unscannedSwapCandidates(txs, existingIds, scanned);
    if (candidates.length === 0) return { restored: [], scannedTxids: [] };

    // fetch the raw txs and pick out the ones carrying an offer packet
    const byTxid = new Map(candidates.map((tx) => [tx.redeemTxid, tx]));
    const parsedByTxid = await fetchParsedTxs(
        indexer,
        candidates.map((tx) => tx.redeemTxid),
    );

    const fetchedTxids: string[] = [];
    const found: { fundingTx: Tx; offer: Offer; offerHex: string }[] = [];
    for (const [txid, parsed] of parsedByTxid) {
        const fundingTx = byTxid.get(txid);
        if (!fundingTx) continue;
        // only a txid whose psbt actually came back is answered — a chunk may
        // return fewer than requested, and blanket-marking the request would
        // orphan the missing ones forever (scans skip answered txids)
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

    // one vtxo lookup binds every funding deposit to its (possible) spend; if
    // it fails, nothing is marked scanned and the whole batch retries later
    const scripts = [...new Set(found.map((f) => hex.encode(f.offer.swapPkScript)))];
    const { vtxos } = await indexer.getVtxos({ scripts });

    // index the deposits the same way txs are indexed below: one pass, O(1)
    // lookups per restored swap instead of a scan over every returned vtxo
    const vtxoByScriptAndTxid = new Map(vtxos.map((v) => [`${v.script}:${v.txid}`, v]));

    // one O(txs) pass so each restored swap's spend lookup below is O(1). The
    // caller's records are consulted for the completion *time* only — the
    // classification comes from the spending psbt fetched below
    const txByAnyId = new Map<string, Tx>();
    for (const tx of txs) {
        for (const id of [tx.boardingTxid, tx.redeemTxid, tx.roundTxid]) {
            if (id) txByAnyId.set(id, tx);
        }
    }

    // every deposit that has been spent, so its spender can be fetched once for
    // the whole batch rather than per swap
    const spendTxids = new Set<string>();
    for (const { fundingTx, offer } of found) {
        const vtxo = vtxoByScriptAndTxid.get(
            `${hex.encode(offer.swapPkScript)}:${fundingTx.redeemTxid}`,
        );
        if (vtxo?.virtualStatus.state !== "spent") continue;
        const spentTxid = vtxo.arkTxId || vtxo.spentBy;
        if (spentTxid) spendTxids.add(spentTxid);
    }
    const spendTxByTxid = await fetchParsedTxs(indexer, [...spendTxids]);

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
        const fromAsset = offer.offerAsset?.toString() ?? depositRider?.assetId ?? BTC_ASSET_ID;
        const toAsset = offer.wantAsset?.toString() ?? BTC_ASSET_ID;
        const depositAmount =
            fromAsset === BTC_ASSET_ID
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
        const spentTxid = state === "spent" ? vtxo.arkTxId || vtxo.spentBy : undefined;
        let status: AssetSwapStatus = "pending";
        if (state === "swept") status = "recoverable";
        else if (state === "spent") {
            const spendTx = spentTxid ? spendTxByTxid.get(spentTxid) : undefined;
            const kind = spendTx
                ? classifySpend(offer, serverPubkey, spendTx, {
                      txid: vtxo.txid,
                      vout: vtxo.vout,
                  })
                : "indeterminate";
            if (kind === "indeterminate") {
                // the spender is not fetchable yet, or took neither covenant
                // leaf: retry rather than persist a label that later scans skip
                unresolved.add(fundingTx.redeemTxid);
                continue;
            }
            status = kind;
        }

        restored.push({
            id: fundingTx.redeemTxid,
            fromAsset,
            toAsset,
            fromAmount,
            toAmount: offer.wantAmount.toString(),
            // ponytail(arkade-os/ts-sdk#680): empty address makes cancel fall back
            // to the current server key; store the funded address if server-key
            // rotations become real (cancelOffer now at least diagnoses the
            // mismatch instead of reporting a missing VTXO)
            swapAddress: "",
            swapPkScript,
            offerHex,
            fundingTxid: fundingTx.redeemTxid,
            spentTxid,
            status,
            createdAt: fundingTx.createdAt ? fundingTx.createdAt * 1000 : vtxo.createdAt.getTime(),
            // the completion time is the caller's record of the spend, if it
            // has one — the psbt that classified it carries no timestamp
            ...(status === "fulfilled" && spentTxid && txByAnyId.get(spentTxid)?.createdAt
                ? { completedAt: txByAnyId.get(spentTxid)!.createdAt! * 1000 }
                : {}),
        });
    }
    return { restored, scannedTxids: fetchedTxids.filter((id) => !unresolved.has(id)) };
}
