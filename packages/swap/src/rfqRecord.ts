/**
 * The serializable projection of a monitored RFQ swap.
 *
 * {@link RfqSwap} is a live record, not a storage format: it holds derived
 * `Uint8Array`s and a `VHTLC.ScriptV2` class instance, and IndexedDB's
 * structured clone strips prototypes — a naive `store.put(swap)` round-trips a
 * script object with no methods. So a consumer stores THIS and rebuilds the
 * live record at boot.
 *
 * **The covenant is not stored here.** Every RFQ lockup registers a contract
 * row before its address can be funded (see `lockupContract.ts`), and that row
 * already holds the tree parameters, keyed by the script they derive — a key
 * `createContract` refuses to write unless the params reproduce it. Storing the
 * tree a second time would be two sources for one covenant, drifting apart with
 * nothing to say which is right. So {@link rebuildRfqSwap} takes the parameters
 * from its caller: `lockupContractParams` reads the row, and a consumer that
 * keeps its own copy of `VHTLCV2ContractHandler.serializeParams(...)` can pass
 * that instead.
 *
 * What lives here is what no covenant can give back:
 *
 * - {@link RfqSwapOrigin} — the immutable request-time facts every corridor
 *   has: which corridor, which address was funded, and the corridor's own
 *   opaque {@link RfqSwapOrigin.profile}.
 * - the manager's mutable state, replaced by {@link updateRfqSwapRecord} on
 *   every pass that changed something.
 *
 * A corridor's keys live in its profile, not here — `profile.signer` and, for a
 * leg locked to a preimage, `profile.hashlock`, which carries the `sha256(P)`
 * the covenant cannot give back (it binds `hash160(P)`, one-way over it). See
 * `rfqProfileParts.ts`.
 *
 * **No record written here carries a private key.** The wallet descriptor is
 * public, and so is the per-swap salt a static wallet's preimage derives from —
 * which is what the record stores INSTEAD of P. `preimageHex` appears only when
 * the SDK's provisioned claim secret says P cannot be re-derived at all.
 */
import { ArkAddress, VHTLCV2ContractHandler, type VHTLC } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import {
    isRfqSwapTerminal,
    type LightningReceiveSwap,
    type LightningSendSwap,
    type OnchainSendSwap,
    type RfqSwapState,
} from "./swapManager";
import { rfqCorridorHandlers } from "./rfqCorridor";
import "./rfqCorridors";

/**
 * The swap kinds this projection covers — all three the manager monitors.
 *
 * `onchain_send` carries an L1 half nothing else can rebuild. Its Arkade lockup
 * has a contract row like the others, but the HTLC is Bitcoin L1, not an Arkade
 * contract, so no row exists for it; and `OnchainHtlc` exposes only derived
 * values — `address`, `pkScript`, `leaves`, `controlBlocks` — never the
 * `claimKey`/`refundKey` `onchainHtlcScript` takes as inputs. So they ride in
 * that corridor's {@link RfqSwapOrigin.profile}, and without them a restored
 * swap would let its L1 refund window pass unwatched.
 */
export type PersistableRfqSwap = LightningSendSwap | LightningReceiveSwap | OnchainSendSwap;

/**
 * The serialized covenant parameters a rebuild is given.
 *
 * `VHTLCV2ContractHandler`'s own wire shape — what `serializeParams` writes and
 * `createScript` reads — which is exactly what a lockup's contract row stores
 * under `params`.
 */
export type LockupParams = Record<string, string>;

/**
 * How long a retired swap's record is kept, in SECONDS.
 *
 * Terminal records are history, not garbage: the covenant's spender is a
 * transaction the wallet never signed, so its own history cannot reconstruct
 * them. Kept for a month, then dropped so a hot wallet's store stays bounded.
 *
 * Seconds, not milliseconds, because that is the unit `RfqSwap.updatedAt`
 * carries; the manager stamps it from `RfqSwapManagerConfig.now`, which is
 * "wall clock, in unix seconds". Comparing it against `Date.now()` would drop
 * every terminal record after ~43 minutes.
 */
