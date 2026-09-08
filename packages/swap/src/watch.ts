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
 * spending transaction ({@link classifyDepositSpend}).
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
 *
 * Layout: the public surface comes first — {@link spendUpdate}, the pure
 * transition, then {@link watchOfferSwaps}, which reads as the sequence it
 * performs. Everything below it is module-private machinery, taking the
 * watcher's dependencies as an explicit {@link WatchContext} rather than
 * closing over them.
 */
import { base64, hex } from "@scure/base";
import {
    ArkAddress,
    isContractVtxoEvent,
    RestIndexerProvider,
    Transaction,
    type ContractVtxoEvent,
    type IContractManager,
    type IWallet,
} from "@arkade-os/sdk";
import { RETIRABLE, retireOfferContract, type OfferContractRetirer } from "./coverage";
import { decodeOffer, ensureOfferContracts, OFFER_CONTRACT_KIND } from "./offer";
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
 * Records whose deposit may still be at the covenant, and whose script this
 * watcher therefore needs registered: everything a spend could still move,
 * plus `recoverable`, which keeps its script watched (see `RETIRABLE`).
 * `cancelling` is in: the cancel may have failed to broadcast, and a record
 * stuck there is exactly one the watcher has to be able to hear about.
 */
const NEEDS_COVERAGE: readonly AssetSwapStatus[] = ["pending", "cancelling", "recoverable"];

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
 *
 * **Starting the watcher re-covers what it is asked to watch, and reconciles
 * it.** Every record in the repository whose deposit may still be at its
 * covenant gets that covenant registered ({@link ensureOfferContracts}) — a
 * no-op for offers this wallet created, and the missing registration for
 * records the restore scan rebuilt on a wallet that never made them. Only a
 * registered script produces the events this watcher runs on. Registration
 * alone is not enough, though: a deposit spent *before* its script was
 * covered produces no event — the manager hydrates it already spent and the
 * watch baseline starts past it — so each covered record is then read off the
 * indexer once and a spend found there is classified exactly as an event
 * would be. The sweep is best effort and runs after the subscription is in
 * place, so a spend landing mid-sweep is still delivered; a record it could
 * not cover is logged and is tried again at the next start.
 */
export async function watchOfferSwaps({
    wallet,
    arkServerUrl,
    repository,
    onUpdate,
}: WatchOfferSwapsParams): Promise<OfferSwapWatcher> {
    const manager = await wallet.getContractManager();
    const context: WatchContext = {
        manager,
        indexer: new RestIndexerProvider(arkServerUrl),
        repository,
        // Current server key at watcher start. TODO: persist the funding-time
        // key with swap records; a signer rotation during a long session makes
        // leaf classification return indeterminate rather than guessing.
        serverPubkey: ArkAddress.decode(await wallet.getAddress()).serverPubKey,
        onUpdate,
    };

    // events arrive independently but the update is read-modify-write over
    // the whole list, so two concurrent handlers would lose one of the writes
    let queue: Promise<void> = Promise.resolve();
    const enqueue = (task: () => Promise<void>): void => {
        queue = queue.then(task).catch(() => {
            // a handler must never reject into the manager's dispatch loop; an
            // unwritten record stays recoverable through the restore scan
        });
    };

    const unsubscribe = manager.onContractEvent((event) => {
        // An offer is an owned contract; a watched script has no `metadata`.
        if (!isContractVtxoEvent(event) || event.type !== "vtxo_spent") return;
        enqueue(() => handleSpendEvent(context, event));
    });

    // After subscribing, never before: registration is what starts the
    // manager's own watch on a script, and an event it delivers during the
    // sweep must find a handler already attached.
    const uncovered = await liveOfferRecords(repository);
    await coverLiveOffers(wallet, arkServerUrl, uncovered);
    // Through the queue, like an event: a spend delivered mid-sweep and the
    // reconcile of the same deposit must not write over each other. Not
    // awaited — `idle()` is how a caller waits for it — so a slow indexer
    // delays the reconcile, never the watcher.
    for (const swap of uncovered) enqueue(() => reconcileQuietly(context, swap));
    enqueue(() => retireUntouchedScripts(context, uncovered));

    return {
        stop: unsubscribe,
        idle: () => queue,
    };
}

// ── internals ────────────────────────────────────────────────────────────────

/** The two halves of a spend, as an event or the indexer reports them. */
type SpentDeposit = { txid: string; vout: number; arkTxId?: string; spentBy?: string };

/** The contract-manager surface the helpers below use, and no more. */
type OfferWatchManager = OfferContractRetirer & Pick<IContractManager, "getContracts">;

/**
 * What a running watcher hands its helpers: the dependencies they read, passed
 * rather than closed over, so each step below is callable — and testable — on
 * its own.
 */
interface WatchContext {
    manager: OfferWatchManager;
    indexer: RestoreIndexer;
    repository: AssetSwapRepository;
    /** Server key as of watcher start; the leaf classifier rebuilds against it. */
    serverPubkey: Uint8Array;
    onUpdate?: (swap: AssetSwap) => void;
}

/** The records whose covenant may still hold a deposit, so still need coverage. */
async function liveOfferRecords(repository: AssetSwapRepository): Promise<AssetSwap[]> {
    return (await getAssetSwaps(repository)).filter(
        (swap) => typeof swap.offerHex === "string" && NEEDS_COVERAGE.includes(swap.status),
    );
}

/**
 * Register every live record's covenant. Best effort: a record left uncovered
 * is logged and tried again at the next start, rather than failing the watcher
 * that the other records still need.
 */
