/**
 * The drive: what makes the v2 client self-driving, and the one place the two
 * families' state becomes one {@link Outcome}.
 *
 * Two drivers sit behind one lifecycle — `RfqSwapManager` for the corridor
 * swaps and `watchOfferSwaps` for the offers — and they stay separate here, as
 * they are in v1: liveness is their union, arming is one idempotent call over
 * both, and `stop()` pays the asymmetry the facade already pays (the manager
 * stays reusable, the watcher is a one-shot unsubscribe rebuilt on the next
 * start).
 *
 * **The poll loop is the correctness mechanism.** The contract-event
 * subscription only makes a pass run early, and that pass re-reads the lockup
 * exactly as the timer's does, so a missed, duplicated, reordered or forged
 * event costs or saves latency and nothing else. Stated as an invariant here
 * because it is what makes dropping the stream on `stop()` safe: NO OUTCOME IS
 * EVER WRITTEN FROM AN EVENT PAYLOAD.
 *
 * **No backoff, deliberately.** The poll interval is already the retry cadence
 * and `REFUND_MTP_LAG_SECONDS` already the deadline, so a backoff on a money
 * push could only push a retry past the deadline it exists to beat.
 *
 * What this module does NOT do is decide anything about a swap from the
 * solver's word: there is no `RfqTransport` here, exactly as there is none in
 * the manager.
 */
import { ArkAddress, contractSigner, type IWallet, type SettlementEvent } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { pushClaim } from "../claim";
import { RETIRABLE, retireSettledOfferContracts } from "../coverage";
import { lockupContractParams } from "../lockupContract";
import { arkadeRefunder } from "../arkadeRefunder";
import {
    LockupNeedsRecoveryError,
    findLockupVtxos,
    type LockupSpendIndexer,
    type LockupVtxo,
    type SwapOperator,
} from "../refund";
import { RefundNotLocallyPossibleError, senderIdentityForSwapRecord } from "../refundBlocked";
import { rfqClaimDestinationOf, rfqClaimSecretOf, rfqSignerOf } from "../rfqProfileParts";
import { rebuildRfqSwap, rfqSwapOriginOf } from "../rfqRecord";
import { isRfqSwapTerminal } from "../rfqSwapState";
import { restoreAssetSwaps, type Tx } from "../restore";
import { preimageForSwapRecord } from "../store";
import type { AssetSwapRepository } from "../repository";
import {
    RfqSwapManager,
    isRfqConfigurationRefusal,
    type AvailableRfqSwapManagerCallbacks,
    type RfqSwap,
    type RfqSwapManagerCallbacks,
    type RfqSwapManagerDeps,
    type SwapContractRegistry,
} from "../swapManager";
import { watchOfferSwaps, type OfferSwapWatcher } from "../watch";
import type { CorridorSet } from "./corridors/registry";
import { ClientDisposed } from "./errors";
import {
    corridorRecordStore,
    offerFactsOf,
    offerRecordSource,
    rfqRecordOf,
    splitRecords,
    withOfferStatus,
    type CorridorRecordStore,
} from "./driveRecords";
import {
    LOCKUP_OWNER,
    corridorOutcome,
    readsChain,
    recordOutcome,
    type Outcome,
    type RawState,
    type SwapUpdate,
    type Unsubscribe,
} from "./outcome";
import type { DriveMode } from "./policy";
import type { QuoteId } from "./quote";
import {
    swapOf,
    type CorridorSwapRecord,
    type OfferSwapRecord,
    type Swap,
    type SwapRecord,
} from "./record";

/** Why the drive refused. */
export type DriveRefusal =
    /** `drive: "readonly"` actuates nothing, and this asked it to. */
    | "readonly"
    /** No record with this id, here or in the repository. */
    | "unknown-swap"
    /** The lockup's `refundLocktime` has not matured, so a recovery round
     * including it would be rejected — and `recoverVtxos` settles EVERY
     * recoverable output in one batch, so an early attempt can fail unrelated
     * outputs with it. */
    | "refund-window-open"
    /** Nothing at this swap has been swept, so there is nothing to recover.
     * The two `needs_counterparty` sources of `needs_recovery` land here. */
    | "nothing-swept"
    /** This wallet exposes no VTXO manager, so no recovery round can be run. */
    | "no-recovery-support";

/**
 * The drive declined, with the reason as a value.
 *
 * Not a member of §7's sixteen, and it keeps the `Error` suffix to say so —
 * `errors.ts`'s own naming rule. What it replaces is `recoverVtxos`'s bare
 * `Error("No recoverable VTXOs found")`, which is outside the taxonomy and
 * carries nothing a caller can branch on.
 *
 * M6's error-coverage pass ruled it a documented NON-member: no §7 member names
 * a drive-refusal condition, so none absorbs these four, and the suffix rule is
 * working as intended rather than marking a loose end.
 */
export class SwapDriveRefusedError extends Error {
    override readonly name = "SwapDriveRefusedError";
    constructor(
        readonly reason: DriveRefusal,
        detail: string,
        readonly swapId?: QuoteId,
    ) {
        super(detail);
    }
}

