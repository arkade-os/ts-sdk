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
 * an `RfqSwap` and that type carries none of the covenant's tree parameters:
 *
 * - {@link RfqSwapOrigin} — the immutable request-time facts, taken from the
 *   entry point's own return value. Written once, by
 *   {@link createRfqSwapRecord}.
 * - the manager's mutable state, merged in by {@link updateRfqSwapRecord} on
 *   every pass that changed something.
 *
 * **Every tree parameter is stored, including the ones that look re-readable
 * from the live wallet.** `serverPubkey` and `claimDelay` are the trader's own
 * *at request time*; a wallet later pointed at a different Arkade Service, or
 * one whose server rotated its key, would rebuild a different covenant and lose
 * the lockup. `emulatorPubkey` is resolved from a per-network pin the SDK can
 * change between releases, for the same reason. Storing them all makes
 * {@link rebuildRfqSwap} a pure function of the record — no wallet, no network,
 * no ambient defaults — which is what lets a test prove a dropped field is a
 * failure rather than a silent wrong address.
 *
 * **No record written here carries a private key.** The preimage is the only
 * permitted secret at rest (see `secrets.ts`'s baseline arm);
 * `fallbackSecrets` is read-only legacy so swaps persisted by earlier versions
 * stay refundable.
 */
import { hex } from "@scure/base";
import { lightningSendVtxoScript, receiveVtxoScript } from "./rfq";
import type { AssetSwapFallbackSecrets } from "./store";
import {
    isRfqSwapTerminal,
    type LightningReceiveSwap,
    type LightningSendSwap,
    type RfqSwap,
    type RfqSwapState,
} from "./swapManager";

/**
 * How long a retired swap's record is kept, in SECONDS.
 *
 * Terminal records are history, not garbage: the covenant's spender is a
 * transaction the wallet never signed, so its own history cannot reconstruct
 * them. Kept for a month, then dropped so a hot wallet's store stays bounded.
 *
 * Seconds, not milliseconds, because that is the unit `RfqSwap.updatedAt`
 * carries — the manager stamps it from `RfqSwapManagerConfig.now`, which is
 * "wall clock, in unix seconds". Comparing it against `Date.now()` would drop
 * every terminal record after ~43 minutes.
 */
export const RFQ_SWAP_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** The immutable request-time half. Hex for everything binary, so the record is
 * plain JSON and survives any structured-clone backend unchanged. */
export interface RfqSwapOrigin {
    kind: "lightning_send" | "lightning_receive";

    // ── Tree parameters shared by both legs ──────────────────────────────────
    /** The solver's x-only key, from the quote. */
    solverPubkey: string;
    /** The covenant co-signer, from the SDK's per-network pin or an override. */
    emulatorPubkey: string;
    /** The Arkade Service's x-only key, as it was AT REQUEST TIME. */
    serverPubkey: string;
    /** `sha256(P)`, hex. */
    paymentHash: string;
    refundLocktime: number;
    /** `unilateralClaimDelay` over the server info held at request time. */
    claimDelay: number;

    // ── Send-leg tree parameters ─────────────────────────────────────────────
    /** VHTLC's `sender` — the trader's own key on this leg. */
    senderPubkey?: string;
    /** Where the refund leaf must pay. */
    refundPkScript?: string;
    /** The solver's claim destination, from `profile.receiver_pk_script`. */
    receiverPkScript?: string;

    // ── Receive-leg tree parameters ──────────────────────────────────────────
    /** VHTLC's `receiver` — the trader's own key on this leg. */
    payoutPubkey?: string;
    /** `nonInteractiveClaim`'s pinned destination. */
    payoutPkScript?: string;
    /** From `profile.solver_refund_pk_script` — the one tree parameter nothing
     * else on the wire determines. */
    solverRefundPkScript?: string;
    /** Where the claim pays; kept for display and for rebuilding the claim. */
    payoutAddress?: string;
    /**
     * What the lockup must carry before the claim will publish `P`.
     *
     * Receive only, and **not re-derivable**: read at claim time it would be
     * whatever the solver funded, which is the dust-funding attack rather than
     * a check on it.
     */
    expectedAmount?: number;

    // ── Secrets projection (see `rfqSecretsToRecord`) ────────────────────────
    /** Public. Present on the HD-allocated arm. */
    signingDescriptor?: string;
    /** Present on the baseline arm: the covenant is bound to the wallet's own
     * identity key. An explicit marker, not the absence of a descriptor. */
    senderKey?: "baseline";
    /** The only secret this record may hold. */
    preimageHex?: string;
    /** Public, and unwritten today — the slot a per-swap derivation index lands
     * in (ts-sdk#737), so that change is a schema no-op. */
    preimageIndex?: number;
    /** Read-only legacy from records written before the baseline arm existed. */
    fallbackSecrets?: AssetSwapFallbackSecrets;

    // ── Lockup and display ───────────────────────────────────────────────────
    /** The Arkade address that was actually funded. Taken, never re-derived:
     * a local re-derivation would silently use the SDK's default network. */
    lockupAddress: string;
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
const managerState = (swap: RfqSwap) => ({
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
export function createRfqSwapRecord(origin: RfqSwapOrigin, swap: RfqSwap): RfqSwapRecord {
    return { ...origin, ...managerState(swap) };
}

/** Every later write. The origin half is carried through untouched. */
export function updateRfqSwapRecord(record: RfqSwapRecord, swap: RfqSwap): RfqSwapRecord {
    return { ...record, ...managerState(swap) };
}

/** Names the missing field rather than letting `hex.decode(undefined)` throw
 * something that does not say which parameter was lost. */
function required<T>(value: T | undefined, name: string): T {
    if (value === undefined) {
        throw new Error(`rfq swap record is missing ${name}; its covenant cannot be rebuilt`);
    }
    return value;
}

const bytes = (value: string | undefined, name: string): Uint8Array =>
    hex.decode(required(value, name));

/**
 * Rebuild the live record. Pure: everything it needs is on the record.
 *
 * Hand the result to {@link RfqSwapManager.start}. The covenant is rebuilt the
 * way it was made — the same builder over the same binding fields — so the
 * `lockupPkScript` it produces is the one the funded lockup is keyed by.
 */
export function rebuildRfqSwap(record: RfqSwapRecord): RfqSwap {
    const script =
        record.kind === "lightning_send"
            ? lightningSendVtxoScript({
                  solverPubkey: bytes(record.solverPubkey, "solverPubkey"),
                  refundLocktime: record.refundLocktime,
                  serverPubkey: bytes(record.serverPubkey, "serverPubkey"),
                  paymentHash: record.paymentHash,
                  claimDelay: record.claimDelay,
                  emulatorPubkey: bytes(record.emulatorPubkey, "emulatorPubkey"),
                  refundPkScript: bytes(record.refundPkScript, "refundPkScript"),
                  senderPubkey: bytes(record.senderPubkey, "senderPubkey"),
                  receiverPkScript: bytes(record.receiverPkScript, "receiverPkScript"),
              })
            : receiveVtxoScript({
                  solverPubkey: bytes(record.solverPubkey, "solverPubkey"),
                  refundLocktime: record.refundLocktime,
                  serverPubkey: bytes(record.serverPubkey, "serverPubkey"),
                  paymentHash: record.paymentHash,
                  claimDelay: record.claimDelay,
                  emulatorPubkey: bytes(record.emulatorPubkey, "emulatorPubkey"),
                  solverRefundPkScript: bytes(record.solverRefundPkScript, "solverRefundPkScript"),
                  payoutPubkey: bytes(record.payoutPubkey, "payoutPubkey"),
                  payoutPkScript: bytes(record.payoutPkScript, "payoutPkScript"),
              });

    const common = {
        rfqId: record.rfqId,
        state: record.state,
        lockupPkScript: script.pkScript,
        lockup: { script, address: record.lockupAddress },
        paymentHash: record.paymentHash,
        refundLocktime: record.refundLocktime,
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
 * swap, and the refusal is re-checked every pass — restoring the right wallet
 * returns it to `pending`.
 *
 * @param now Current time in **unix seconds** — the same unit as
 * `RfqSwap.updatedAt`, which the manager stamps from
 * `RfqSwapManagerConfig.now`. Pass `Math.floor(Date.now() / 1000)`, never
 * `Date.now()`: milliseconds against a seconds window would retire every
 * terminal record after ~43 minutes.
 */
export function shouldRetainRfqSwap(record: RfqSwapRecord, now: number): boolean {
    if (!isRfqSwapTerminal(record.state)) return true;
    return now - record.updatedAt < RFQ_SWAP_RETENTION_SECONDS;
}