async function coverLiveOffers(
    wallet: IWallet,
    arkServerUrl: string,
    uncovered: readonly AssetSwap[],
): Promise<void> {
    try {
        await ensureOfferContracts(
            wallet,
            arkServerUrl,
            uncovered.map((swap) => ({
                offerHex: swap.offerHex,
                ...(swap.swapAddress ? { swapAddress: swap.swapAddress } : {}),
            })),
        );
    } catch (err) {
        console.warn("[swap] could not re-register every live offer covenant", err);
    }
}

/** What became of a deposit, exactly where the record can say so and off the
 * spending transaction's covenant leaf where it cannot. */
async function spendKindOf(
    { indexer, serverPubkey }: WatchContext,
    swap: AssetSwap,
    vtxo: SpentDeposit,
    spentTxid: string,
): Promise<SpendKind> {
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
        return "indeterminate";
    }
}

/**
 * What a classified spend does to its record: written, announced, and the
 * script retired once nothing live is left at it. One path for a spend an
 * event delivers and for one the start-up reconcile finds on the indexer.
 */
async function applySpend(
    context: WatchContext,
    swap: AssetSwap,
    vtxo: SpentDeposit,
    spentTxid: string,
    at?: number,
): Promise<void> {
    const { manager, repository, onUpdate } = context;
    const kind = await spendKindOf(context, swap, vtxo, spentTxid);
    const changes = spendUpdate(swap, { txid: spentTxid, kind, at });
    if (!changes) return;

    // notify only on a write that landed: `onUpdate` is documented as
    // firing after the change is persisted, and a consumer that caches
    // from it would otherwise run ahead of the store
    const { persisted, swaps } = await updateAssetSwapBestEffort(repository, swap.id, changes);
    // a lost write must not retire: the next restore scan still
    // believes this deposit is live
    if (!persisted) return;
    onUpdate?.({ ...swap, ...changes });
    // `swaps` is the post-update view, so the liveness check sees this
    // record's new status without a third read
    if (changes.status && RETIRABLE.includes(changes.status)) {
        await retireOfferContract(manager, swaps, swap.swapPkScript);
    }
}

/** A `vtxo_spent` the manager delivered, resolved against the records it names. */
async function handleSpendEvent(
    context: WatchContext,
    event: Extract<ContractVtxoEvent, { type: "vtxo_spent" }>,
): Promise<void> {
    if (event.contract.metadata?.kind !== OFFER_CONTRACT_KIND) return;

    for (const vtxo of event.vtxos) {
        const spentTxid = vtxo.arkTxId || vtxo.spentBy;
        if (!spentTxid) continue;
        // Identical offers share one script and are told apart by the
        // deposit that funded them. Repository v1 has no indexed lookup, so
        // this is O(history) per spend event; add a query API if offer
        // event volume makes this hot.
        const swap = (await getAssetSwaps(context.repository)).find(
            (s) => s.fundingTxid === vtxo.txid && s.swapPkScript === event.contractScript,
        );
        if (!swap) continue;
        await applySpend(context, swap, vtxo, spentTxid, event.timestamp);
    }
}

/**
 * The fate of a deposit the sweep just covered, read off the indexer. A
 * spend that happened while the script was uncovered never becomes an
 * event: this is the one read that catches it. A deposit not indexed yet
 * is left alone — its event will come, or the next start will look again.
 */
async function reconcileDeposit(context: WatchContext, swap: AssetSwap): Promise<void> {
    const { indexer, repository, onUpdate } = context;
    const { vtxos } = await indexer.getVtxos({ scripts: [swap.swapPkScript] });
    const vtxo = vtxos.find((v) => v.txid === swap.fundingTxid);
    if (!vtxo) return;
    if (vtxo.virtualStatus.state === "swept") {
        // mirrors restore.ts: a swept deposit is still the user's money at
        // that script, so it keeps its script watched and is never retired
        if (swap.status === "recoverable") return;
        const changes = { status: "recoverable" as const };
        const { persisted } = await updateAssetSwapBestEffort(repository, swap.id, changes);
        if (persisted) onUpdate?.({ ...swap, ...changes });
        return;
    }
    if (vtxo.virtualStatus.state !== "spent") return;
    const spentTxid = vtxo.arkTxId || vtxo.spentBy;
    if (!spentTxid) return;
    // No timestamp available on this path: the indexer VTXO only carries
    // `createdAt` (its own creation), not the spend's time. A reload caught
    // here is persisted without `completedAt`; the consumer re-queries the
    // spending transaction if it needs the fill time.
    await applySpend(context, swap, vtxo, spentTxid);
}

/** {@link reconcileDeposit}, logged rather than thrown: one unreachable indexer
 * must not stop the records behind it in the queue. */
async function reconcileQuietly(context: WatchContext, swap: AssetSwap): Promise<void> {
    try {
        await reconcileDeposit(context, swap);
    } catch (err) {
        console.warn(`[swap] could not reconcile offer ${swap.id} after covering it`, err);
    }
}

/**
 * A settlement that landed mid-sweep retired its script before the sweep put it
 * back in the watched set, and nothing would retire it again: re-derive
 * liveness from the records as they stand now, for the scripts the sweep
 * touched and left watched. `retireOfferContract` leaves a live script alone; a
 * row the reconcile already retired is not written twice.
 */
async function retireUntouchedScripts(
    { manager, repository }: WatchContext,
    uncovered: readonly AssetSwap[],
): Promise<void> {
    const swaps = await getAssetSwaps(repository);
    for (const script of new Set(uncovered.map((swap) => swap.swapPkScript))) {
        const [row] = await manager.getContracts({ script });
        if (!row) continue; // never registered (partial ensureOfferContracts failure)
        if (row.watch === "retained") continue;
        await retireOfferContract(manager, swaps, script);
    }
}
