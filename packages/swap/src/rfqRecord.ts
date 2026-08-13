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
 * - {@link RfqSwapOrigin} — the immutable request-time facts. `paymentHash` in
 *   particular is NOT recoverable from the tree: the covenant binds
 *   `hash160(P)`, which is one-way over the hash this record carries.
 * - the manager's mutable state, replaced by {@link updateRfqSwapRecord} on
 *   every pass that changed something.
 *
 * **No record written here carries a private key.** The wallet descriptor is
 * public. `preimageHex` is stored only when the SDK's provisioned claim
 * secret says it cannot be re-derived.
 */
import { ArkAddress, VHTLCV2ContractHandler, type VHTLC } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import {
    isRfqSwapTerminal,
    type LightningReceiveSwap,
    type LightningSendSwap,
    type RfqSwapState,
} from "./swapManager";

/**
 * The swap kinds this projection covers.
 *
 * `onchain_send` is deliberately absent: no contract row and no record here
 * carries an L1 half, so a rebuild could not reproduce its `htlc`, `funding`,
 * `claimTxid` or `minConfirmations`, and storing one would round-trip a swap
 * whose L1 refund window nothing is watching. Taking this rather than `RfqSwap`
 * is what makes that a compile error at the call site instead of a silent loss.
 */
export type PersistableRfqSwap = LightningSendSwap | LightningReceiveSwap;

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

/** The immutable request-time half. Hex for everything binary, so the record is
 * plain JSON and survives any structured-clone backend unchanged. */
export interface RfqSwapOrigin {
    kind: "lightning_send" | "lightning_receive";

    /**
     * `sha256(P)`, hex — the BOLT11 payment hash.
     *
     * Not recoverable from the covenant, which commits to `hash160(P)`: 20
     * bytes, the conventional HTLC shape. Kept so a swap can be correlated to
     * the payer's invoice — the fate check itself does not need it, since
     * `hash160(candidate)` against the covenant's own `preimageHash` proves the
     * same thing about the same witness.
     */
    paymentHash: string;

    /**
     * The Arkade address that was actually funded.
     *
     * Both the swap's handle on its covenant — {@link lockupContractParams}
     * looks the contract row up by the script it decodes to — and, being taken
     * from the entry point rather than re-derived, the check that the
     * parameters a caller supplies belong to THIS swap.
     */
    lockupAddress: string;

    // ── Secrets projection (see `swapSecretsToRecord`) ─────────────────────
    /** Public wallet descriptor that recovers the covenant signer. */
    signingDescriptor: string;
    /** The only secret this record may hold; present when the provisioned
     * claim secret says P cannot be re-derived. */
    preimageHex?: string;

    // ── Receive-leg facts ────────────────────────────────────────────────────
    /**
     * What the lockup must carry before the claim will publish `P`.
     *
     * Receive only, and **not re-derivable**: read at claim time it would be
     * whatever the solver funded, which is the dust-funding attack rather than
     * a check on it.
     */
    expectedAmount?: number;
    /** Where the claim pays. Kept for display: the covenant pins the payout
     * pkScript, but an address also carries the network the record was made
     * on, which a local re-derivation would silently take from the SDK's
     * default. */
    payoutAddress?: string;

    /** Consumer display metadata. {@link rebuildRfqSwap} ignores it —
     * `RfqSwapCommon` carries no amount of its own. */
    amount?: number;
}

/** The stored record: the origin plus the manager's mutable state. */
export interface RfqSwapRecord extends RfqSwapOrigin {
    rfqId: string;
    state: RfqSwapState;
    createdAt: number;
    updatedAt: number;
    refundArkTxid?: string;
    claimArkTxid?: string;
    failure?: string;
    blockedReason?: string;
}

/** The manager's mutable half, projected off a live record. */
const managerState = (swap: PersistableRfqSwap) => ({
    rfqId: swap.rfqId,
    state: swap.state,
    createdAt: swap.createdAt,
    updatedAt: swap.updatedAt,
    ...(swap.refundArkTxid ? { refundArkTxid: swap.refundArkTxid } : {}),
    ...(swap.kind === "lightning_receive" && swap.claimArkTxid
        ? { claimArkTxid: swap.claimArkTxid }
        : {}),
    ...(swap.failure ? { failure: swap.failure } : {}),
    ...(swap.blockedReason ? { blockedReason: swap.blockedReason } : {}),
});

/** First write, at the moment the caller hands the swap to the manager. */
export function createRfqSwapRecord(
    origin: RfqSwapOrigin,
    swap: PersistableRfqSwap,
): RfqSwapRecord {
    return { ...origin, ...managerState(swap) };
}

/**
 * Every later write. The origin half is carried through untouched.
 *
 * The mutable half is REPLACED, not merged. `managerState` omits a key the live
 * swap no longer carries, so spreading it over the old record could only ever
 * set these fields, never clear them. The manager clears them on purpose: it
 * deletes `blockedReason` when a swap leaves `needs_counterparty`, precisely
 * because a stale `blockedReason` reads as a live refusal.
 */
export function updateRfqSwapRecord(
    record: RfqSwapRecord,
    swap: PersistableRfqSwap,
): RfqSwapRecord {
    const {
        refundArkTxid: _refundArkTxid,
        claimArkTxid: _claimArkTxid,
        failure: _failure,
        blockedReason: _blockedReason,
        ...origin
    } = record;
    return { ...origin, ...managerState(swap) };
}

/** Names the missing field rather than letting a rebuild continue with a value
 * whose absence only shows up as a gate that never fires. */
function required<T>(value: T | undefined, name: string): T {
    if (value === undefined) {
        throw new Error(`rfq swap record is missing ${name}; its swap cannot be rebuilt`);
    }
    return value;
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
        paymentHash: record.paymentHash,
        // From the covenant, which binds it: the record's own copy would be a
        // second source for the deadline the refund is gated on.
        refundLocktime: Number(script.options.refundLocktime),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        ...(record.refundArkTxid ? { refundArkTxid: record.refundArkTxid } : {}),
        ...(record.failure ? { failure: record.failure } : {}),
        ...(record.blockedReason ? { blockedReason: record.blockedReason } : {}),
    };

    if (record.kind === "lightning_send") {
        return { ...common, kind: "lightning_send" } satisfies LightningSendSwap;
    }
    return {
        ...common,
        kind: "lightning_receive",
        // Required, not defaulted: the manager reports `needs_counterparty`
        // rather than claiming when this is not a finite number, and a
        // comparison against `undefined` would delete the value gate instead of
        // failing it.
        expectedAmount: required(record.expectedAmount, "expectedAmount"),
        ...(record.claimArkTxid ? { claimArkTxid: record.claimArkTxid } : {}),
    } satisfies LightningReceiveSwap;
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