export const RFQ_SWAP_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** The immutable request-time half, and only what EVERY corridor has. Hex for
 * everything binary, so the record is plain JSON and survives any
 * structured-clone backend unchanged. */
export interface RfqSwapOrigin {
    /**
     * Which corridor this is. Resolves the handler that owns {@link profile};
     * see `rfqCorridor.ts`.
     *
     * The manager's own union, not an open string: `RfqSwapManager` branches on
     * `kind` to decide what to drive, so a corridor it does not know could be
     * persisted and rebuilt here and then never driven — which is the failure
     * this whole file is arranged to make impossible.
     */
    kind: PersistableRfqSwap["kind"];

    /**
     * The Arkade address that was funded.
     *
     * Both the swap's handle on its covenant — {@link lockupContractParams}
     * looks the contract row up by the script it decodes to — and, being taken
     * from the entry point rather than re-derived, the check that the
     * parameters a caller supplies belong to THIS swap.
     */
    lockupAddress: string;

    /**
     * The corridor's own half, as plain JSON — written by the caller from the
     * request result, kept current by the handler's `project`.
     *
     * Opaque here on purpose. Nothing in this file, the repository or the
     * IndexedDB store interprets it, which is what lets a new corridor ship
     * without touching any of them. It carries the corridor's keys as well as
     * its state: `signer` (which wallet key signs this leg) and, on a corridor
     * locked to a preimage, `hashlock` — see `rfqProfileParts.ts`, and write
     * both with `rfqSecretsProfile` rather than by hand.
     */
    profile: Record<string, unknown>;

    /** Consumer display metadata. The rebuild ignores it — `RfqSwapCommon`
     * carries no amount of its own. */
    amount?: number;
}

/** The stored record: the origin plus the manager's mutable state. */
export interface RfqSwapRecord extends RfqSwapOrigin {
    rfqId: string;
    state: RfqSwapState;
    createdAt: number;
    updatedAt: number;
    /**
     * The transactions that funded the lockup — see
     * {@link RfqSwapCommon.fundingTxids}.
     *
     * Common to every corridor, so it lives here rather than in a profile: every
     * corridor has a funded lockup, and the manager learns this from the chain
     * read it already makes on every pass. That is also why it is not on
     * {@link RfqSwapOrigin}: on a receive leg the SOLVER funds the lockup, so a
     * caller-supplied field would be structurally absent on the one leg whose
     * history is hardest to reconstruct.
     */
    fundingTxids?: string[];
    refundArkTxid?: string;
    failure?: string;
    blockedReason?: string;
}

/**
 * The manager's mutable half, projected off a live record.
 *
 * Corridor-agnostic by construction: every field here is one `RfqSwapCommon`
 * declares, so each is on all three legs, and anything a single corridor tracks
 * goes through its handler's `project` instead — `claimArkTxid` included, which
 * only the receive leg has. A per-kind field lifted to here would be written by
 * this function and restored by nobody, since `rebuildRfqSwap` builds the
 * common half from `RfqSwapCommon` alone.
 */
const managerState = (swap: PersistableRfqSwap) => ({
    rfqId: swap.rfqId,
    state: swap.state,
    createdAt: swap.createdAt,
    updatedAt: swap.updatedAt,
    ...(swap.fundingTxids?.length ? { fundingTxids: [...swap.fundingTxids] } : {}),
    ...(swap.refundArkTxid ? { refundArkTxid: swap.refundArkTxid } : {}),
    ...(swap.failure ? { failure: swap.failure } : {}),
    ...(swap.blockedReason ? { blockedReason: swap.blockedReason } : {}),
});