/** What {@link SwapDrive.recover} did. */
export interface RecoveryResult {
    /**
     * Whether THIS swap's outpoints were included in the round.
     *
     * A settlement txid is not success: `recoverVtxos` takes no outpoints — it
     * reads the whole wallet, drops what `unspendableNow` refuses, then prices
     * and caps the rest highest-value-first with the overflow deferred to the
     * next cycle. So the named lockup is re-read afterwards and this is that
     * read's answer.
     */
    readonly recovered: boolean;
    /** The settlement the round produced, when one ran. */
    readonly txid?: string;
    /** The swap, after the immediate pass that followed. */
    readonly swap: Swap;
}

/** The wallet capability a recovery round needs, probed structurally. */
interface VtxoRecoverer {
    recoverVtxos(eventCallback?: (event: SettlementEvent) => void): Promise<string>;
}

export interface SwapDriveConfig {
    readonly wallet: IWallet;
    readonly operator: SwapOperator;
    /** No repository is legal and shipped: `ready` resolves, nothing arms, and
     * `accept()` keeps its own refusal. */
    readonly repository?: AssetSwapRepository;
    /**
     * The client's corridors, for the two deps a drive pass needs and the quote
     * path does not: the L1 chain source and the L1 claim callback. Read
     * through the set so resolution stays lazy — a client whose `onchain` deps
     * are deliberately `null` and which never drives an `arkade -> onchain`
     * swap never resolves them, which is what `MissingCorridorDep`'s boundary
     * note requires.
     */
    readonly corridors: () => Promise<CorridorSet>;
    readonly mode?: DriveMode;
    readonly pollIntervalMs?: number;
    /** Unix seconds. Injected for tests. */
    readonly now?: () => number;
    /** The Arkade observation seam. Defaults to the wallet's own reader; taken
     * as an input so a drive test can double one without a wallet behind it. */
    readonly indexer: LockupSpendIndexer;
    /** Defaults to `wallet.getContractManager()`, resolved on first arm. */
    readonly contracts?: SwapContractRegistry;
}

export interface SwapDrive {
    /**
     * The restore-read, and — when it armed — the first pass after it.
     *
     * Lazy: construction stays inert and the first await is what drives it.
     * Rejects only when the repository itself is unreadable, per Q3; a corrupt
     * record is filtered and every per-swap problem is an outcome.
     */
    readonly ready: Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    dispose(): Promise<void>;
    onUpdate(fn: (update: SwapUpdate) => void): Unsubscribe;
    /**
     * Take a freshly persisted record into the drive and answer with its public
     * form.
     *
     * Synchronous by design: `accept()` returns once the record is durable and
     * does NOT await the first pass, so the registration this schedules runs
     * behind the return.
     */
    adopt(record: SwapRecord): Swap;
    /** The public form of a record this drive holds. */
    swap(id: QuoteId): Swap | undefined;
    /** The outcome a record would report with no live state behind it. */
    outcomeOf(record: SwapRecord): Outcome;
    /**
     * Take a record written OUTSIDE the drive's own loops — today, the
     * awaited cancel call — into the registry, and emit through `onUpdate`.
     *
     * Cancel writes at two edges, the gate and the settlement, and the
     * delivery channel for both is this registry: replay plus the
     * `(swapId, outcome)` key absorb a later pass over the same record, whether
     * or not the drive armed.
     */
    ingest(record: SwapRecord): void;
    recover(id: QuoteId): Promise<RecoveryResult>;
    /** Everything this drive has in flight — registrations and money pushes.
     * Exposed so a test can be deterministic and so dispose can drain. */
    idle(): Promise<void>;
}

/** Offer statuses that still have something to drive. */
const OFFER_LIVE = (status: OfferSwapRecord["status"]): boolean =>
    status === "pending" || status === "cancelling";

/** The trader's own claim on a swap, whichever leg holds it. */
const traderClaimTxid = (swap: RfqSwap): string | undefined =>
    swap.kind === "lightning_send" ? undefined : swap.claimTxid;

/**
 * Whether a stored blob is a record this drive can read at all.
 *
 * The v1 store's rule, applied to the v2 keyspace: a corrupt row is filtered
 * rather than fatal, because one unreadable record must not stop a client from
 * driving every other swap it holds. Everything checked here is something the
 * drive dereferences unconditionally.
 */
export const readableRecord = (record: SwapRecord): boolean => {
    if (typeof record?.id !== "string" || record.route?.give === undefined) return false;
    if (record.family === "rfq") {
        return typeof record.rfqId === "string" && typeof record.lockupAddress === "string";
    }
    return record.family === "offer" && typeof record.offerHex === "string";
};

