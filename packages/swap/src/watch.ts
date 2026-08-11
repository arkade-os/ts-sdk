/**
 * Live offer status, driven by the wallet's own contract events.
 *
 * Before this, nothing told a user their offer had been filled: the deposit's
 * fate was only visible by re-running {@link restoreAssetSwaps}, a scan over
 * sent transactions. Now that `createOffer` registers the covenant with the
 * contract manager, the wallet is already watching that script and already
 * emits `vtxo_spent` for it — so the user's own wallet knows, and this module
 * turns that knowledge into a status.
 *
 * **Detection and classification are separate problems, answered separately.**
 * The event says a deposit was spent; it does not say by whom. The covenant's
 * `cancel` leaf is a 2-of-2 of the user and the server, so *only the user can
 * cancel* — which makes the cheapest classifier an exact one: a spend whose
 * txid is the one `cancelOffer` recorded is a cancel, and anything else that
 * spends an offer deposit is a fill. The fallback, for a cancel this device did
 * not make (another device, or a wiped store), reads the covenant leaf off the
 * spending transaction ({@link classifySpend}).
 *
 * What this deliberately does not do:
 *
 * - **Guess.** A spend that cannot be classified leaves the record untouched,
 *   for the restore scan to decide later. Writing a guess here is what made a
 *   wrong label permanent before: a stored swap is skipped by every later scan.
 * - **Own a second store.** Updates go through {@link AssetSwapRepository}, the
 *   package's one storage seam. `onUpdate` is a notification for UI
 *   reactivity, never an alternative sink.
 * - **Report funding.** `vtxo_received` needs no status: a funded offer is
 *   `pending`, which is what it already was.
 * - **Keep watching a script it has finished with.** A persisted terminal
 *   status retires the contract to `retained`, once nothing at that script
 *   still needs coverage ({@link retireOfferContract}).
 */
import { base64, hex } from "@scure/base";
import {
    ArkAddress,
    RestIndexerProvider,
    Transaction,
    type ContractEvent,
    type ContractVtxo,
    type IWallet,
} from "@arkade-os/sdk";
import { RETIRABLE, retireOfferContract } from "./coverage";
import { decodeOffer, OFFER_CONTRACT_KIND } from "./offer";
import type { AssetSwapRepository } from "./repository";
import { classifyDepositSpend, spendTxidsOf, type RestoreIndexer, type SpendKind } from "./restore";
import {
    getAssetSwaps,
    updateAssetSwapBestEffort,
    type AssetSwap,
    type AssetSwapStatus,
} from "./store";

/** Statuses a spend cannot move: the swap is already resolved.
 * @see RETIRABLE — a different question, and not the same set. */
const TERMINAL: readonly AssetSwapStatus[] = ["fulfilled", "cancelled", "recoverable"];

/**
 * The record change a classified spend implies, or `undefined` when it implies
 * none — an already-resolved swap, or a spend nobody could classify.
 *
 * Pure, so a consumer with its own store can apply the same transition without
 * taking the watcher, and so re-delivery of an event is a no-op rather than a
 * rewrite.
 */
export function spendUpdate(
    swap: AssetSwap,
    spend: { txid: string; kind: SpendKind; at?: number },
): Partial<Omit<AssetSwap, "id">> | undefined {
    if (TERMINAL.includes(swap.status)) return undefined;
    if (spend.kind === "indeterminate") return undefined;

    const status: AssetSwapStatus = spend.kind === "cancelled" ? "cancelled" : "fulfilled";
    return {
        status,
        spentTxid: spend.txid,
        // mirrors restore.ts: a completion time is a fill's, not a cancel's
        ...(status === "fulfilled" && spend.at ? { completedAt: spend.at } : {}),
    };
}

/** A running watcher. `idle()` exists because the writes are async: shutdown
 * and tests both need to know when in-flight updates have settled. */
export interface OfferSwapWatcher {
    stop(): void;
    idle(): Promise<void>;
}

export interface WatchOfferSwapsParams {
    wallet: IWallet;
    /** Same URL `createOffer`/`cancelOffer` take; used to read a spending tx
     * when the exact classifier cannot answer. */
    arkServerUrl: string;
    repository: AssetSwapRepository;
    /** Called after a change is persisted. A notification, not a store. */
    onUpdate?: (swap: AssetSwap) => void;
}

