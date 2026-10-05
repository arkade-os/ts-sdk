/**
 * The drive: what makes the v2 client self-driving, and the one place the two
 * families' state becomes one {@link Outcome}.
 *
 * Two drivers behind one lifecycle: `RfqSwapManager` (corridor swaps) and `watchOfferSwaps`
 * (offers). The manager survives `stop()`; the watcher is a one-shot unsubscribe rebuilt on the
 * next start.
 *
 * **The poll loop is the correctness mechanism.** Contract events only make a pass run early, and
 * the pass re-reads the lockup, so a missed, duplicated or forged event costs only latency:
 * NO OUTCOME IS EVER WRITTEN FROM AN EVENT PAYLOAD.
 *
 * **No backoff, deliberately**: the poll interval is the retry cadence and
 * `REFUND_MTP_LAG_SECONDS` the deadline, so a backoff could only push a money retry past it.
 *
 * Nothing here trusts the solver's word: there is no `RfqTransport`.
 */
import {
    ArkAddress,
    contractSigner,
    getNetwork,
    identityDescriptor,
    type IWallet,
    type Network,
    type SettlementEvent,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { pushClaim } from "../claim";
import { claimOnchainFill } from "../onchainHtlc";
import { retireSettledOfferContracts } from "../coverage";
import { restoreOfferCoverage } from "../offer";
import { lockupContractParams } from "../lockupContract";
import { arkadeRefunder } from "../arkadeRefunder";
import {
    LockupNeedsRecoveryError,
    findLockupVtxos,
    type LockupContractSource,
    type LockupSpendIndexer,
    type LockupVtxo,
    type SwapOperator,
} from "../refund";
import { RefundNotLocallyPossibleError, senderIdentityForSwapRecord } from "../refundBlocked";
import { rfqClaimDestinationOf, rfqClaimSecretOf, rfqSignerOf } from "../rfqProfileParts";
import { rebuildRfqSwap, rfqSwapOriginOf } from "../rfqRecord";
import { isRfqSwapTerminal } from "../rfqSwapState";
import { restoreAssetSwaps } from "../restore";
import { toRestoreTx } from "../registerRestore";
import { preimageForSwapRecord } from "../store";
import { collectSwapRecords, type AssetSwapRepository } from "../repository";
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
import type { NetworkRef } from "./assetId";
import {
    corridorRecordStore,
    fateMoved,
    offerFactsOf,
    offerRecordSource,
    restoredOfferRecord,
    rfqRecordOf,
    splitRecords,
    withDepositFate,
    type CorridorRecordStore,
} from "./driveRecords";
import {
    legacyLiveRfqSwaps,
    legacyOfferDepositsToReopen,
    withLegacyRfqSwaps,
} from "./legacyRecords";
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
    /** The lockup's `refundLocktime` has not matured. `recoverVtxos` settles EVERY recoverable
     * output in one batch, so an early attempt could fail unrelated outputs too. */
    | "refund-window-open"
    /** Nothing at this swap has been swept, so there is nothing to recover
     * (includes the `needs_counterparty` sources of `needs_recovery`). */
    | "nothing-swept"
    /** This wallet exposes no VTXO manager, so no recovery round can be run. */
    | "no-recovery-support";

/**
 * The drive declined, with the reason as a value a caller can branch on. Not a §7 taxonomy
 * member, hence the `Error` suffix.
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
     * Whether THIS swap's outpoints were included in the round, per a re-read afterwards. A
     * settlement txid is not success: `recoverVtxos` takes the whole wallet and caps the round,
     * deferring overflow to the next cycle. An offer re-read the indexer has not caught up on
     * reports `false`; the next client start re-reads it.
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
     * The client's corridors, for the L1 chain source and claim callback a drive pass needs.
     * Lazy, so a client with `null` onchain deps that never drives `arkade -> onchain` never
     * resolves them.
     */
    readonly corridors: () => Promise<CorridorSet>;
    /** The operator's network, for a rebuilt offer record's asset ids. Lazy like `corridors`. */
    readonly network: () => Promise<NetworkRef>;
    readonly mode?: DriveMode;
    /**
     * How often the fallback poll pass runs. Default 5000 ms (as
     * `RfqSwapManagerConfig.pollIntervalMs`); also the refund push's retry cadence.
     */
    readonly pollIntervalMs?: number;
    /** Unix seconds. Injected for tests. */
    readonly now?: () => number;
    /** The Arkade observation seam; normally the wallet's own reader. */
    readonly indexer: LockupSpendIndexer;
    /** Defaults to `wallet.getContractManager()`, resolved on first arm. */
    readonly contracts?: SwapContractRegistry;
}

