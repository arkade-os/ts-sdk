/**
 * The serializable projection of a monitored RFQ swap.
 *
 * {@link RfqSwap} is a live record, not a storage format: it holds derived
 * `Uint8Array`s and a `VHTLC.ScriptV2` class instance, and IndexedDB's
 * structured clone strips prototypes — a naive `store.put(swap)` round-trips a
 * script object with no methods. So a consumer stores THIS and rebuilds the
 * live record at boot.
 *
 * Two halves, because {@link RfqSwapManagerCallbacks.saveSwap} only ever sees
 * an `RfqSwap`, and that type carries neither the swap's origin nor a pointer
 * to its covenant:
 *
 * - {@link RfqSwapOrigin} — the immutable request-time facts, taken from the
 *   entry point's own return value. Written once, by
 *   {@link createRfqSwapRecord}.
 * - the manager's mutable state, replaced by {@link updateRfqSwapRecord} on
 *   every pass that changed something.
 *
 * **The covenant is NOT stored here.** `registerLockupContract` already
 * persists every tree parameter, keyed by the pkScript, at request time — and
 * throws before the caller holds an address to fund if it cannot. So the
 * contract row is the covenant's durable home and {@link rebuildRfqSwap} reads
 * it back. Keeping a second copy on the record would only be something to keep
 * in sync, free to disagree with the contract the wallet is actually watching.
 * `lockupContract.ts` states the same division from the other side: the row
 * carries script-level facts only, per-swap identity and key material stay
 * here.
 *
 * The cost, stated plainly: a swap can no longer be resumed from its record
 * alone. That is deliberate — one source of truth for the covenant beats two
 * that can disagree — and it costs nothing in practice, since a record whose
 * contract row is missing describes a lockup nothing is watching anyway.
 *
 * **No record written here carries a private key.** The wallet descriptor is
 * public. `preimageHex` is stored only when the SDK's provisioned claim
 * secret says it cannot be re-derived.
 */
import { ArkAddress, VHTLC, VHTLCV2ContractHandler, type IContractManager } from "@arkade-os/sdk";
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
 * `onchain_send` is deliberately absent: {@link RfqSwapOrigin} carries no L1
 * half, so a record could not reproduce its `htlc`, `funding`, `claimTxid` or
 * `minConfirmations`, and storing one here would round-trip a swap whose L1
 * refund window nothing is watching. Taking this rather than `RfqSwap` is what
 * makes that a compile error at the call site instead of a silent loss.
 */
export type PersistableRfqSwap = LightningSendSwap | LightningReceiveSwap;

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

/**
 * The immutable request-time half: what the CONTRACT ROW cannot tell us.
 *
 * `registerLockupContract` already persists the covenant — every tree
 * parameter, via `VHTLCV2ContractHandler.serializeParams(script.options)`,
 * keyed by the pkScript, alongside the address. `lockupContract.ts` states the
 * division this follows:
 *
 * > The row carries script-level facts only. Per-swap identity and key material
 * > stay in the swap record.
 *
 * So this half carries solver and quote facts, key material, and the pointer
 * back to the row — nothing the contract manager already holds. Storing the
 * tree parameters here as well would be a second copy to keep in sync, and the
 * rebuild would be free to disagree with the contract the wallet is actually
 * watching.
 */
export interface RfqSwapOrigin {
    kind: "lightning_send" | "lightning_receive";

    // ── The pointer back to the covenant ─────────────────────────────────────
    /** The lockup's scriptPubKey, hex — the contract row's own key. Everything
     * about the covenant is resolved through this; see {@link rfqSwapCovenant}. */
    lockupScript: string;
    /** The Arkade address that was funded. Taken verbatim from the entry point,
     * never re-derived: a local re-derivation would silently use the SDK's
     * default network. Independent of the row, which is what lets the rebuild
     * check itself — see {@link assertRebuildMatchesLockup}. */
    lockupAddress: string;

    // ── Quote facts, which no covenant carries ───────────────────────────────
    /**
     * `sha256(P)`, hex — the BOLT11 payment hash.
     *
     * Not recoverable from the covenant, which commits to `hash160(P)`: 20
     * bytes, the conventional HTLC shape. Kept so a swap can be correlated to
     * the payer's invoice; the fate check itself does not need it, since
     * `hash160(candidate)` against the row's own `preimageHash` proves the same
     * thing about the same witness.
     */
    paymentHash: string;
    /**
     * What the lockup must carry before the claim will publish `P`.
     *
     * Receive only, and **not re-derivable**: read at claim time it would be
     * whatever the solver funded, which is the dust-funding attack rather than
     * a check on it.
     */
    expectedAmount?: number;
    /** Where a receive claim pays. Receive only. */
    payoutAddress?: string;