/**
 * Subscribe to the wallet's contract events and drive offer swap status.
 *
 * Registration ({@link createOffer}) is what makes this possible: only a
 * registered covenant is watched, so only registered offers produce events.
 * Offers funded before registration existed stay on the restore scan.
 *
 * This depends on the wallet's contract event transport. In Node, callers must
 * provide an `EventSource` implementation or use a runtime where it is enabled;
 * otherwise live updates do not arrive and restore remains the fallback.
 */
export async function watchOfferSwaps({
    wallet,
    arkServerUrl,
    repository,
    onUpdate,
}: WatchOfferSwapsParams): Promise<OfferSwapWatcher> {
    const manager = await wallet.getContractManager();
    // Current server key at watcher start. TODO: persist the funding-time key
    // with swap records; a signer rotation during a long session makes leaf
    // classification return indeterminate rather than guessing.
    const serverPubkey = ArkAddress.decode(await wallet.getAddress()).serverPubKey;
    const indexer: RestoreIndexer = new RestIndexerProvider(arkServerUrl);

    // events arrive independently but the update is read-modify-write over
    // the whole list, so two concurrent handlers would lose one of the writes
    let queue: Promise<void> = Promise.resolve();
    const enqueue = (task: () => Promise<void>): void => {
        queue = queue.then(task).catch(() => {
            // a handler must never reject into the manager's dispatch loop; an
            // unwritten record stays recoverable through the restore scan
        });
    };

    const classify = async (swap: AssetSwap, vtxo: ContractVtxo, spentTxid: string) => {
        // the exact answer: only the user can cancel, and cancelOffer records
        // the txid it submitted
        if (swap.spentTxid === spentTxid && swap.status === "cancelling") return "cancelled";
        try {
            // both halves of the spend: the checkpoint carries the deposit
            // outpoint, the ark tx is the id the record and history name
            const candidates = spendTxidsOf(vtxo);
            if (candidates.length === 0) return "indeterminate";
            const { txs } = await indexer.getVirtualTxs(candidates);
            return classifyDepositSpend(
                decodeOffer(hex.decode(swap.offerHex)),
                serverPubkey,
                txs.map((psbt) => Transaction.fromPSBT(base64.decode(psbt))),
                { txid: vtxo.txid, vout: vtxo.vout },
            );
        } catch {
            return "indeterminate" as const;
        }
    };

    const handleSpend = async (event: Extract<ContractEvent, { type: "vtxo_spent" }>) => {
        if (event.contract.metadata?.kind !== OFFER_CONTRACT_KIND) return;

        for (const vtxo of event.vtxos) {
            const spentTxid = vtxo.arkTxId || vtxo.spentBy;
            if (!spentTxid) continue;
            // Identical offers share one script and are told apart by the
            // deposit that funded them. Repository v1 has no indexed lookup, so
            // this is O(history) per spend event; add a query API if offer
            // event volume makes this hot.
            const swap = (await getAssetSwaps(repository)).find(
                (s) => s.fundingTxid === vtxo.txid && s.swapPkScript === event.contractScript,
            );
            if (!swap) continue;

            const kind: SpendKind = await classify(swap, vtxo, spentTxid);
            const changes = spendUpdate(swap, { txid: spentTxid, kind, at: event.timestamp });
            if (!changes) continue;

            // notify only on a write that landed: `onUpdate` is documented as
            // firing after the change is persisted, and a consumer that caches
            // from it would otherwise run ahead of the store
            const { persisted, swaps } = await updateAssetSwapBestEffort(
                repository,
                swap.id,
                changes,
            );
            // a lost write must not retire: the next restore scan still
            // believes this deposit is live
            if (!persisted) continue;
            onUpdate?.({ ...swap, ...changes });
            // `swaps` is the post-update view, so the liveness check sees this
            // record's new status without a third read
            if (changes.status && RETIRABLE.includes(changes.status)) {
                await retireOfferContract(manager, swaps, event.contractScript);
            }
        }
    };

    const unsubscribe = manager.onContractEvent((event) => {
        if (event.type !== "vtxo_spent") return;
        enqueue(() => handleSpend(event));
    });

    return {
        stop: unsubscribe,
        idle: () => queue,
    };
}