/**
 * The origin and the live swap must be halves of one swap.
 *
 * They arrive separately — the origin written from the request result, the swap
 * built by the entry point — and these two functions are the only place both are
 * in hand, so they are the only place the pairing can be checked at all.
 *
 * Neither mismatch is loud on its own. A `kind` that disagrees runs the wrong
 * handler's `project`, which casts on kind: a receive origin projected off a
 * send swap writes `expectedAmount: undefined` OVER the value the caller just
 * supplied, deleting the gate at the moment it was being recorded. An address
 * that disagrees is quieter still — the record stores no `lockupPkScript`, so
 * {@link rebuildRfqSwap} derives one from `lockupAddress`, and the restored swap
 * watches a covenant that is not the one this swap was monitoring.
 */
function assertSameSwap(origin: RfqSwapOrigin, swap: PersistableRfqSwap): void {
    if (origin.kind !== swap.kind) {
        throw new Error(
            `rfq swap record is a ${origin.kind} origin paired with a ${swap.kind} swap`,
        );
    }
    const funded = hex.encode(ArkAddress.decode(origin.lockupAddress).pkScript);
    const watched = hex.encode(swap.lockupPkScript);
    if (funded !== watched) {
        throw new Error(
            `rfq swap record's lockup address holds ${funded}, but the swap watches ${watched} — ` +
                `these are not the same swap`,
        );
    }
}

/** First write, at the moment the caller hands the swap to the manager. */
export function createRfqSwapRecord(
    origin: RfqSwapOrigin,
    swap: PersistableRfqSwap,
): RfqSwapRecord {
    assertSameSwap(origin, swap);
    const handler = rfqCorridorHandlers.getOrThrow(origin.kind);
    return {
        ...origin,
        ...managerState(swap),
        // The caller wrote what only the request result knows; the handler adds
        // what the live swap already carries.
        profile: { ...origin.profile, ...handler.project(swap) },
    };
}

/** Append-only, order-preserving. See {@link updateRfqSwapRecord}. */
const unionTxids = (
    stored: readonly string[] | undefined,
    learned: readonly string[] | undefined,
): string[] => {
    const out = [...(stored ?? [])];
    const seen = new Set(out);
    for (const txid of learned ?? []) {
        if (seen.has(txid)) continue;
        seen.add(txid);
        out.push(txid);
    }
    return out;
};

/**
 * Every later write. The origin half is carried through untouched.
 *
 * The mutable half is REPLACED, not merged. `managerState` omits a key the live
 * swap no longer carries, so spreading it over the old record could only ever
 * set these fields, never clear them. The manager clears them on purpose: it
 * deletes `blockedReason` when a swap leaves `needs_counterparty`, precisely
 * because a stale `blockedReason` reads as a live refusal.
 *
 * `fundingTxids` is the one exception, and unions instead. It is append-only
 * history, not state: a live swap built by hand rather than by
 * {@link rebuildRfqSwap}, or a pass whose indexer read came back short of a
 * long-spent output, must not be able to delete the identifier the funding
 * transaction is known by — nothing recovers it once the indexer has pruned the
 * output it was read from.
 */
export function updateRfqSwapRecord(
    record: RfqSwapRecord,
    swap: PersistableRfqSwap,
): RfqSwapRecord {
    // Re-checked on every write, not just the first: a manager driving several
    // swaps hands this a record and a live swap looked up separately, and
    // updating one swap's record from another's is exactly how a good record
    // acquires another swap's state.
    assertSameSwap(record, swap);
    const {
        refundArkTxid: _refundArkTxid,
        failure: _failure,
        blockedReason: _blockedReason,
        fundingTxids: stored,
        ...origin
    } = record;
    const handler = rfqCorridorHandlers.getOrThrow(record.kind);
    // The profile MERGES rather than being replaced: `project` returns only
    // what the manager can change, and the rest came from the request result
    // and has no other source.
    const fundingTxids = unionTxids(stored, swap.fundingTxids);
    return {
        ...origin,
        ...managerState(swap),
        ...(fundingTxids.length ? { fundingTxids } : {}),
        profile: { ...record.profile, ...handler.project(swap) },
    };
}