export const createSwapDrive = (config: SwapDriveConfig): SwapDrive => {
    const { wallet, operator, repository, corridors, indexer } = config;
    const mode: DriveMode = config.mode ?? "auto";
    const now = config.now ?? (() => Math.floor(Date.now() / 1000));

    /** Every record this drive knows, by quote id — the registry the replay and
     * the stream are both fed from. */
    const records = new Map<QuoteId, SwapRecord>();
    /** The manager's live swap per record, when it holds one. Its absence is
     * what makes a record `accepted`/`funding` rather than the raw table's
     * answer. */
    const live = new Map<QuoteId, RfqSwap>();
    /** A refund push is in flight. Process-local, and the only source of
     * `refunding` — which appears in neither raw machine. */
    const refunding = new Set<QuoteId>();
    /**
     * Outpoints a push reported swept, from `LockupNeedsRecoveryError`.
     *
     * The manager retries that error rather than blocking on it — recovery is
     * something the caller can perform while the window is still open — so it
     * never reaches a state, and without this the swept half of source 2 would
     * report nothing. Process-local, and cleared the moment a push runs again.
     */
    const swept = new Map<QuoteId, readonly string[]>();
    /**
     * Swaps a drive pass has actually run over.
     *
     * The boundary the three record-and-clock projections need, and it is NOT
     * "does the manager hold this swap": `restoreFromRepository` rebuilds a
     * swap with the state the record already carried, so a restored record
     * arrives with the manager holding it and nothing yet read from chain.
     * `accept()` writes `pending`, and until a pass looks at the lockup that
     * word means only "the record says so" — which is `funding`, not `funded`.
     */
    const passed = new Set<QuoteId>();
    const delivered = new Map<QuoteId, Outcome>();
    const listeners = new Set<(update: SwapUpdate) => void>();

    let disposed = false;
    let startRequested = mode === "auto";
    let watcher: OfferSwapWatcher | undefined;
    let readyPromise: Promise<void> | undefined;

    // ── in-flight bookkeeping ────────────────────────────────────────────────

    const inFlight = new Set<Promise<unknown>>();
    let queue: Promise<void> = Promise.resolve();

    const track = <T>(work: Promise<T>): Promise<T> => {
        inFlight.add(work);
        void work.then(
            () => inFlight.delete(work),
            () => inFlight.delete(work),
        );
        return work;
    };

    /** Serial, because two registrations racing would each read the store and
     * arm, and the second's `start()` would find the first still resolving. */
    const enqueue = (task: () => Promise<void>): void => {
        queue = queue.then(task).catch((error: unknown) => {
            // A registration that failed leaves the record durable and
            // undriven — it reports `accepted`/`funding` and the next restore
            // picks it up — so this is reported and never rethrown into a
            // caller who has already been handed their swap.
            console.warn("[swap] the drive could not register a swap", error);
        });
    };

    const idle = async (): Promise<void> => {
        // Both can grow while they are drained — a registration arms, which
        // polls, which pushes — so this loops rather than awaiting one snapshot.
        do {
            await queue;
            await Promise.allSettled([...inFlight]);
            await watcher?.idle();
        } while (inFlight.size > 0);
    };

    // ── the record seams ─────────────────────────────────────────────────────

    const remember = (record: SwapRecord): void => {
        records.set(record.id, record);
        emit(record.id);
    };

    const storage = (): AssetSwapRepository => {
        if (!repository) throw new Error("the drive has no repository");
        return repository;
    };

    /**
     * Records this client cannot drive — today, an `arkade -> onchain` swap
     * whose chain source was refused. Kept out of the manager rather than
     * admitted to one that would fail them terminally for want of a seam the
     * caller deliberately withheld.
     */
    const undrivable = new Set<QuoteId>();

    let bridge: CorridorRecordStore | undefined;
    const corridorStore = (): CorridorRecordStore =>
        (bridge ??= corridorRecordStore(storage(), remember, (r) => !undrivable.has(r.id)));

    // ── the outcome ──────────────────────────────────────────────────────────

    /**
     * The three configuration refusals, suppressed outside `drive: "auto"`.
     *
     * A client told never to actuate reporting every live swap as needing
     * recovery would be reporting its own configuration back at the caller. The
     * swap keeps its pre-action outcome — what `unblock` would restore, which is
     * what the record can prove and not `pending` unconditionally — and the
     * reason stays readable as `update.swap.blockedReason`.
     */
    const effectiveState = (swap: RfqSwap): RfqSwap["state"] => {
        if (mode === "auto") return swap.state;
        if (swap.state !== "needs_counterparty") return swap.state;
        if (!isRfqConfigurationRefusal(swap.blockedReason)) return swap.state;
        return traderClaimTxid(swap) ? "claimed" : "pending";
    };

    const outcomeOfEntry = (record: SwapRecord, current?: RfqSwap): Outcome => {
        // The offer family has no live object of its own — its watcher is
        // event-driven over the store — and a corridor record with nothing live
        // behind it has only itself and the clock to answer with.
        if (record.family === "offer" || current === undefined) return recordOutcome(record);
        const state = effectiveState(current);
        // `pending` before any pass is the accept-time word, not an answer: the
        // record says the funding was broadcast and nothing has looked at the
        // lockup yet. Once the machine has spoken — a pass ran, or the state
        // moved off `pending` — it is the machine that answers.
        if (state === "pending" && !passed.has(record.id)) return recordOutcome(record);
        if (isRfqSwapTerminal(state)) return corridorOutcome(current.kind, state);
        if (
            LOCKUP_OWNER[current.kind] === "trader" &&
            refunding.has(record.id) &&
            now() >= current.refundLocktime
        ) {
            return "refunding";
        }
        if (swept.has(record.id)) return "needs_recovery";
        return corridorOutcome(current.kind, state);
    };

    const detailOf = (record: SwapRecord, current?: RfqSwap): RawState =>
        record.family === "offer"
            ? { family: "offer", status: record.status }
            : { family: "rfq", state: current?.state ?? record.state };

    /**
     * The record's public form.
     *
     * The two reason strings come off the LIVE swap when there is one: the
     * manager sets `blockedReason` and then changes state, and the state change
     * is what this drive emits on — one write behind the record. Reading the
     * record there would deliver `needs_recovery` with no reason, and the later
     * write would be swallowed by the `(swapId, outcome)` key.
     */
    const publicSwap = (record: SwapRecord, outcome: Outcome, current?: RfqSwap): Swap => {
        const base = swapOf(record, outcome);
        if (current === undefined) return base;
        const { failure: _failure, blockedReason: _blockedReason, ...rest } = base;
        return {
            ...rest,
            ...(current.failure === undefined ? {} : { failure: current.failure }),
            ...(current.blockedReason === undefined
                ? {}
                : { blockedReason: current.blockedReason }),
        };
    };

    const updateFor = (id: QuoteId): SwapUpdate | undefined => {
        const record = records.get(id);
        if (record === undefined) return undefined;
        const current = live.get(id);
        const outcome = outcomeOfEntry(record, current);
        return {
            swap: publicSwap(record, outcome, current),
            outcome,
            detail: detailOf(record, current),
        };
    };

    const deliver = (update: SwapUpdate, to: Iterable<(u: SwapUpdate) => void>): void => {
        for (const listener of to) {
            try {
                listener(update);
            } catch {
                // A consumer's callback is not this drive's correctness.
            }
        }
    };

    /** Deliver `id`'s current outcome, unless it is the one already delivered.
     * The key is the DERIVED outcome, so the legal `claimed -> claimable`
     * backslide — which produces `funded` twice — emits once. */
    function emit(id: QuoteId): void {
        const update = updateFor(id);
        if (update === undefined) return;
        if (delivered.get(id) === update.outcome) return;
        delivered.set(id, update.outcome);
        deliver(update, listeners);
    }

    const emitAll = (): void => {
        for (const id of records.keys()) emit(id);
    };

    const touch = (rfqId: string, swap: RfqSwap): void => {
        const id = bridge?.quoteIdOf(rfqId);
        if (id === undefined) return;
        live.set(id, swap);
        // Any word from the manager about this swap means a pass ran over it.
        // Marked HERE and not only after the poll returns, because a swap that
        // transitions mid-pass would otherwise be projected off its record for
        // one emission — delivering a spurious `funding` between the state it
        // left and the one it reached.
        passed.add(id);
        emit(id);
    };

    // ── the corridor driver ──────────────────────────────────────────────────

    /**
     * Held by the manager BY REFERENCE, and mutated after construction on
     * purpose — `contracts` below, `chain` the first time an onchain record
     * needs it (`resolveOnchain`), `repository` once there is something to
     * restore from. None of the three is known when the manager is built, and
     * the alternative is building it later than the callbacks it must already
     * be reachable from.
     *
     * What makes it legal is that `RfqSwapManager` keeps `this.deps = deps` and
     * reads through it at every use — where its config, one line further down
     * the same constructor, is COPIED into a new object. That asymmetry is
     * load-bearing and invisible from there: a refactor that snapshots deps the
     * way config is already snapshotted takes this drive's onchain support and
     * its restore with it, silently. The two move together or not at all.
     */
    const managerDeps: RfqSwapManagerDeps = { indexer };
    if (config.contracts) managerDeps.contracts = config.contracts;

    const manager = new RfqSwapManager(managerDeps, {
        ...(config.pollIntervalMs === undefined ? {} : { pollIntervalMs: config.pollIntervalMs }),
        now,
    });

    manager.onSwapUpdate((swap) => touch(swap.rfqId, swap));
    manager.onSwapCompleted((swap) => touch(swap.rfqId, swap));
    manager.onSwapFailed((swap, error) => {
        const id = bridge?.quoteIdOf(swap.rfqId);
        if (id !== undefined && error instanceof LockupNeedsRecoveryError) {
            swept.set(id, error.outpoints);
        }
        touch(swap.rfqId, swap);
    });

    /**
     * The L1 seams, resolved the first time a swap that reads them appears.
     *
     * `CorridorPass.seams` is what decides: an `arkade -> onchain` swap declares
     * `chain`, the other two do not, so a client whose onchain deps are
     * deliberately refused never touches them. A refusal here is reported and
     * the record is left undriven rather than admitted to a manager that would
     * fail it terminally for want of a `ChainSource`.
     */
    let onchainSeams:
        | { chain: RfqSwapManagerDeps["chain"]; claim?: RfqSwapManagerCallbacks["claimOnchain"] }
        | null
        | undefined;
    const resolveOnchain = async (): Promise<boolean> => {
        if (onchainSeams !== undefined) return onchainSeams !== null;
        try {
            const deps = (await corridors()).get("onchain").deps;
            onchainSeams = { chain: deps.chain, ...(deps.claim ? { claim: deps.claim } : {}) };
            managerDeps.chain = deps.chain;
            return true;
        } catch (error) {
            console.warn(
                "[swap] the onchain corridor has no chain source, so its swaps cannot be driven",
                error,
            );
            onchainSeams = null;
            return false;
        }
    };

    const drivable = async (record: CorridorSwapRecord): Promise<boolean> =>
        !readsChain(record.kind) || (await resolveOnchain());

    // ── the money-moving half ────────────────────────────────────────────────

    const claimLockup: RfqSwapManagerCallbacks["claimLockup"] = async (
        swap,
        vtxos,
        { partiallyClaimed },
    ) => {
        const record = await corridorStore().getRfqSwap(swap.rfqId);
        if (!record) throw new Error(`rfq swap ${swap.rfqId} has no stored record to claim from`);
        const secret = rfqClaimSecretOf(record);
        if (!secret) throw new Error(`rfq swap ${swap.rfqId} carries no claim secret`);
        const script = swap.lockup?.script;
        if (!script) throw new Error(`rfq swap ${swap.rfqId} carries no lockup covenant`);
        const payoutAddress = rfqClaimDestinationOf(record);
        if (!payoutAddress) {
            throw new Error(`rfq swap ${swap.rfqId} carries no claim destination`);
        }
        return track(
            pushClaim(operator, {
                contract: script,
                receiver: await contractSigner(wallet, secret.signingDescriptor),
                preimage: await preimageForSwapRecord(wallet, secret),
                vtxos,
                destinationPkScript: ArkAddress.decode(payoutAddress).pkScript,
                // Passed straight through, both of them: the manager's own value
                // check decides WHEN to act, `pushClaim`'s decides whether `P` is
                // published, and it is the one with nothing between it and the
                // signature.
                expectedAmount: swap.expectedAmount,
                partiallyClaimed,
            }),
        );
    };

    /**
     * Whether this wallet could refund at all, asked every pass.
     *
     * The only thing that clears the manager's `refundRefused` mark, which is
     * why it is wired rather than omitted: a swap blocked before the right
     * wallet was attached would otherwise never re-attempt in this process.
     *
     * `rfqSignerOf` returns `undefined` for an absent signer and THROWS for a
     * corrupt one, and the two must not collapse — the manager treats a throw as
     * a refusal too, but the reason it then carries is the storage error's own
     * rather than "no local refund is possible".
     */
    const canRefundArkade: NonNullable<
        AvailableRfqSwapManagerCallbacks["canRefundArkade"]
    > = async (swap) => {
        const record = await corridorStore().getRfqSwap(swap.rfqId);
        if (!record) {
            return {
                ok: false,
                reason: `no stored record for ${swap.rfqId}; the descriptor that signs its refund lives there`,
            };
        }
        const signer = rfqSignerOf(record);
        try {
            await senderIdentityForSwapRecord(wallet, signer ?? {});
            return { ok: true };
        } catch (error) {
            if (error instanceof RefundNotLocallyPossibleError) {
                return { ok: false, reason: error.message };
            }
            throw error;
        }
    };

    const wireCallbacks = (): void => {
        if (mode === "readonly") return;
        const push = arkadeRefunder({
            operator,
            indexer,
            wallet,
            repository: corridorStore(),
        });
        manager.setCallbacks({
            refundArkade: async (swap) => {
                const id = bridge?.quoteIdOf(swap.rfqId);
                if (id !== undefined) {
                    // A push in flight supersedes the last one's sweep report:
                    // if these outputs are still swept, this attempt says so
                    // again.
                    swept.delete(id);
                    refunding.add(id);
                    // The push only happens inside a pass, so reaching here is
                    // itself the evidence the record-and-clock projection was
                    // waiting for — without this the swap would still read
                    // `funding` while its refund was going out.
                    passed.add(id);
                    emit(id);
                }
                try {
                    return await track(push(swap));
                } finally {
                    // No emission here: every exit from the push moves the
                    // manager's own state — `refunded`, a block, or a reported
                    // failure — and each of those emits with the mark already
                    // cleared. Emitting from the `finally` would deliver a
                    // backslide out of `refunding` that the next line undoes.
                    if (id !== undefined) refunding.delete(id);
                }
            },
            canRefundArkade,
            claimLockup,
            ...(onchainSeams?.claim ? { claimOnchain: onchainSeams.claim } : {}),
        });
    };

    // ── the offer driver ─────────────────────────────────────────────────────

    let offerSource: ReturnType<typeof offerRecordSource> | undefined;
    const offers = () => (offerSource ??= offerRecordSource(storage(), remember, now));

    /**
     * The offer half of the construction restore, and the only producer of a
     * swept offer deposit's `recoverable`.
     *
     * `restoreAssetSwaps` is the sole writer of that status and has no call site
     * in this package — it is a root export consumers run on their own schedule
     * — and the watcher cannot stand in for it: `spendUpdate` writes only
     * `cancelled` or `fulfilled`, and a sweep is not a spend, so no contract
     * event ever names one. Without this a swept deposit — the case `RETIRABLE`
     * exists to keep watched — reports `open` forever.
     *
     * `existingIds` is empty ON PURPOSE. That parameter exists to skip deposits
     * a caller already has a record for, which is right when the scan is
     * REBUILDING v1 records; here the scan is answering what became of deposits
     * whose v2 record already exists, so skipping them would skip everything.
     * The cursor is what keeps it cheap, with one exception: a txid belonging to
     * a still-live offer is never marked answered, because the answer can change
     * and a scan that never looks again would be the same gap in a new place.
     */
    const sweepOfferDeposits = async (offer: readonly OfferSwapRecord[]): Promise<void> => {
        const funded = offer.filter(
            (record) => record.fundingTxid !== undefined && !RETIRABLE.includes(record.status),
        );
        if (funded.length === 0) return;

        const store = storage();
        const [history, scanned, address] = await Promise.all([
            wallet.getTransactionHistory(),
            store.getScannedTxids(),
            wallet.getAddress(),
        ]);
        const txs: Tx[] = history.map((tx) => ({
            // `TxType` is `"SENT"`/`"RECEIVED"`; the scan filters on `"sent"`.
            type: String(tx.type).toLowerCase(),
            redeemTxid: tx.key.arkTxid,
            ...(tx.key.boardingTxid ? { boardingTxid: tx.key.boardingTxid } : {}),
            ...(tx.key.commitmentTxid ? { roundTxid: tx.key.commitmentTxid } : {}),
            // The scan reads unix SECONDS; a wallet transaction carries ms.
            ...(tx.createdAt ? { createdAt: Math.floor(tx.createdAt / 1000) } : {}),
        }));

        const { restored, scannedTxids } = await restoreAssetSwaps(indexer, txs, new Set(), {
            operatorPubkey: ArkAddress.decode(address).serverPubKey,
            scanned,
        });
        const byDeposit = new Map(restored.map((s) => [`${s.swapPkScript}:${s.fundingTxid}`, s]));

        const stillLive = new Set<string>();
        for (const record of funded) {
            const found = byDeposit.get(`${record.swapPkScript}:${record.fundingTxid}`);
            const status = found?.status ?? record.status;
            if (status !== record.status) {
                const updated = withOfferStatus(record, status, now());
                await store.saveSwapRecord(updated);
                remember(updated);
            }
            if (OFFER_LIVE(status) && record.fundingTxid) stillLive.add(record.fundingTxid);
        }

        await store.markTxidsScanned(scannedTxids.filter((txid) => !stillLive.has(txid)));

        const registry = managerDeps.contracts;
        if (registry) {
            const { offer: current } = splitRecords(await store.getAllSwapRecords());
            await retireSettledOfferContracts(registry, current.map(offerFactsOf));
        }
    };

    // ── lifecycle ────────────────────────────────────────────────────────────

    const contractsOf = async (): Promise<SwapContractRegistry> =>
        (managerDeps.contracts ??= await wallet.getContractManager());

    const registerCorridorSwap = async (record: CorridorSwapRecord): Promise<void> => {
        // `readonly` discovers nothing new: it reports what the restore-read
        // found, and admitting a swap to the manager is how a pass starts.
        if (mode === "readonly") return;
        if (!(await drivable(record))) {
            undrivable.add(record.id);
            return;
        }
        const contracts = await contractsOf();
        const stored = rfqRecordOf(record);
        const params = await lockupContractParams(contracts, record.lockupAddress);
        const swap = rebuildRfqSwap(stored, params);
        live.set(record.id, swap);
        // Idempotent: `addSwap` re-admits a swap the manager already holds, and
        // its immediate poll is the pass a resumed swap may already be past a
        // deadline for.
        await manager.addSwap(swap, rfqSwapOriginOf(stored));
        await markPassed();
        emit(record.id);
        await arm();
        emit(record.id);
    };

    const hasLiveWork = async (offer: readonly OfferSwapRecord[]): Promise<boolean> =>
        (await manager.getPendingSwaps()).length > 0 || offer.some((r) => OFFER_LIVE(r.status));

    /** Every swap the running manager holds has now had a pass. */
    const markPassed = async (): Promise<void> => {
        if (!(await manager.getStats()).isRunning) return;
        for (const swap of await manager.getAllSwaps()) {
            const id = bridge?.quoteIdOf(swap.rfqId);
            if (id !== undefined) passed.add(id);
        }
    };

    const arm = async (): Promise<void> => {
        if (mode === "readonly" || !startRequested) return;
        // Nothing to drive and nowhere to write: a client with no repository is
        // legal and shipped, `ready` resolves, and `accept()` keeps its own
        // refusal.
        if (!repository) return;
        await contractsOf();
        // Re-run on every arm, and the seams it reads may have arrived since the
        // last one. An offer-only client arms before any onchain record exists,
        // so `onchainSeams` is unresolved and `claimOnchain` is absent from that
        // first `setCallbacks` — the manager then blocks an onchain swap with
        // `noClaimOnchainCallback`. Registering an `onchain_send` record
        // resolves the seam and arms again, and the block lifts on the next
        // pass. So this is not idempotent-therefore-harmless; it is how the
        // seam gets wired at all.
        wireCallbacks();
        // Idempotent both ways: `start()` returns without re-arming when it is
        // already running, and the watcher is rebuilt only after a `stop()`
        // dropped it — the one-shot unsubscribe the facade already pays for.
        await manager.start();
        await markPassed();
        if (!watcher && repository) {
            watcher = await watchOfferSwaps({
                wallet,
                source: offers(),
                onUpdate: (swap) => emit(swap.id),
            });
        }
    };

    const restore = async (): Promise<void> => {
        if (!repository) return;
        // The one read `ready` may reject on: a client that cannot read its own
        // records cannot drive them safely, so nothing proceeds from there.
        const all = await repository.getAllSwapRecords();
        const { corridor, offer } = splitRecords(all.filter(readableRecord));
        for (const record of [...corridor, ...offer]) records.set(record.id, record);

        const store = corridorStore();
        for (const record of corridor) store.index(record);

        if (corridor.length > 0) {
            await contractsOf();
            for (const record of corridor) {
                if (!(await drivable(record))) undrivable.add(record.id);
            }
            managerDeps.repository = store;
            // Per-record failures — a covenant that will not derive, a lockup
            // with no contract row — come back in `failed` and are reported. A
            // record that cannot be rebuilt still has an outcome: the drive
            // holds no live swap for it, so it reads off the record.
            const result = await manager.restoreFromRepository();
            for (const swap of result.restored) {
                const id = store.quoteIdOf(swap.rfqId);
                if (id !== undefined) live.set(id, swap);
            }
            for (const failure of result.failed) {
                console.warn(`[swap] could not restore rfq swap ${failure.rfqId}`, failure.error);
            }
        }

        // After the corridor half, because it is what resolves the contract
        // registry this needs to retire settled scripts.
        try {
            await sweepOfferDeposits(offer);
        } catch (error) {
            // The offer sweep reads the wallet's history and the indexer, and
            // neither is the repository: an outage there costs a swept deposit
            // its label until the next construction, never `ready`.
            console.warn("[swap] the offer deposit sweep did not complete", error);
        }

        // Before arming, so the stream carries what the READ found and not only
        // what the first pass concluded: a record restored `needs_counterparty`
        // that the very first pass unblocks would otherwise appear as one
        // `funded` and the refusal would never have been visible.
        emitAll();
        if (mode === "auto" && (await hasLiveWork(offer))) {
            try {
                await arm();
            } catch (error) {
                // `ready` rejects on ONE thing: a repository it cannot read.
                // Arming reaches the wallet's contract manager and the event
                // stream, and neither failing is evidence about the records —
                // the swaps stay readable and `start()` can try again.
                console.warn("[swap] the drive could not arm after its restore", error);
            }
        }
        // And again after it, because the first pass moves swaps the machine
        // itself reports no transition for: `funding -> funded` is a change in
        // what has been OBSERVED, not in the manager's state.
        emitAll();
    };

    const ready = (): Promise<void> => (readyPromise ??= restore());

    const stop = async (): Promise<void> => {
        // Registrations first, and this is not politeness: an adoption still on
        // the queue would arm AFTER the stop, quietly restarting the loop the
        // caller just released. In-flight money actions are a different case and
        // are left to run to completion — stop/start is a pause.
        await queue;
        await manager.stop();
        // The manager stays reusable; the watcher's `stop` is the one-shot
        // unsubscribe, so the next `start()` builds a new one. Contract
        // registrations are NOT undone — the rows are the wallet's, and dropping
        // one unwatches a funded lockup.
        watcher?.stop();
        await watcher?.idle();
        watcher = undefined;
        if (mode === "manual") startRequested = false;
    };

    const recoverer = async (): Promise<VtxoRecoverer> => {
        const probe = (wallet as Partial<{ getVtxoManager(): Promise<VtxoRecoverer> }>)
            .getVtxoManager;
        if (typeof probe !== "function") {
            throw new SwapDriveRefusedError(
                "no-recovery-support",
                "this wallet exposes no VTXO manager, so no recovery round can be run",
            );
        }
        return probe.call(wallet);
    };

    const recoverableAt = async (script: Uint8Array): Promise<LockupVtxo[]> =>
        (await findLockupVtxos(indexer, script)).filter((vtxo) => vtxo.recoverable);

    const recover = async (id: QuoteId): Promise<RecoveryResult> => {
        if (disposed) throw new ClientDisposed("recover");
        if (mode === "readonly") {
            throw new SwapDriveRefusedError(
                "readonly",
                'this client is configured drive: "readonly" and actuates nothing',
                id,
            );
        }
        await ready();
        const record = records.get(id) ?? (await repository?.getSwapRecord(id));
        if (record === undefined) {
            throw new SwapDriveRefusedError("unknown-swap", `no swap record for ${id}`, id);
        }
        records.set(record.id, record);

        if (record.family === "rfq") {
            // Refused up front rather than handed to a round that would silently
            // drop it — or, worse, fail the whole batch: `recoverVtxos` settles
            // every recoverable output at once with no CLTV awareness.
            if (now() < record.refundLocktime) {
                throw new SwapDriveRefusedError(
                    "refund-window-open",
                    `swap ${id}'s lockup cannot be recovered before its refund locktime ${record.refundLocktime}`,
                    id,
                );
            }
            // Off the record, not off a live swap: a record the drive could
            // not rebuild has no live swap and is exactly the one a caller
            // reaches for `recover()` with.
            const script = hex.decode(record.lockupPkScript);
            const before = await recoverableAt(script);
            if (before.length === 0) {
                // Two of the three `needs_recovery` sources are
                // `needs_counterparty`, which has nothing swept: the money is at
                // the lockup and the counterparty's move is what ends the swap.
                throw new SwapDriveRefusedError(
                    "nothing-swept",
                    `swap ${id} has no swept outputs to recover`,
                    id,
                );
            }
            const txid = await track((await recoverer()).recoverVtxos());
            // A settlement txid is not success: the round is capped and its
            // overflow deferred, so the named lockup is re-read.
            const after = await recoverableAt(script);
            const still = new Set(after.map((vtxo) => `${vtxo.txid}:${vtxo.vout}`));
            const recovered = before.every((vtxo) => !still.has(`${vtxo.txid}:${vtxo.vout}`));
            if (recovered) swept.delete(id);
            await manager.poll();
            await markPassed();
            return { recovered, txid, swap: swapView(id) };
        }

        if (record.status !== "recoverable") {
            throw new SwapDriveRefusedError(
                "nothing-swept",
                `offer swap ${id} is ${record.status}, so it has nothing swept to recover`,
                id,
            );
        }
        const txid = await track((await recoverer()).recoverVtxos());
        await sweepOfferDeposits([records.get(id) as OfferSwapRecord]);
        const after = records.get(id);
        const recovered = after?.family === "offer" && after.status !== "recoverable";
        return { recovered, txid, swap: swapView(id) };
    };

    const swapView = (id: QuoteId): Swap => {
        const update = updateFor(id);
        if (update === undefined) throw new Error(`the drive holds no swap ${id}`);
        return update.swap;
    };

    return {
        get ready() {
            return ready();
        },

        start: async () => {
            if (disposed) throw new ClientDisposed("start");
            if (mode === "readonly") {
                // Silence would be worse: the caller configured a client that
                // actuates nothing and then asked it to drive, and one of the
                // two statements has to give.
                throw new SwapDriveRefusedError(
                    "readonly",
                    'this client is configured drive: "readonly" and will not start a drive loop',
                );
            }
            startRequested = true;
            await ready();
            await arm();
        },

        stop: async () => {
            // Only what a restore already in flight left behind: `stop()` on a
            // client nobody has asked a question has nothing to release, and
            // driving a restore in order to release resources it never took
            // would be backwards.
            await readyPromise?.catch(() => {});
            await stop();
        },

        dispose: async () => {
            if (disposed) return;
            disposed = true;
            await stop();
            // Drained, at the cost of a dispose that is not instant: nothing in
            // this package takes an `AbortSignal`, so the alternative is
            // returning while a refund push is mid-flight and calling the
            // instance terminal while it is still moving money.
            await idle();
            // A `restore()` still in flight is in neither `queue` nor
            // `inFlight`, so nothing above waits for it — only the facade's
            // `stop` awaits `readyPromise`, and dispose calls the inner `stop`.
            // Its `emitAll` can therefore deliver between `disposed = true` and
            // this line: a listener hears from a client whose `dispose()` has
            // not returned yet. Left as is rather than clearing first —
            // `deliver` swallows what a listener throws, and clearing before
            // the drain would silence the last word about a refund that was
            // still going out.
            listeners.clear();
            // No repository is closed here. Every repository reaching this
            // client was opened by its caller — `SwapClientConfig.repository` is
            // injected on every path today — and the client never closes what it
            // did not open. The close belongs beside the storage default, on the
            // milestone that adds one.
        },

        onUpdate: (fn) => {
            if (disposed) throw new ClientDisposed("onUpdate");
            // The listener attaches FIRST, and the replay is computed from the
            // same registry the stream is fed from. Both halves run in one
            // synchronous turn, so a transition cannot land between them; and
            // where one is queued behind the replay, the `(swapId, outcome)` key
            // absorbs the overlap. Attaching second is what loses a swap
            // silently — the shipped facade's `onUpdate` has no replay at all
            // and hand-rolls a one-off dedupe at admit time instead.
            listeners.add(fn);
            for (const id of records.keys()) {
                const update = updateFor(id);
                if (update === undefined) continue;
                delivered.set(id, update.outcome);
                deliver(update, [fn]);
            }
            // A subscriber is a reason to restore: without this a client whose
            // only call is `onUpdate` would report an empty world forever.
            void ready().catch(() => {});
            return () => {
                listeners.delete(fn);
            };
        },

        adopt: (record) => {
            if (disposed) throw new ClientDisposed("accept");
            records.set(record.id, record);
            if (record.family === "rfq") {
                corridorStore().index(record);
                managerDeps.repository = corridorStore();
                enqueue(() => registerCorridorSwap(record));
            } else {
                enqueue(() => arm());
            }
            emit(record.id);
            return swapView(record.id);
        },

        swap: (id) => updateFor(id)?.swap,

        outcomeOf: (record) => outcomeOfEntry(record, live.get(record.id)),

        ingest: (record) => remember(record),

        recover,

        idle,
    };
};
