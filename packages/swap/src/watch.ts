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
    isContractVtxoEvent,
    RestIndexerProvider,
    Transaction,
    type ContractVtxo,
    type ContractVtxoEvent,
    type IWallet,
} from "@arkade-os/sdk";
import { RETIRABLE, retireOfferContract } from "./coverage";
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

/** Statuses whose covenant may still hold a deposit, so still need coverage.
 * Broader than restore's live set: includes `cancelling` (a cancel in flight
 * may still be resolved by a spend the watcher later hears about). */
const NEEDS_COVERAGE: readonly AssetSwapStatus[] = ["pending", "cancelling", "recoverable"];

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
 * *Live* updates depend on the wallet's contract event transport. In Node,
 * callers must provide an `EventSource` implementation or use a runtime where
 * it is enabled. The start-up pass needs none of it.
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
 * indexer once (and via the manager's contract view) and a spend found there
 * is classified exactly as an event would be. The sweep is best effort and
 * runs after the subscription is in place, so a spend landing mid-sweep is
 * still delivered; a record it could not cover is logged and is tried again
 * at the next start.
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

    const resolveSpends = async (contractScript: string, vtxos: ContractVtxo[], at?: number) => {
        for (const vtxo of vtxos) {
            const spentTxid = vtxo.arkTxId || vtxo.spentBy;
            if (!spentTxid) continue;
            // Identical offers share one script and are told apart by the
            // deposit that funded them. Repository v1 has no indexed lookup, so
            // this is O(history) per spend event; add a query API if offer
            // event volume makes this hot.
            const swap = (await getAssetSwaps(repository)).find(
                (s) => s.fundingTxid === vtxo.txid && s.swapPkScript === contractScript,
            );
            if (!swap) continue;

            const kind: SpendKind = await classify(swap, vtxo, spentTxid);
            const changes = spendUpdate(swap, { txid: spentTxid, kind, at });
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
                await retireOfferContract(manager, swaps, contractScript);
            }
        }
    };

    const handleSpend = async (event: Extract<ContractVtxoEvent, { type: "vtxo_spent" }>) => {
        if (event.contract.metadata?.kind !== OFFER_CONTRACT_KIND) return;
        await resolveSpends(event.contractScript, event.vtxos, event.timestamp);
    };

    /**
     * Answer, once, what became of every deposit no event ever reported:
     * `ContractManager.initialize` reconciles before it installs its watcher
     * callback and `create` awaits it, so no subscriber can observe the boot
     * sync. Passes no `at` — the manager's view carries no spend time, and
     * `Date.now()` would record the scan as the completion.
     */
    const resolveOpenSwaps = async () => {
        const open = (await getAssetSwaps(repository)).filter((s) => !TERMINAL.includes(s.status));
        if (open.length === 0) return;
        const script = [...new Set(open.map((s) => s.swapPkScript))];
        for (const { contract, vtxos } of await manager.getContractsWithVtxos({ script })) {
            if (contract.metadata?.kind !== OFFER_CONTRACT_KIND) continue;
            await resolveSpends(
                contract.script,
                vtxos.filter((v) => v.isSpent),
            );
        }
    };

    /**
     * Indexer backstop for deposits spent or swept while a script was
     * uncovered: the manager's view only sees contracts it already held, and
     * a newly covered spent deposit produces no event. Swept → recoverable is
     * invisible to {@link resolveOpenSwaps} (it only looks at `isSpent`).
     */
    const reconcileFromIndexer = async (swap: AssetSwap) => {
        try {
            const { vtxos } = await indexer.getVtxos({ scripts: [swap.swapPkScript] });
            const vtxo = vtxos.find((v) => v.txid === swap.fundingTxid);
            if (!vtxo) return;
            if (vtxo.virtualStatus.state === "swept") {
                if (swap.status === "recoverable") return;
                const changes = { status: "recoverable" as const };
                const { persisted } = await updateAssetSwapBestEffort(repository, swap.id, changes);
                if (persisted) onUpdate?.({ ...swap, ...changes });
                return;
            }
            if (vtxo.virtualStatus.state !== "spent") return;
            const spentTxid = vtxo.arkTxId || vtxo.spentBy;
            if (!spentTxid) return;
            // No timestamp on this path: the indexer VTXO carries createdAt of
            // the deposit, not the spend. Persist without completedAt.
            await resolveSpends(swap.swapPkScript, [
                {
                    txid: vtxo.txid,
                    vout: vtxo.vout,
                    isSpent: true,
                    arkTxId: vtxo.arkTxId,
                    spentBy: vtxo.spentBy,
                } as ContractVtxo,
            ]);
        } catch (err) {
            console.warn(`[swap] could not reconcile offer ${swap.id} after covering it`, err);
        }
    };

    /**
     * A settlement that landed mid-sweep may have retired its script before
     * the sweep re-watched it; re-derive liveness for scripts the sweep
     * touched so nothing stays watched forever after that race.
     */
    const retireUntouchedScripts = async (covered: readonly AssetSwap[]) => {
        const swaps = await getAssetSwaps(repository);
        const getContracts = (
            manager as { getContracts?: (q: { script: string }) => Promise<{ watch?: string }[]> }
        ).getContracts;
        for (const script of new Set(covered.map((s) => s.swapPkScript))) {
            if (getContracts) {
                const [row] = await getContracts.call(manager, { script });
                if (!row) continue;
                if (row.watch === "retained") continue;
            }
            await retireOfferContract(manager, swaps, script);
        }
    };

    const unsubscribe = manager.onContractEvent((event) => {
        // An offer is an owned contract; a watched script has no `metadata`.
        if (!isContractVtxoEvent(event) || event.type !== "vtxo_spent") return;
        enqueue(() => handleSpend(event));
    });

    // After subscribing, never before: registration is what starts the
    // manager's own watch on a script, and an event it delivers during the
    // sweep must find a handler already attached.
    const uncovered = (await getAssetSwaps(repository)).filter(
        (swap) => typeof swap.offerHex === "string" && NEEDS_COVERAGE.includes(swap.status),
    );
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

    // enqueued rather than awaited: the pass must not read before the
    // subscription is installed, or a spend landing mid-pass falls between them.
    // resolveOpenSwaps (#895) answers spent deposits the manager already knew;
    // the indexer pass catches spends/sweeps that landed while uncovered.
    enqueue(resolveOpenSwaps);
    for (const swap of uncovered) enqueue(() => reconcileFromIndexer(swap));
    enqueue(() => retireUntouchedScripts(uncovered));

    return {
        stop: unsubscribe,
        idle: () => queue,
    };
}