/**
 * The covenant a record is locked to, from parameters supplied by the caller.
 *
 * The parameters and `lockupAddress` reach the record by independent routes —
 * the row was written from the covenant, the address was taken verbatim from
 * the entry point — so requiring them to agree is what stops the wrong row, or
 * a row a field-mapped backend read back short a key, from producing a live
 * record watching a covenant nobody funded.
 */
function lockupScript(
    params: LockupParams,
    lockupAddress: string,
): InstanceType<typeof VHTLC.ScriptV2> {
    const script = VHTLCV2ContractHandler.createScript(params);
    const funded = ArkAddress.decode(lockupAddress).pkScript;
    if (hex.encode(funded) !== hex.encode(script.pkScript)) {
        throw new Error(
            `rfq swap covenant params derive ${hex.encode(script.pkScript)}, but the record's ` +
                `lockup address holds ${hex.encode(funded)} — these params are not this swap's`,
        );
    }
    return script;
}

/**
 * Rebuild the live record. Pure, and synchronous, given the covenant's
 * parameters.
 *
 * Hand the result to {@link RfqSwapManager.start}. Take `params` from the
 * lockup's contract row — {@link lockupContractParams} is the one-liner — or
 * from a copy of `VHTLCV2ContractHandler.serializeParams(script.options)` a
 * consumer keeps itself; either way they are checked against the address that
 * was actually funded, so the `lockupPkScript` this produces is the one the
 * funded lockup is keyed by.
 */
export function rebuildRfqSwap(record: RfqSwapRecord, params: LockupParams): PersistableRfqSwap {
    const script = lockupScript(params, record.lockupAddress);

    const common = {
        rfqId: record.rfqId,
        state: record.state,
        lockupPkScript: script.pkScript,
        lockup: { script, address: record.lockupAddress },
        // From the covenant, which binds it: the record's own copy would be a
        // second source for the deadline the refund is gated on.
        refundLocktime: Number(script.options.refundLocktime),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        // Restored so the next pass unions onto what is already known rather
        // than starting over — the manager's own accumulation is what keeps this
        // append-only across a restart.
        ...(record.fundingTxids?.length ? { fundingTxids: [...record.fundingTxids] } : {}),
        ...(record.refundArkTxid ? { refundArkTxid: record.refundArkTxid } : {}),
        ...(record.failure ? { failure: record.failure } : {}),
        ...(record.blockedReason ? { blockedReason: record.blockedReason } : {}),
    };

    // Corridor-agnostic from here: the handler for this record's kind supplies
    // whatever its leg needs — `paymentHash` included, which is a hashlock's
    // fact and not RFQ's — and this file names none of them. A kind with no
    // handler registered throws rather than restoring a swap nothing knows how
    // to drive.
    const handler = rfqCorridorHandlers.getOrThrow(record.kind);
    return {
        ...common,
        kind: record.kind,
        ...handler.hydrate(record.profile, { lockup: script }),
    } as PersistableRfqSwap;
}

/**
 * Whether a retired swap's record should be kept.
 *
 * `needs_counterparty` is deliberately not terminal and is never dropped: the
 * money is still at the lockup, the counterparty's move is still what ends the
 * swap, and the refusal is re-checked every pass; restoring the right wallet
 * returns it to `pending`.
 *
 * @param now Current time in **unix seconds**; the same unit as
 * `RfqSwap.updatedAt`, which the manager stamps from
 * `RfqSwapManagerConfig.now`. Pass `Math.floor(Date.now() / 1000)`, never
 * `Date.now()`: milliseconds against a seconds window would retire every
 * terminal record after ~43 minutes.
 */
export function shouldRetainRfqSwap(record: RfqSwapRecord, now: number): boolean {
    if (!isRfqSwapTerminal(record.state)) return true;
    return now - record.updatedAt < RFQ_SWAP_RETENTION_SECONDS;
}