    // ── Key material (see `swapSecretsToRecord`) ──────────────────────────────
    /** Public wallet descriptor that recovers the covenant signer. */
    signingDescriptor: string;
    /** The only secret this record may hold; present when the provisioned
     * claim secret says P cannot be re-derived. */
    preimageHex?: string;

    // ── Display ──────────────────────────────────────────────────────────────
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

/** Names the missing field rather than letting `hex.decode(undefined)` throw
 * something that does not say which parameter was lost. */
function required<T>(value: T | undefined, name: string): T {
    if (value === undefined) {
        throw new Error(`rfq swap record is missing ${name}; its covenant cannot be rebuilt`);
    }
    return value;
}

/**
 * The one thing a record can check about itself.
 *
 * It stores both the tree parameters and `lockupAddress` — the address that was
 * actually funded — and the two are independent: the parameters rebuild the
 * covenant, the address was taken verbatim from the entry point. They must
 * agree. A parameter stored wrong or dropped by a field-mapped backend
 * otherwise yields a live record watching a covenant nobody funded, whose
 * refund cannot be signed, and nothing says so until the refund is due. Here it
 * throws at restore instead.
 */
function assertRebuildMatchesLockup(pkScript: Uint8Array, lockupAddress: string): void {
    const funded = ArkAddress.decode(lockupAddress).pkScript;
    if (hex.encode(funded) !== hex.encode(pkScript)) {
        throw new Error(
            `rfq swap record rebuilds ${hex.encode(pkScript)}, but its lockup address holds ` +
                `${hex.encode(funded)} — a stored tree parameter is wrong, so the covenant ` +
                `cannot be spent`,
        );
    }
}

/** The contract-manager surface the rebuild needs — narrowed for injection, the
 * same seam style as `RfqSwapManagerDeps`. */
export type RfqSwapContractLookup = Pick<IContractManager, "getContracts">;

/**
 * The covenant a record describes, from the contract row that already holds it.
 *
 * `registerLockupContract` wrote every tree parameter at request time, before
 * the caller held an address to fund, and threw if it could not. So the row is
 * the covenant's durable home and this reads it back rather than rebuilding
 * from a second copy.
 *
 * Throws when the row is missing: a record whose contract was never registered,
 * or whose store was cleared, describes a lockup this wallet is not watching —
 * and inventing the covenant from stored parameters would hide exactly that.
 */
export async function rfqSwapCovenant(
    contracts: RfqSwapContractLookup,
    lockupScript: string,
): Promise<InstanceType<typeof VHTLC.ScriptV2>> {
    const [row] = await contracts.getContracts({ script: lockupScript });
    if (!row) {
        throw new Error(
            `no registered contract for lockup ${lockupScript}; the swap cannot be resumed ` +
                `because nothing is watching its covenant`,
        );
    }
    return VHTLCV2ContractHandler.createScript(row.params as Record<string, string>);
}

/**
 * Rebuild the live record.
 *
 * Hand the result to {@link RfqSwapManager.start}. The covenant comes from the
 * contract row, then is checked against the address that was actually funded —
 * see {@link assertRebuildMatchesLockup} — so the `lockupPkScript` it produces
 * is the one the funded lockup is keyed by.
 *
 * Reading the row rather than storing the parameters twice is deliberate. The
 * swap flow already depends on the contract store: `registerLockupContract`
 * throws before the caller can fund anything, so there is no state in which the
 * row is unavailable but the record is. A second copy would only add something
 * to keep in sync, free to disagree with the contract the wallet is watching.
 */
export async function rebuildRfqSwap(
    record: RfqSwapRecord,
    contracts: RfqSwapContractLookup,
): Promise<PersistableRfqSwap> {
    const script = await rfqSwapCovenant(contracts, record.lockupScript);
    assertRebuildMatchesLockup(script.pkScript, record.lockupAddress);

    const common = {
        rfqId: record.rfqId,
        state: record.state,
        lockupPkScript: script.pkScript,
        lockup: { script, address: record.lockupAddress },
        paymentHash: record.paymentHash,
        // From the covenant itself — the row is where this lives.
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
