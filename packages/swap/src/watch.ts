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
    Transaction,
    type ContractEvent,
    type ContractVtxo,
    type IWallet,
} from "@arkade-os/sdk";
import { RETIRABLE, retireOfferContract } from "./coverage";
import { decodeOffer, OFFER_CONTRACT_KIND } from "./offer";
import type { AssetSwapRepository } from "./repository";
import { classifyDepositSpend, spendTxidsOf, type SpendKind } from "./restore";
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
 * What this watcher needs to know about an offer swap.
 *
 * Structural, and narrower than {@link AssetSwap}, because two record families
 * now answer the same question. v1 keys its records on the funding txid — the
 * deposit IS the identity, so no record can exist before the money does — while
 * the v2 client keys on the quote id and writes the record BEFORE funding, with
 * `fundingTxid` a later best-effort write. Projecting the second onto the first
 * is impossible for the whole pre-funding window, so the parameter widens
 * instead: `id` is whatever key the source stores under, and the spend is
 * matched on `fundingTxid` and `swapPkScript`, which both families carry.
 *
 * `createdAt` is unix **milliseconds**, the unit `coverage.ts` marks issuance
 * in; see {@link CoveredSwap}.
 */
export interface OfferSwapFacts {
    readonly id: string;
    readonly status: AssetSwapStatus;
    /** The TLV offer, hex — what {@link classifyDepositSpend} needs. */
    readonly offerHex: string;
    readonly swapPkScript: string;
    readonly fundingTxid?: string;
    readonly spentTxid?: string;
    readonly createdAt: number;
}

/** The record change a classified spend implies. */
export interface OfferSpendChanges {
    readonly status: AssetSwapStatus;
    readonly spentTxid: string;
    readonly completedAt?: number;
}

/**
 * Where the watcher reads offer records and writes their spends.
 *
 * One seam, two implementations: {@link assetSwapSource} over v1's store, and
 * the v2 client's own over its quote-id-keyed record store. `apply` returns
 * both halves for the same reason `updateAssetSwapBestEffort` does — a lost
 * write must not retire a script, and the post-update view is what the liveness
 * check reads without a third round trip.
 */
export interface OfferSwapSource<S extends OfferSwapFacts = OfferSwapFacts> {
    list(): Promise<S[]>;
    apply(swap: S, changes: OfferSpendChanges): Promise<{ persisted: boolean; swaps: S[] }>;
}

/** v1's store, as an {@link OfferSwapSource}. The default when a caller passes
 * a repository rather than a source. */
export const assetSwapSource = (repository: AssetSwapRepository): OfferSwapSource<AssetSwap> => ({
    list: () => getAssetSwaps(repository),
    apply: async (swap, changes) => updateAssetSwapBestEffort(repository, swap.id, changes),
});

/**
 * The record change a classified spend implies, or `undefined` when it implies
 * none — an already-resolved swap, or a spend nobody could classify.
 *
 * Pure, so a consumer with its own store can apply the same transition without
 * taking the watcher, and so re-delivery of an event is a no-op rather than a
 * rewrite.
 */
export function spendUpdate(
    swap: Pick<OfferSwapFacts, "status">,
    spend: { txid: string; kind: SpendKind; at?: number },
): OfferSpendChanges | undefined {
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

export interface WatchOfferSwapsParams<S extends OfferSwapFacts = OfferSwapFacts> {
    wallet: IWallet;
    /** v1's record source. Ignored when {@link source} is given. */
    repository?: AssetSwapRepository;
    /** Where records are read and spends written. Defaults to
     * {@link assetSwapSource} over `repository`. */
    source?: OfferSwapSource<S>;
    /** Called after a change is persisted. A notification, not a store. */
    onUpdate?: (swap: S) => void;
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
export async function watchOfferSwaps(params: {
    wallet: IWallet;
    repository: AssetSwapRepository;
    onUpdate?: (swap: AssetSwap) => void;
}): Promise<OfferSwapWatcher>;
export async function watchOfferSwaps<S extends OfferSwapFacts>(params: {
    wallet: IWallet;
    source: OfferSwapSource<S>;
    onUpdate?: (swap: S) => void;
}): Promise<OfferSwapWatcher>;
export async function watchOfferSwaps<S extends OfferSwapFacts>({
    wallet,
    repository,
    source,
    onUpdate,
}: WatchOfferSwapsParams<S>): Promise<OfferSwapWatcher> {
    if (!source && !repository) {
        throw new Error("watchOfferSwaps needs either a record source or a repository");
    }
    // The cast is the overload's seam: the first signature fixes `S` to
    // `AssetSwap` for the repository form, and only the implementation
    // signature — which admits both — has to reconcile them.
    const records: OfferSwapSource<S> =
        source ??
        (assetSwapSource(repository as AssetSwapRepository) as unknown as OfferSwapSource<S>);
    // Independent, and on a service-worker wallet the first two are each a
    // round trip to the worker — serialized they cost twice the startup.
    // The reader is the wallet's own, so that read stays inside the worker
    // rather than opening a second connection page-side.
    const [manager, address, indexer] = await Promise.all([
        wallet.getContractManager(),
        wallet.getAddress(),
        wallet.getArkadeReader(),
    ]);
    // Current server key at watcher start. TODO: persist the funding-time key
    // with swap records; a signer rotation during a long session makes leaf
    // classification return indeterminate rather than guessing.
    const operatorPubkey = ArkAddress.decode(address).serverPubKey;

    // events arrive independently but the update is read-modify-write over
    // the whole list, so two concurrent handlers would lose one of the writes
    let queue: Promise<void> = Promise.resolve();
    const enqueue = (task: () => Promise<void>): void => {
        queue = queue.then(task).catch(() => {
            // a handler must never reject into the manager's dispatch loop; an
            // unwritten record stays recoverable through the restore scan
        });
    };

    const classify = async (swap: S, vtxo: ContractVtxo, spentTxid: string) => {
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
                operatorPubkey,
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
            const swap = (await records.list()).find(
                (s) => s.fundingTxid === vtxo.txid && s.swapPkScript === event.contractScript,
            );
            if (!swap) continue;

            const kind: SpendKind = await classify(swap, vtxo, spentTxid);
            const changes = spendUpdate(swap, { txid: spentTxid, kind, at: event.timestamp });
            if (!changes) continue;

            // notify only on a write that landed: `onUpdate` is documented as
            // firing after the change is persisted, and a consumer that caches
            // from it would otherwise run ahead of the store
            const { persisted, swaps } = await records.apply(swap, changes);
            // a lost write must not retire: the next restore scan still
            // believes this deposit is live
            if (!persisted) continue;
            // The record as the store now holds it, not a local merge: the
            // notification is documented as firing after the write, so it
            // should carry what the write produced.
            onUpdate?.(swaps.find((s) => s.id === swap.id) ?? swap);
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