export interface SwapDrive {
    /**
     * The restore-read, and — when it armed — the first pass after it. Lazy: the first await
     * drives it. Rejects only when the repository itself is unreadable; a corrupt record is
     * filtered and every per-swap problem is an outcome.
     */
    readonly ready: Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    dispose(): Promise<void>;
    onUpdate(fn: (update: SwapUpdate) => void): Unsubscribe;
    /**
     * Take a freshly persisted record into the drive and answer with its public form.
     * Synchronous: the registration it schedules runs behind `accept()`'s return.
     */
    adopt(record: SwapRecord): Swap;
    /** The public form of a record this drive holds. */
    swap(id: QuoteId): Swap | undefined;
    /** The outcome a record would report with no live state behind it. */
    outcomeOf(record: SwapRecord): Outcome;
    /**
     * Take a record written OUTSIDE the drive's own loops (today, cancel) into the registry and
     * emit through `onUpdate`; the `(swapId, outcome)` key absorbs a later pass over it.
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
 * Whether a stored blob is a record this drive can read at all. A corrupt row is filtered rather
 * than fatal, so it cannot stop every other swap; the checks cover what the drive dereferences.
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

    /** Every record this drive knows, by quote id; feeds both replay and stream. */
    const records = new Map<QuoteId, SwapRecord>();
    /** The manager's live swap per record, when it holds one. */
    const live = new Map<QuoteId, RfqSwap>();
    /** A refund push is in flight: the only source of `refunding`, in neither raw machine. */
    const refunding = new Set<QuoteId>();
    /**
     * Outpoints a push reported swept (`LockupNeedsRecoveryError`). The manager retries that
     * error rather than recording a state, so this is the only trace. Cleared when a push reruns.
     */
    const swept = new Map<QuoteId, readonly string[]>();
    /** Rounds this drive's `recover()` ran: a swept offer deposit settled in one went home. Kept
     * for the drive's life, never cleared: one txid per user-initiated recovery. */
    const recoveredIn = new Set<string>();
    /**
     * Swaps a drive pass has actually run over. NOT "the manager holds it": a restored swap is
     * held before anything is read from chain, and until a pass looks at the lockup `pending`
     * only means "the record says so" (`funding`, not `funded`).
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

    /** Serial: two racing registrations would each read the store and arm. */
    const enqueue = (task: () => Promise<void>): void => {
        queue = queue.then(task).catch((error: unknown) => {
            // The record stays durable and the next restore picks it up; never rethrown into a
            // caller already handed their swap.
            console.warn("[swap] the drive could not register a swap", error);
        });
    };

