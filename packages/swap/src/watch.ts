/**
 * Live offer status, driven by the wallet's own `vtxo_spent` events for the registered
 * offer covenant.
 *
 * The event says a deposit was spent, not by whom. The `cancel` leaf is a 2-of-2 of user
 * and server, so only the user can cancel: a spend matching the txid `cancelOffer`
 * recorded is a cancel. Otherwise (e.g. a cancel from another device) the covenant leaf
 * is read off the spending transaction.
 *
 * An unclassifiable spend leaves the record untouched for the restore scan: a stored
 * swap is skipped by every later scan, so a guess written here would be permanent.
 * A persisted terminal status retires the contract ({@link retireOfferContract}).
 */
import { base64, hex } from "@scure/base";
import {
    ArkAddress,
    isContractVtxoEvent,
    Transaction,
    type ContractVtxo,
    type ContractVtxoEvent,
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
 * What this watcher needs to know about an offer swap, narrower than {@link AssetSwap}
 * so both record families fit: v1 keys on the funding txid, v2 on the quote id (written
 * before funding). `id` is the source's own key; spends match on `fundingTxid` and
 * `swapPkScript`.
 *
 * `createdAt` is unix **milliseconds**; see {@link CoveredSwap}.
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
 * `apply` returns `persisted` because a lost write must not retire a script, and the
 * post-update `swaps` so the liveness check needs no third read.
 */
export interface OfferSwapSource<S extends OfferSwapFacts = OfferSwapFacts> {
    list(): Promise<S[]>;
    apply(swap: S, changes: OfferSpendChanges): Promise<{ persisted: boolean; swaps: S[] }>;
}

/** v1's store, as an {@link OfferSwapSource}. The default when a caller passes
 * a repository rather than a source. */
const assetSwapSource = (repository: AssetSwapRepository): OfferSwapSource<AssetSwap> => ({
    list: () => getAssetSwaps(repository),
    apply: async (swap, changes) => updateAssetSwapBestEffort(repository, swap.id, changes),
});

/**
 * The record change a classified spend implies, or `undefined` for an already-resolved
 * swap or an unclassified spend. Pure, so event re-delivery is a no-op.
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

/** A running watcher. `idle()` resolves once in-flight async writes have settled. */
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
 * Only covenants registered by {@link createOffer} produce events; older offers stay on
 * the restore scan. In Node, callers must provide an `EventSource` implementation or
 * live updates never arrive.
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
    // Safe: the repository overload fixes `S` to `AssetSwap`.
    const records: OfferSwapSource<S> =
        source ??
        (assetSwapSource(repository as AssetSwapRepository) as unknown as OfferSwapSource<S>);
    // Parallel: on a service-worker wallet each is a worker round trip.
    const [manager, address, indexer] = await Promise.all([
        wallet.getContractManager(),
        wallet.getAddress(),
        wallet.getArkadeReader(),
    ]);
    // Current server key at watcher start. TODO: persist the funding-time key
    // with swap records; a signer rotation during a long session makes leaf
    // classification return indeterminate rather than guessing.
    const operatorPubkey = ArkAddress.decode(address).serverPubKey;

    // Serialized: the update is read-modify-write over the whole list, so concurrent
    // handlers would lose a write.
    let queue: Promise<void> = Promise.resolve();
    const enqueue = (task: () => Promise<void>): void => {
        queue = queue.then(task).catch(() => {
            // Never reject into the manager's dispatch loop; the restore scan recovers.
        });
    };

    const classify = async (swap: S, vtxo: ContractVtxo, spentTxid: string) => {
        if (swap.spentTxid === spentTxid && swap.status === "cancelling") return "cancelled";
        try {
            // The checkpoint carries the deposit outpoint; the ark tx is the recorded id.
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

    const handleSpend = async (event: Extract<ContractVtxoEvent, { type: "vtxo_spent" }>) => {
        if (event.contract.metadata?.kind !== OFFER_CONTRACT_KIND) return;

        for (const vtxo of event.vtxos) {
            const spentTxid = vtxo.arkTxId || vtxo.spentBy;
            if (!spentTxid) continue;
            // Identical offers share one script and differ by funding deposit. O(history)
            // per event (no indexed lookup); add a query API if this gets hot.
            const swap = (await records.list()).find(
                (s) => s.fundingTxid === vtxo.txid && s.swapPkScript === event.contractScript,
            );
            if (!swap) continue;

            const kind: SpendKind = await classify(swap, vtxo, spentTxid);
            const changes = spendUpdate(swap, { txid: spentTxid, kind, at: event.timestamp });
            if (!changes) continue;

            const { persisted, swaps } = await records.apply(swap, changes);
            // Neither notify nor retire on a lost write: the restore scan still sees
            // this deposit as live.
            if (!persisted) continue;
            onUpdate?.(swaps.find((s) => s.id === swap.id) ?? swap);
            if (changes.status && RETIRABLE.includes(changes.status)) {
                await retireOfferContract(manager, swaps, event.contractScript);
            }
        }
    };

    const unsubscribe = manager.onContractEvent((event) => {
        // An offer is an owned contract; a watched script has no `metadata`.
        if (!isContractVtxoEvent(event) || event.type !== "vtxo_spent") return;
        enqueue(() => handleSpend(event));
    });

    return {
        stop: unsubscribe,
        idle: () => queue,
    };
}