    const idle = async (): Promise<void> => {
        // Loops: draining can add work (a registration arms, which polls, which pushes).
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
     * Records this client cannot drive (an `arkade -> onchain` swap whose chain source was
     * refused), kept out of a manager that would fail them terminally.
     */
    const undrivable = new Set<QuoteId>();

    /** LEGACY(v1): `undrivable`, for v1 records, by `rfqId`. */
    const undrivableLegacy = new Set<string>();

    let bridge: CorridorRecordStore | undefined;
    let readThrough: CorridorRecordStore | undefined;
    const corridorStore = (): CorridorRecordStore =>
        // LEGACY(v1): unwrap to `bridge` alone once the read-through goes.
        (readThrough ??= withLegacyRfqSwaps(
            (bridge ??= corridorRecordStore(
                storage(),
                remember,
                // Terminal records stay readable but are excluded from the manager's read, sparing
                // a rebuild per record just to file it `finished`. The index still learns their
                // `rfqId` (see `getRfqSwapsPage`).
                (r) => !undrivable.has(r.id) && !isRfqSwapTerminal(r.state),
            )),
            storage(),
            (r) => !undrivableLegacy.has(r.rfqId) && !isRfqSwapTerminal(r.state),
        ));

    // ── the outcome ──────────────────────────────────────────────────────────

    /**
     * The configuration refusals, suppressed outside `drive: "auto"`: a client told not to
     * actuate would otherwise report its own configuration back as `needs_recovery`. The swap
     * keeps its pre-action outcome; the reason stays on `update.swap.blockedReason`.
     */
    const effectiveState = (swap: RfqSwap): RfqSwap["state"] => {
        if (mode === "auto") return swap.state;
        if (swap.state !== "needs_counterparty") return swap.state;
        if (!isRfqConfigurationRefusal(swap.blockedReason)) return swap.state;
        return traderClaimTxid(swap) ? "claimed" : "pending";
    };

    const outcomeOfEntry = (record: SwapRecord, current?: RfqSwap): Outcome => {
        // Offers have no live object (the watcher works over the store): the record IS the state.
        if (record.family === "offer") return recordOutcome(record);
        if (current === undefined) {
            // Not `recordOutcome` for a terminal record: it ignores state and would report a
            // settled swap as `funding`.
            if (isRfqSwapTerminal(record.state)) return corridorOutcome(record.kind, record.state);
            return recordOutcome(record);
        }
        const state = effectiveState(current);
        // `pending` before any pass is the accept-time word, not an answer.
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
     * The record's public form. The reason strings come off the LIVE swap: the record lags one
     * write behind, so reading it would deliver `needs_recovery` with no reason, and the later
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

    /** Deliver `id`'s current outcome, unless already delivered. Keyed on the DERIVED outcome,
     * so the legal `claimed -> claimable` backslide (`funded` twice) emits once. */
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
        // Marked HERE, not after the poll returns: a mid-pass transition would otherwise emit a
        // spurious `funding` between the state it left and the one it reached.
        passed.add(id);
        emit(id);
    };

    // ── the corridor driver ──────────────────────────────────────────────────

    /**
     * Held by the manager BY REFERENCE and mutated after construction on purpose (`contracts`,
     * `chain`, `repository` arrive later). Legal only because `RfqSwapManager` reads `this.deps`
     * at every use while it COPIES its config: a refactor snapshotting deps would silently break
     * onchain support and restore here.
     */
    // `contracts` is filled by `contractsOf()`, which every path that can start a pass awaits.
    const managerDeps: Omit<RfqSwapManagerDeps, "contracts"> &
        Partial<Pick<RfqSwapManagerDeps, "contracts">> = { indexer };
    if (config.contracts) managerDeps.contracts = config.contracts;

    const manager = new RfqSwapManager(managerDeps as RfqSwapManagerDeps, {
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
     * The L1 seams, resolved the first time a swap that reads them (`arkade -> onchain`) appears.
     * A refusal is reported and the record left undriven. `null` = refused.
     */
    let onchainSeams:
        | { chain: RfqSwapManagerDeps["chain"]; claim?: RfqSwapManagerCallbacks["claimOnchain"] }
        | null
        | undefined;

    /**
     * The wallet-backed default L1 claim, synthesized when the caller wired none and the corridor
     * can price one. HTLC and payout script come off the rebuilt swap (the store's word), the
     * preimage via the lightning claim's readers, and the signer is the identity key that
     * `provisionRefundKey` bound at quote time. Lives here so dep resolution stays pure.
     */
    const defaultOnchainClaim = (
        chain: NonNullable<RfqSwapManagerDeps["chain"]>,
        feeRateSatVb: number,
    ): RfqSwapManagerCallbacks["claimOnchain"] => {
        return async (swap, utxo) => {
            const record = await corridorStore().getRfqSwap(swap.rfqId);
            if (!record) {
                throw new Error(`rfq swap ${swap.rfqId} has no stored record to claim from`);
            }
            // Same composition as the lightning claim: validated hashlock, then P re-derived and
            // hash-checked.
            const secret = rfqClaimSecretOf(record);
            if (!secret) throw new Error(`rfq swap ${swap.rfqId} carries no claim secret`);
            const preimage = await preimageForSwapRecord(wallet, secret);

            // The record stores the payout pubkey but not its descriptor; the equality check turns
            // a drift from identity-key provisioning into a loud refusal, not a rejected signature.
            const signer = await contractSigner(wallet, await identityDescriptor(wallet.identity));
            const claimKey = record.profile.claimKey as string | undefined;
            if (typeof claimKey === "string") {
                const held = hex.encode(await signer.xOnlyPublicKey());
                if (held !== claimKey) {
                    throw new Error(
                        `this wallet's identity key ${held} is not the payout key ` +
                            `${claimKey} rfq swap ${swap.rfqId} was quoted against — ` +
                            "a wrong seed, or key provisioning has drifted from the identity key",
                    );
                }
            }
            if (!swap.payoutPkScript) {
                // Optional only so older records still restore; no claim can be built without it.
                throw new Error(`rfq swap ${swap.rfqId} carries no claim payout script`);
            }
            // `now` stays wall-clock: the claim's own deadline check is a consensus-margin probe,
            // not the drive's (injectable) window clock.
            // Tracked so `idle()`/`dispose()` drain this money-moving broadcast.
            const { txid } = await track(
                claimOnchainFill(chain, {
                    htlc: swap.htlc,
                    utxo,
                    preimage,
                    payoutPkScript: swap.payoutPkScript,
                    feeRateSatVb,
                    sign: (sighash) => signer.signMessage(sighash, "schnorr"),
                }),
            );
            return { txid };
        };
    };

    const resolveOnchain = async (): Promise<boolean> => {
        if (onchainSeams !== undefined) return onchainSeams !== null;
        try {
            const deps = (await corridors()).get("onchain").deps;
            // The caller's callback wins; with no fee rate there is no default (manual mode).
            const claim =
                deps.claim ??
                (deps.claimFeeRateSatVb === undefined
                    ? undefined
                    : defaultOnchainClaim(deps.chain, deps.claimFeeRateSatVb));
            onchainSeams = { chain: deps.chain, ...(claim ? { claim } : {}) };
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

    const drivable = async (record: Pick<CorridorSwapRecord, "kind">): Promise<boolean> =>
        !readsChain(record.kind) || (await resolveOnchain());

    // ── the money-moving half ────────────────────────────────────────────────

    /** The client's own resolved network, so the checkpoint gate's floor is not read off the
     * response it is checking. @see operatorUnrollScript */
    const pinnedNetwork = async (): Promise<Network> => getNetwork(await config.network());

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
                // Passed through: `pushClaim`'s own value check decides whether `P` is published.
                expectedAmount: swap.expectedAmount,
                partiallyClaimed,
                network: await pinnedNetwork(),
            }),
        );
    };

    /**
     * Whether this wallet could refund at all, asked every pass. The only thing that clears the
     * manager's `refundRefused` mark, so attaching the right wallet later unblocks the swap.
     * `rfqSignerOf` THROWS for a corrupt signer; that propagates, keeping the storage error.
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
            contracts: lockupSource,
            wallet,
            repository: corridorStore(),
            network: pinnedNetwork,
        });
        manager.setCallbacks({
            refundArkade: async (swap) => {
                const id = bridge?.quoteIdOf(swap.rfqId);
                if (id !== undefined) {
                    // Supersedes the last sweep report; this attempt re-reports if still swept.
                    swept.delete(id);
                    refunding.add(id);
                    // A push only happens inside a pass; else it would read `funding` mid-refund.
                    passed.add(id);
                    emit(id);
                }
                try {
                    return await track(push(swap));
                } finally {
                    // No emission: every exit moves the manager's state, which emits; emitting here
                    // would deliver a spurious backslide out of `refunding`.
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
     * The offer half of the restore: reconcile every deposit in the wallet's history against the
     * store. An unclaimed deposit becomes a record (the store can die with its browser; the tx
     * does not), an unstamped record gets its txid, and a known deposit gets its fate — spends
     * that landed while no client ran included. A live offer's txid stays off the scan cursor.
     *
     * `reopen` re-answers scanned txids: a `recoverable` deposit is marked scanned, and a recovery
     * (this pass's `recoverVtxos()`, or another device's) would otherwise never be read.
     */
    const restoreOfferDeposits = async (
        reopen: Iterable<string> = [],
    ): Promise<OfferSwapRecord[]> => {
        const store = storage();
        const [history, scanned, address, network] = await Promise.all([
            wallet.getTransactionHistory(),
            store.getScannedTxids(),
            wallet.getAddress(),
            config.network(),
        ]);
        const txs = history.map(toRestoreTx);

        const { hrp, serverPubKey: operatorPubkey } = ArkAddress.decode(address);
        // LEGACY(v1): drop `reopened` once the read-through goes.
        const reopened = await legacyOfferDepositsToReopen(store);
        for (const txid of reopen) reopened.add(txid);
        const cursor =
            reopened.size === 0
                ? scanned
                : new Set([...scanned].filter((txid) => !reopened.has(txid)));
        const { restored, scannedTxids } = await restoreAssetSwaps(indexer, txs, new Set(), {
            operatorPubkey,
            scanned: cursor,
            hrp,
            recoveredIn,
        });

        // After the scan: a record `accept()` persisted meanwhile is matched, not rebuilt.
        const { offer } = splitRecords(await collectSwapRecords(store));
        const current = new Map(offer.map((record) => [record.id, record]));
        const byDeposit = new Map(
            offer
                .filter((record) => record.fundingTxid !== undefined)
                .map((record) => [`${record.swapPkScript}:${record.fundingTxid}`, record]),
        );
        // Identical offers derive one script, so each unstamped record is matched once.
        const unstamped = new Map<string, OfferSwapRecord[]>();
        for (const record of offer) {
            if (record.fundingTxid !== undefined || !OFFER_LIVE(record.status)) continue;
            unstamped.set(record.swapPkScript, [
                ...(unstamped.get(record.swapPkScript) ?? []),
                record,
            ]);
        }

        const write = async (record: OfferSwapRecord): Promise<void> => {
            await store.saveSwapRecord(record);
            current.set(record.id, record);
            remember(record);
        };
        for (const found of restored) {
            const known = byDeposit.get(`${found.swapPkScript}:${found.fundingTxid}`);
            if (known !== undefined) {
                if (fateMoved(known, found)) await write(withDepositFate(known, found, now()));
                continue;
            }
            const orphan = unstamped.get(found.swapPkScript)?.shift();
            if (orphan !== undefined) {
                await write(
                    withDepositFate({ ...orphan, fundingTxid: found.fundingTxid }, found, now()),
                );
                continue;
            }
            await write(restoredOfferRecord(found, network, now()));
        }

        const stillLive = new Set<string>();
        for (const record of current.values()) {
            if (OFFER_LIVE(record.status) && record.fundingTxid) stillLive.add(record.fundingTxid);
        }
        await store.markTxidsScanned(scannedTxids.filter((txid) => !stillLive.has(txid)));

        const registry = managerDeps.contracts;
        if (registry) {
            await retireSettledOfferContracts(registry, [...current.values()].map(offerFactsOf));
        }
        return [...current.values()];
    };

    // ── lifecycle ────────────────────────────────────────────────────────────

    const contractsOf = async (): Promise<SwapContractRegistry> =>
        (managerDeps.contracts ??= await wallet.getContractManager());

    const lockupSource: LockupContractSource = {
        getContractsWithVtxos: async (filter) =>
            (await contractsOf()).getContractsWithVtxos(filter),
    };

    const registerCorridorSwap = async (record: CorridorSwapRecord): Promise<void> => {
        // `readonly` only reports what the restore-read found; admitting a swap starts a pass.
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
        // Idempotent; its immediate poll matters for a resumed swap already past a deadline.
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
        if (!repository) return;
        await contractsOf();
        // Re-run on EVERY arm, not redundant: an early arm lacks `claimOnchain` (the seam is
        // unresolved until an `onchain_send` record registers), and this is how it gets wired.
        wireCallbacks();
        // Idempotent: `start()` no-ops when running; the watcher is rebuilt only after `stop()`.
        await manager.start();
        await markPassed();
        if (!watcher) {
            watcher = await watchOfferSwaps({
                wallet,
                source: offers(),
                onUpdate: (swap) => emit(swap.id),
            });
        }
    };

    const restore = async (): Promise<void> => {
        if (!repository) return;
        // The one read `ready` may reject on: unreadable records cannot be driven safely.
        const all = await collectSwapRecords(repository);
        const { corridor, offer } = splitRecords(all.filter(readableRecord));
        for (const record of [...corridor, ...offer]) records.set(record.id, record);

        // Terminal records stay in `records` (readable, replayed) but are never driven.
        const liveCorridor = corridor.filter((record) => !isRfqSwapTerminal(record.state));
        const store = corridorStore();
        for (const record of liveCorridor) store.index(record);
        // LEGACY(v1)
        const liveLegacy = await legacyLiveRfqSwaps(repository);

        if (liveCorridor.length > 0 || liveLegacy.length > 0) {
            // A contract-manager failure is not a repository failure: logged, never propagated
            // into `ready`. Records stay readable and the next `arm()` retries.
            try {
                await contractsOf();
                for (const record of liveCorridor) {
                    if (!(await drivable(record))) undrivable.add(record.id);
                }
                for (const record of liveLegacy) {
                    if (!(await drivable(record))) undrivableLegacy.add(record.rfqId);
                }
                managerDeps.repository = store;
                // Per-record failures come back in `failed`; such a record reads off itself.
                const result = await manager.restoreFromRepository();
                for (const swap of result.restored) {
                    const id = store.quoteIdOf(swap.rfqId);
                    if (id !== undefined) live.set(id, swap);
                }
                for (const failure of result.failed) {
                    console.warn(
                        `[swap] could not restore rfq swap ${failure.rfqId}`,
                        failure.error,
                    );
                }
            } catch (error) {
                console.warn("[swap] the corridor restore could not drive", error);
            }
        }

        // After the corridor half, which resolves the contract registry this needs.
        let offers = offer;
        try {
            offers = await restoreOfferDeposits(
                offer.flatMap((record) =>
                    record.status === "recoverable" && record.fundingTxid !== undefined
                        ? [record.fundingTxid]
                        : [],
                ),
            );
        } catch (error) {
            // History/indexer outage, not the repository: never fails `ready`.
            console.warn("[swap] the offer deposit restore did not complete", error);
        }

        // Before arming, so a refusal the first pass clears is still visible once.
        emitAll();
        if (mode === "auto" && (await hasLiveWork(offers))) {
            try {
                await arm();
            } catch (error) {
                // Not a repository failure, so not `ready`'s; `start()` can try again.
                console.warn("[swap] the drive could not arm after its restore", error);
            }
        }
        // Again after: `funding -> funded` is an observation change with no manager transition.
        emitAll();
    };

    const ready = (): Promise<void> => (readyPromise ??= restore());

    const stop = async (): Promise<void> => {
        // Registrations first: a queued adoption would otherwise arm AFTER the stop. In-flight
        // money actions run to completion — stop/start is a pause.
        await queue;
        await manager.stop();
        // Contract rows are NOT undone: dropping one unwatches a funded lockup.
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
        (await findLockupVtxos(lockupSource, script)).filter((vtxo) => vtxo.recoverable);

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
            // `recoverVtxos` has no CLTV awareness: an early attempt could fail the whole batch.
            if (now() < record.refundLocktime) {
                throw new SwapDriveRefusedError(
                    "refund-window-open",
                    `swap ${id}'s lockup cannot be recovered before its refund locktime ${record.refundLocktime}`,
                    id,
                );
            }
            // Off the record: an unrebuildable one has no live swap and is what `recover()` is for.
            const script = hex.decode(record.lockupPkScript);
            const before = await recoverableAt(script);
            if (before.length === 0) {
                throw new SwapDriveRefusedError(
                    "nothing-swept",
                    `swap ${id} has no swept outputs to recover`,
                    id,
                );
            }
            const txid = await track((await recoverer()).recoverVtxos());
            // Re-read: a settlement txid is not success (see `RecoveryResult.recovered`).
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
        const wentHome = async (): Promise<boolean> => {
            await restoreOfferDeposits(
                record.fundingTxid === undefined ? [] : [record.fundingTxid],
            );
            const after = records.get(id);
            return after?.family === "offer" && after.status !== "recoverable";
        };
        // Chain first: a retry after a re-read that lagged or failed finds the deposit already
        // home, where a second round would only fail with "No recoverable VTXOs found". Best
        // effort: an outage here is the round's to report.
        try {
            if (await wentHome()) return { recovered: true, swap: swapView(id) };
        } catch (error) {
            console.warn(`[swap] could not re-read offer ${id} before recovering it`, error);
        }
        const vtxoManager = await recoverer();
        // `recoverVtxos` settles only what the contract manager holds, and a record rebuilt from
        // history or adopted from v1 never registered its covenant. A fresh row hydrates in full.
        await restoreOfferCoverage(wallet, [offerFactsOf(record)]);
        const txid = await track(vtxoManager.recoverVtxos());
        recoveredIn.add(txid);
        // The round ran; only its confirmation can fail now. Reported as not-yet rather than
        // thrown: `recoveredIn` keeps the round, so a retry's chain-first read resolves it.
        let recovered = false;
        try {
            recovered = await wentHome();
        } catch (error) {
            console.warn(
                `[swap] recovered offer ${id} in ${txid}, but could not re-read it`,
                error,
            );
        }
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
            // Awaits only an in-flight restore; never starts one just to stop.
            await readyPromise?.catch(() => {});
            await stop();
        },

        dispose: async () => {
            if (disposed) return;
            disposed = true;
            await stop();
            // Drained (no `AbortSignal` anywhere), so dispose never returns mid-refund-push.
            await idle();
            // An in-flight `restore()` is not drained above and may still emit; cleared after the
            // drain so the last word about an outgoing refund is not silenced.
            listeners.clear();
            // No repository is closed: the caller opened it, so the caller closes it.
        },

        onUpdate: (fn) => {
            if (disposed) throw new ClientDisposed("onUpdate");
            // Attach FIRST, then replay, in one synchronous turn: no transition can land between
            // them, and the `(swapId, outcome)` key absorbs overlap. Attaching second loses swaps.
            listeners.add(fn);
            for (const id of records.keys()) {
                const update = updateFor(id);
                if (update === undefined) continue;
                delivered.set(id, update.outcome);
                deliver(update, [fn]);
            }
            // A subscriber triggers the restore, or an `onUpdate`-only client sees nothing.
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
