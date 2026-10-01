/**
 * RFQ v1 — the user side of quoted swaps.
 *
 * RFQ is the negotiation layer only. After the quote, **filling is non-interactive**: the user
 * funds, and the solver fills by observing that funding. There is deliberately NO accept message:
 * acceptance is funding, and every corridor ends in a fill or the value back.
 *
 * - send (`arkade:BTC -> lightning|onchain:BTC`): the user funds its own locally derived VHTLC
 *   ({@link lightningSendContract}). A failed swap refunds by the user's `sender` key, or, if that
 *   key is lost, via the `nonInteractiveRefund` leaf the emulator co-signs under a covenant paying
 *   only the user's pre-committed address.
 * - receive (`lightning|onchain:BTC -> arkade:BTC`): the user generates `P`, pays the hold invoice
 *   or funds the L1 HTLC, and may go offline; the solver funds a lockup pinned to the user's payout
 *   ({@link lightningReceiveContract}), and the claim reveals `P`, settling the user's side.
 * - `arkade -> arkade`: the user funds an Intents **offer** (`createOffer`) bound to the quote; any
 *   filler may deliver, or the user cancels cooperatively.
 *
 * Trust model: from a quote the user uses only the binding fields (`solver_pubkey`,
 * `refund_locktime`, `valid_until`, the amounts, and `profile.refund_without_receiver_delay` on
 * Lightning sends). Everything else is the user's own data or a trusted constant (the emulator key
 * defaults to the SDK's per-network pin). Anything address-shaped from the solver is compare-only:
 * a mismatch means refuse-to-fund, never "use theirs".
 *
 * @deprecated Internal to `client.quote()` and `client.accept()`. Moved off the package root to `@arkade-os/swap/protocol`.
 */
import { hex } from "@scure/base";
import { isAmount } from "@arkade-os/solver-discovery";
import { ripemd160 } from "@noble/hashes/legacy.js";
import {
    ArkAddress,
    VHTLC,
    asset,
    networkFromArkadeInfo,
    resolveEmulatorPubkey,
    toXOnly,
    type ArkadeInfo,
    type IWallet,
} from "@arkade-os/sdk";

import {
    MAX_MIN_CONFIRMATIONS,
    ONCHAIN_CLAIM_MARGIN_SECONDS,
    ONCHAIN_ORDER_MARGIN_SECONDS,
    ONCHAIN_SECONDS_PER_BLOCK,
    gateError,
    onchainHtlcScript,
    paymentHashOf,
    type OnchainHtlc,
    type OnchainHtlcParams,
    type OnchainNetwork,
} from "./onchainHtlc";

export {
    MAX_MIN_CONFIRMATIONS,
    ONCHAIN_CLAIM_MARGIN_SECONDS,
    ONCHAIN_ORDER_MARGIN_SECONDS,
} from "./onchainHtlc";

import {
    provisionClaimSecret,
    provisionRefundKey,
    type ProvisionedClaimSecret,
    type ProvisionedKey,
} from "@arkade-os/sdk";
import { sealClaimPacket } from "./claimPacket";
import { registerLockupContract } from "./lockupContract";
import { ASSET_CARRIER_SATS, createOffer } from "./offer";

/** Decode a solver-supplied hex field, blaming the solver on malformed input. */
const solverHex = (value: string, field: string): Uint8Array => {
    try {
        return hex.decode(value);
    } catch {
        throw new Error(`solver sent malformed hex for ${field}`);
    }
};

/** Sats amount off an HTLC-class quote. A string here is a misrouted asset quote, not coercible. */
const quoteSats = (value: number | string, field: string): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new Error(`HTLC quote carries a non-sats ${field}: ${String(value)}`);
    }
    return value;
};

/** A quoted amount in sats, reading the wire's canonical decimal string as well as a JSON number.
 * Solvers emit strings on every corridor, so on value-gate fields a string is an encoding, not a
 * misrouted asset quote. */
const quoteAmountSats = (value: number | string, field: string): bigint => {
    if (typeof value === "string" && isAmount(value)) return BigInt(value);
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
    throw new Error(`HTLC quote carries an unreadable ${field}: ${String(value)}`);
};

/** The claim gate's `expectedAmount`: positive, and a safe integer. */
const quoteExpectedSats = (value: number | string, field: string): number => {
    const sats = quoteAmountSats(value, field);
    if (sats <= 0n || sats > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`HTLC quote carries an unusable ${field}: ${String(value)}`);
    }
    return Number(sats);
};

// ── Pairs ────────────────────────────────────────────────────────────────────

/** Legs are `<corridor>:<asset>`; a pair is directional, `from->to`. */
export const ARKADE_BTC = "arkade:BTC";
export const LIGHTNING_BTC = "lightning:BTC";
export const ONCHAIN_BTC = "onchain:BTC";

/** The arkade leg for an asset: the asset id itself, 68 lowercase hex, in the pair because the
 * pair is what both sides route and subscribe on.
 *
 * Takes an `AssetId`, not a string, to enforce lowercase (`hex.decode` accepts uppercase,
 * `toString()` emits lowercase): solvers compare pair strings byte for byte, so `A1B2…` would be
 * skipped as an unserved pair. */
export const arkadeAssetLeg = (id: asset.AssetId): string => `arkade:${id.toString()}`;
export const rfqPair = (from: string, to: string): string => `${from}->${to}`;

/** The implemented pair: pay a BOLT11 invoice out of an Arkade balance. */
export const LIGHTNING_SEND_PAIR = rfqPair(ARKADE_BTC, LIGHTNING_BTC);
/** On-board via Lightning: pay the solver's hold invoice, land on Arkade. */
export const LIGHTNING_RECEIVE_PAIR = rfqPair(LIGHTNING_BTC, ARKADE_BTC);
export const ONCHAIN_SEND_PAIR = rfqPair(ARKADE_BTC, ONCHAIN_BTC);
/** On-board: a Bitcoin-L1 HTLC in, Arkade sats out. */
export const ONCHAIN_RECEIVE_PAIR = rfqPair(ONCHAIN_BTC, ARKADE_BTC);
// ── Errors and closed sets ───────────────────────────────────────────────────

/** The closed refusal set. Treat any unknown reason as a generic decline. */
export type RfqRefusalReason =
    | "unsupported_pair"
    | "unsupported_payload"
    | "amount_out_of_range"
    | "exposure_cap"
    | "invoice_expired"
    | "quote_conflict"
    | "pricing_unavailable"
    | "rate_limited";

/** Lifecycle vocabulary; states after which nothing more will happen. */
export const RFQ_TERMINAL_STATES = ["settled", "refused", "expired", "refunded", "stuck"] as const;

export const RFQ_REFUSAL_ERROR_CODES = [
    "amount_side_unsupported",
    "exact_out_unsupported",
    "invalid_amount",
    "invalid_payout_address",
    "invalid_refund_address",
    "invoice_amount_mismatch",
    "invoice_cltv_too_large",
    "invoice_malformed",
    "invoice_missing_amount",
    "invoice_missing_network",
    "invoice_missing_payment_hash",
    "invoice_missing_timestamp",
    "invoice_mixed_case",
    "invoice_sub_satoshi_amount",
    "invoice_too_long",
    "invoice_wrong_network",
] as const;

export type RfqRefusalErrorCode = (typeof RFQ_REFUSAL_ERROR_CODES)[number];
export type RfqRefusalUnit = "blocks" | "characters" | "sats";

export interface RfqRefusalDetail {
    errorCode?: RfqRefusalErrorCode;
    field?: string;
    actual?: number;
    expected?: number;
    limit?: number;
    unit?: RfqRefusalUnit;
}

export const isRfqRefusalErrorCode = (value: unknown): value is RfqRefusalErrorCode =>
    typeof value === "string" && (RFQ_REFUSAL_ERROR_CODES as readonly string[]).includes(value);

const REFUSAL_FIELDS = new Set([
    "amount",
    "amount_side",
    "profile.invoice",
    "profile.payout_address",
    "profile.refund_address",
]);
const REFUSAL_UNITS = new Set<RfqRefusalUnit>(["blocks", "characters", "sats"]);
const safeInteger = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const safeRefusalDetail = (detail: {
    errorCode?: unknown;
    field?: unknown;
    actual?: unknown;
    expected?: unknown;
    limit?: unknown;
    unit?: unknown;
}): RfqRefusalDetail => {
    if (!isRfqRefusalErrorCode(detail.errorCode)) return {};
    return {
        errorCode: detail.errorCode,
        field:
            typeof detail.field === "string" && REFUSAL_FIELDS.has(detail.field)
                ? detail.field
                : undefined,
        actual: safeInteger(detail.actual),
        expected: safeInteger(detail.expected),
        limit: safeInteger(detail.limit),
        unit:
            typeof detail.unit === "string" && REFUSAL_UNITS.has(detail.unit as RfqRefusalUnit)
                ? (detail.unit as RfqRefusalUnit)
                : undefined,
    };
};

const refusalMessage = (reason: string, detail: RfqRefusalDetail): string => {
    if (!detail.errorCode) return `solver refused: ${reason}`;
    const where = detail.field ? ` at ${detail.field}` : "";
    const unit = detail.unit ? ` ${detail.unit}` : "";
    if (detail.actual !== undefined && detail.limit !== undefined) {
        return `solver refused: ${reason} (${detail.errorCode}${where}: ${detail.actual}${unit}, limit ${detail.limit})`;
    }
    if (detail.actual !== undefined && detail.expected !== undefined) {
        return `solver refused: ${reason} (${detail.errorCode}${where}: ${detail.actual}${unit}, expected ${detail.expected})`;
    }
    return `solver refused: ${reason} (${detail.errorCode}${where})`;
};

/** A refusal from the solver, carrying its closed-set reason. */
export class SwapRefusal extends Error {
    /** Literal-typed so the v2 error taxonomy's union discriminates on `name`
     * — a `string` here collapses the discriminant for every member. */
    override readonly name = "SwapRefusal";
    readonly reason: string;
    readonly rfqId: string | undefined;
    readonly errorCode: RfqRefusalErrorCode | undefined;
    readonly field: string | undefined;
    readonly actual: number | undefined;
    readonly expected: number | undefined;
    readonly limit: number | undefined;
    readonly unit: RfqRefusalUnit | undefined;
    constructor(reason: string, rfqId?: string, detail: RfqRefusalDetail = {}) {
        const safeDetail = safeRefusalDetail(detail);
        super(refusalMessage(reason, safeDetail));
        this.reason = reason;
        this.rfqId = rfqId;
        this.errorCode = safeDetail.errorCode;
        this.field = safeDetail.field;
        this.actual = safeDetail.actual;
        this.expected = safeDetail.expected;
        this.limit = safeDetail.limit;
        this.unit = safeDetail.unit;
    }
}

/**
 * The solver's address does not match the local derivation. NEVER fund past
 * this. `derived` is every candidate address tried — more than one when the
 * derivation itself is ambiguous, see {@link verifyLockupAddress}.
 */
export class AddressMismatch extends Error {
    readonly derived: string | string[];
    readonly quoted: string | undefined;
    constructor(derived: string | string[], quoted?: string) {
        super("solver lockup address does not match local derivation — refusing to fund");
        this.name = "AddressMismatch";
        this.derived = derived;
        this.quoted = quoted;
    }
}

// ── Messages ─────────────────────────────────────────────────────────────────

/** A fresh client-chosen negotiation id: 32 random bytes, lowercase hex. */
export const newRfqId = (): string => hex.encode(crypto.getRandomValues(new Uint8Array(32)));

export interface RfqQuote {
    v: 1;
    type: "rfq_quote";
    rfq_id: string;
    pair: string;
    /** Sats on HTLC-class corridors (number); canonical decimal string on
     * arkade↔arkade asset legs (bigint range, see WIRE_ASSET_AMOUNT on the
     * solver). */
    from_amount: number | string;
    to_amount: number | string;
    /** Dust an asset rides on. NOT a fee — already netted into the amounts above. */
    carrier_sats?: number | string;
    solver_pubkey: string;
    valid_until: number;
    /** HTLC-class quotes only; absent for arkade↔arkade. */
    refund_locktime?: number;
    profile: {
        [key: string]: unknown;
        payment_hash?: string;
        lockup_address?: string;
        refund_without_receiver_delay?: number;
        offer_address?: string;
        offer_pk_script?: string;
    };
    [key: string]: unknown;
}

export interface RfqStatus {
    v: 1;
    type: "rfq_status";
    rfq_id: string;
    state: string;
    updated_at: number;
    profile: Record<string, unknown>;
    [key: string]: unknown;
}

/** The rfq_request for the lightning send profile. BOLT11 is exact-out: the invoice fixes the
 * amount. `senderPubkey` is the trader's key for the VHTLC's sender-side leaves (see
 * {@link lightningSendContract}), sent as `client_refund_pubkey`; the solver's schema
 * (https://docs.arkadeos.com/intents/reference/rfq) is `.strict()`, so a wrong or missing name
 * refuses every request.
 */
export const lightningSendRequest = (input: {
    rfqId: string;
    invoice: string;
    refundAddress: string;
    senderPubkey: Uint8Array;
}): Record<string, unknown> => ({
    v: 1,
    type: "rfq_request",
    rfq_id: input.rfqId,
    pair: LIGHTNING_SEND_PAIR,
    amount_side: "to",
    profile: {
        invoice: input.invoice,
        refund_address: input.refundAddress,
        client_refund_pubkey: hex.encode(input.senderPubkey),
    },
});

/** The rfq_request for an arkade↔arkade swap. At least one side names an asset
 * id (BTC has none), and the id is the leg itself — see
 * {@link arkadeAssetLeg}.
 *
 * Matches the reference solver's strict `AssetRfqRequest`: `amount` is a canonical decimal string
 * of atomic units (never a JSON number: an asset's precision is unknowable client-side), and
 * `amount_side` is `"from"` or `"to"`, and `profile` carries the trader's covenant position — the fill pays `maker_pk_script`, and `cancel`
 * is signed by `maker_public_key`. */
export const arkadeSwapRequest = (input: {
    rfqId: string;
    /** Asset the trader deposits; omit when depositing BTC. */
    offerAsset?: asset.AssetId;
    /** Asset the trader wants; omit when wanting BTC. */
    wantAsset?: asset.AssetId;
    amountSide?: "from" | "to";
    /** Atomic units of the deposit (`from`) leg. bigint-safe: encoded as a
     * canonical decimal string on the wire. */
    amount: bigint | number | string;
    /** Trader's own taproot scriptPubKey (34 bytes, `OP_1 <32-byte program>`),
     * as bytes or lowercase hex. The covenant's `makerWP` minus its prefix. */
    makerPkScript: Uint8Array | string;
    /** Trader's own x-only key (32 bytes), as bytes or lowercase hex. The
     * `cancel` path's `user` signer. */
    makerPublicKey: Uint8Array | string;
}): Record<string, unknown> => {
    if (!input.wantAsset && !input.offerAsset) {
        throw new Error(
            "set at least one of wantAsset or offerAsset — " +
                "with neither set both legs are BTC, which is not a swap",
        );
    }
    const pair = rfqPair(
        input.offerAsset ? arkadeAssetLeg(input.offerAsset) : ARKADE_BTC,
        input.wantAsset ? arkadeAssetLeg(input.wantAsset) : ARKADE_BTC,
    );
    assertPairLength(pair);
    return {
        v: 1,
        type: "rfq_request",
        rfq_id: input.rfqId,
        pair,
        amount_side: input.amountSide ?? "from",
        amount: canonicalAssetAmount(input.amount),
        // The solver's `.strict()` schema refuses any undeclared key as `unsupported_payload`.
        profile: {
            maker_pk_script: normalizeMakerPkScript(input.makerPkScript),
            maker_public_key: normalizeMakerPublicKey(input.makerPublicKey),
        },
    };
};

/** Canonical decimal string of atomic units: ASCII digits, no sign, point,
 * exponent, or leading zero (unless the value is exactly "0"). bigint passes
 * through; number must be a safe integer; string must already be canonical.
 *
 * @deprecated Internal to `client.quote()` and `client.accept()`. Moved off the package root to `@arkade-os/swap/protocol`. */
export const canonicalAssetAmount = (amount: bigint | number | string): string => {
    if (typeof amount === "bigint") {
        if (amount <= 0n) throw new Error(`amount must be positive, got ${amount}`);
        return amount.toString();
    }
    if (typeof amount === "number") {
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            throw new Error(`amount must be a positive safe integer, got ${amount}`);
        }
        return String(amount);
    }
    if (!/^(0|[1-9][0-9]*)$/.test(amount) || BigInt(amount) <= 0n) {
        throw new Error(`amount must be a canonical decimal string of atomic units, got ${amount}`);
    }
    return amount;
};

const normalizeHexBytes = (
    value: Uint8Array | string,
    expectedBytes: number,
    label: string,
): string => {
    if (value === undefined || value === null) {
        throw new Error(`${label} is required`);
    }
    const bytes = typeof value === "string" ? solverHex(value, label) : value;
    if (!(bytes instanceof Uint8Array) || bytes.length !== expectedBytes) {
        const got = bytes instanceof Uint8Array ? bytes.length : typeof bytes;
        throw new Error(`${label} must be ${expectedBytes} bytes, got ${got}`);
    }
    return hex.encode(bytes);
};

/** 34-byte taproot scriptPubKey (`OP_1 <32-byte program>`), lowercase hex.
 *
 * @deprecated Internal to `client.quote()` and `client.accept()`. Moved off the package root to `@arkade-os/swap/protocol`. */
export const normalizeMakerPkScript = (value: Uint8Array | string): string => {
    const encoded = normalizeHexBytes(value, 34, "maker_pk_script");
    if (!encoded.startsWith("5100") && !encoded.startsWith("5120")) {
        throw new Error("maker_pk_script must be a taproot scriptPubKey (OP_1 <32-byte program>)");
    }
    return encoded;
};

/** 32-byte x-only key, lowercase hex. Never a 33-byte compressed key.
 *
 * @deprecated Internal to `client.quote()` and `client.accept()`. Moved off the package root to `@arkade-os/swap/protocol`. */
export const normalizeMakerPublicKey = (value: Uint8Array | string): string => {
    const raw = typeof value === "string" ? value : hex.encode(value);
    const bytes = solverHex(raw, "maker_public_key");
    if (bytes.length === 33) {
        throw new Error("maker_public_key must be x-only (32 bytes), not compressed (33 bytes)");
    }
    return normalizeHexBytes(bytes, 32, "maker_public_key");
};

// ── Guardrails ───────────────────────────────────────────────────────────────

/** Funding gate: refuse unless ≥90 min remain before the refund path opens.
 * 90 because the refund CLTV matures against median-time-past (BIP-113),
 * which lags wall clock by ~1h — a smaller wall-clock margin is no margin. */
export const MIN_HEADROOM_SECONDS = 90 * 60;

/**
 * Refuse a number no gate can compare against.
 *
 * `NaN` fails EVERY comparison, so an unchecked `NaN` silently deletes its gate rather than failing
 * it. The wire is JSON, so a field typed `number` can arrive as a string and become `NaN` on first
 * arithmetic. Infinities are refused too: they mean the source is broken. `undefined` passes;
 * callers check absence separately where it is itself a refusal.
 */
const assertFinite = (value: number | undefined, reason: string, label: string): void => {
    if (value !== undefined && !Number.isFinite(value)) {
        throw gateError(reason, `${label} is not a finite number (${String(value)})`);
    }
};

/** The wire's cap on a pair string, mirrored so an over-long pair fails here
 * with a reason instead of arriving as a bare `unsupported_payload`.
 *
 * 158 = ("lightning".length + 1 + 68) * 2 + "->".length. Restated from the solver, not derived
 * from local corridor names: a local cap BELOW the solver's would refuse pairs it would serve.
 * Not in `index.ts`: it mirrors a number this repo does not own. */
export const MAX_PAIR_LENGTH = 158;

/** Exported for the tests — a dormant guard still needs one, and no public
 * entry point can reach it. Not in `index.ts`. */
export const assertPairLength = (pair: string): void => {
    if (pair.length > MAX_PAIR_LENGTH) {
        throw new Error(
            `pair is ${pair.length} characters, over the wire's ${MAX_PAIR_LENGTH}-character limit`,
        );
    }
};

/**
 * Compare-only check of the solver's address against YOUR OWN derivation(s)
 * — never extends trust, only narrows it.
 *
 * Pass an array when your derivation is ambiguous, as for covenant lockups while solvers roll out
 * the timelocked non-interactive refund leaf (nothing on the wire says which shape a quote uses).
 * No security is lost: every candidate pins the refund to the trader's own destination.
 *
 * @returns the address that matched.
 * @throws {AddressMismatch} only when NONE of the candidates match.
 */
export const verifyLockupAddress = (quote: RfqQuote, derivedAddress: string | string[]): string => {
    const quoted = quote.profile?.lockup_address;
    const candidates = Array.isArray(derivedAddress) ? derivedAddress : [derivedAddress];
    const matched = candidates.find((address) => address === quoted);
    if (matched === undefined) throw new AddressMismatch(candidates, quoted);
    return matched;
};

/** The full suite (`undefined`) and the pre-timelocked-refund shape; see
 * {@link verifyLockupAddress}. Newest first, so a full-suite match wins. */
const LOCKUP_SHAPE_VARIANTS = [undefined, "preTimelockedRefund"] as const;

/**
 * Build a lockup covenant in both {@link LOCKUP_SHAPE_VARIANTS} shapes and keep the one the quote's
 * `lockup_address` matches (else throw). Returns the SCRIPT too: registering the wrong candidate
 * would watch a tree the funded lockup is not in.
 */
const matchQuotedLockup = (
    quote: RfqQuote,
    hrp: string,
    serverPubkey: Uint8Array,
    build: (legacy?: "preTimelockedRefund") => InstanceType<typeof VHTLC.ScriptV2>,
): {
    script: InstanceType<typeof VHTLC.ScriptV2>;
    address: string;
    legacy?: "preTimelockedRefund";
} => {
    const candidates = LOCKUP_SHAPE_VARIANTS.map((legacy) => {
        const script = build(legacy);
        return { script, address: script.address(hrp, serverPubkey).encode(), legacy };
    });
    const matchedAddress = verifyLockupAddress(
        quote,
        candidates.map((candidate) => candidate.address),
    );
    // `find` cannot miss: verifyLockupAddress only ever returns a candidate
    // it was given, or throws.
    return candidates.find((candidate) => candidate.address === matchedAddress)!;
};

/** The user's gates, checked immediately before funding, never at quote time. Throws with a
 * stable `reason`. `onchain` adds the L1-HTLC gates and is required for the onchain pairs.
 *
 * The lightning-receive leg uses {@link assertReceivable} instead: `refund_locktime` is the
 * SOLVER's there and the hold invoice is the clock that runs out. Onchain-receive stays here,
 * where the headroom check is over-strict but never unsafe. */
export const assertFundable = (input: {
    quote: RfqQuote;
    invoiceExpiresAt?: number;
    now: number;
    onchain?: {
        htlcLocktime: number;
        minConfirmations: number;
        /** "send" = arkade->onchain (the L1 timelock-order gate applies). */
        direction: "send" | "receive";
    };
    /**
     * The most this client will pay: the GREATER of the two bounds (a flat fee is a large share of
     * a small swap). Absent means no ceiling. OMIT a bound rather than zeroing it: `{ bps: 0 }`
     * alone is a ceiling of zero. `{}` IS refused.
     */
    maxFee?: {
        /** Integer, 0..10_000 (10_000 = 100%). Out of range throws `max_fee_out_of_range`. */
        bps?: number;
        /** Non-negative integer. Out of range throws `max_fee_out_of_range`. */
        sats?: number;
        /** To-units per from-unit, required for a CROSS-ASSET pair. From a source of YOUR OWN:
         * the solver's feed would check the solver against itself. */
        referenceRate?: number;
    };
}): void => {
    const fail = (reason: string, message: string): never => {
        throw gateError(reason, message);
    };
    // `valid_until` feeds the expiry gate AND the v2 TTL floor; absent or NaN it deletes both.
    if (input.quote.valid_until === undefined) {
        fail("quote_malformed", "quote carries no valid_until");
    }
    assertFinite(input.quote.valid_until, "quote_malformed", "quote valid_until");
    if (input.invoiceExpiresAt !== undefined && input.now >= input.invoiceExpiresAt) {
        fail("invoice_expired", "invoice expired");
    }
    if (input.now >= input.quote.valid_until)
        fail("quote_expired", "quote expired — request a fresh one");
    // A non-positive quoted amount is a value gate that cannot fail.
    if (
        quoteAmountSats(input.quote.from_amount, "from_amount") <= 0n ||
        quoteAmountSats(input.quote.to_amount, "to_amount") <= 0n
    ) {
        fail("non_positive_amount", "quote carries a non-positive amount");
    }
    if (
        input.quote.refund_locktime !== undefined &&
        input.quote.refund_locktime - input.now < MIN_HEADROOM_SECONDS
    ) {
        fail("insufficient_headroom", "refund deadline headroom below 90 minutes");
    }
    if (input.maxFee) {
        const { bps, sats, referenceRate } = input.maxFee;
        if (bps === undefined && sats === undefined) {
            // A ceiling naming nothing is a call-site mistake, not a bad quote.
            fail("max_fee_unbounded", "maxFee names neither bps nor sats");
        }
        if (bps !== undefined && (!Number.isInteger(bps) || bps < 0 || bps > 10_000)) {
            fail("max_fee_out_of_range", `maxFee.bps must be an integer in 0..10000, got ${bps}`);
        }
        if (sats !== undefined && (!Number.isInteger(sats) || sats < 0)) {
            fail("max_fee_out_of_range", `maxFee.sats must be a non-negative integer, got ${sats}`);
        }
        const legs = input.quote.pair.split("->");
        const assetOf = (leg: string): string => leg.slice(leg.indexOf(":") + 1);
        const sameAsset = legs.length === 2 && assetOf(legs[0]!) === assetOf(legs[1]!);
        if (!sameAsset && referenceRate === undefined) {
            fail(
                "fee_gate_unavailable",
                `maxFee cannot gate ${input.quote.pair}: its legs name different assets, so ` +
                    `from_amount - to_amount is not a fee. Supply maxFee.referenceRate ` +
                    `(to-units per from-unit) from a source of your OWN — reading it off the ` +
                    `solver's published feed would check the solver against its own number`,
            );
        }
        if (!sameAsset && (!Number.isFinite(referenceRate) || (referenceRate as number) <= 0)) {
            fail(
                "max_fee_out_of_range",
                `maxFee.referenceRate must be a positive finite number, got ${referenceRate}`,
            );
        }
        // Rounds UP: refuse a borderline quote, do not fund a rounding artefact.
        const fromSats = quoteSats(input.quote.from_amount, "from_amount");
        const toSats = quoteSats(input.quote.to_amount, "to_amount");
        const fee = sameAsset
            ? fromSats - toSats
            : Math.ceil(
                  (fromSats * (referenceRate as number) - toSats) / (referenceRate as number),
              );
        const allowed = Math.max(sats ?? 0, Math.floor((fromSats * (bps ?? 0)) / 10_000));
        if (fee > allowed) {
            fail("fee_too_high", `fee ${fee} exceeds the ${allowed} this client allows`);
        }
    }
    if (input.onchain) {
        const { htlcLocktime, minConfirmations, direction } = input.onchain;
        if (
            !Number.isInteger(minConfirmations) ||
            minConfirmations < 1 ||
            minConfirmations > MAX_MIN_CONFIRMATIONS
        ) {
            fail(
                "confirmations_out_of_range",
                `min_confirmations must be 1..${MAX_MIN_CONFIRMATIONS}, got ${minConfirmations}`,
            );
        }
        // Enough room to confirm the fill AND claim well before the refund
        // leaf opens (MTP lag + confirmation time).
        const needed = minConfirmations * ONCHAIN_SECONDS_PER_BLOCK + ONCHAIN_CLAIM_MARGIN_SECONDS;
        if (htlcLocktime - input.now <= needed) {
            fail("claim_window_too_short", "L1 HTLC locktime leaves no safe claim window");
        }
        if (direction === "send") {
            // The solver claims Arkade with P AFTER the user's L1 claim; the
            // user's Arkade refund must therefore open LAST, with reorg margin.
            if (
                input.quote.refund_locktime === undefined ||
                htlcLocktime + ONCHAIN_ORDER_MARGIN_SECONDS > input.quote.refund_locktime
            ) {
                fail(
                    "timelock_order",
                    "L1 HTLC locktime + margin must fall before the Arkade refund locktime",
                );
            }
        }
    }
};

// ── Transports ───────────────────────────────────────────────────────────────

export interface RfqTransport {
    requestQuote(payload: Record<string, unknown>): Promise<RfqQuote>;
    status(rfqId: string): Promise<RfqStatus | null>;
    close(): Promise<void>;
}

/**
 * Discriminate a solver reply: a refusal is thrown as {@link SwapRefusal}; anything not a quote for
 * THIS negotiation is an error. The `rfq_id` check matters because on a shared relay all the
 * solver's events arrive on one subscription.
 *
 * `pair` is compared byte for byte, binding every solver to the exact spellings this module builds.
 * `requestedPair` is optional because a payload with no `pair` has no pair to be wrong; comparing
 * `String(undefined)` would refuse every quote. Shared with `nostr.ts`; not re-exported from
 * `index.ts`.
 */
export const expectQuote = (payload: unknown, rfqId: string, requestedPair?: string): RfqQuote => {
    const p = payload as {
        type?: string;
        reason?: string;
        rfq_id?: string;
        pair?: unknown;
        error_code?: unknown;
        field?: unknown;
        actual?: unknown;
        expected?: unknown;
        limit?: unknown;
        unit?: unknown;
    } | null;
    if (p?.type === "rfq_refusal") {
        throw new SwapRefusal(p.reason ?? "unknown", p.rfq_id ?? rfqId, {
            errorCode: p.error_code as RfqRefusalErrorCode,
            field: p.field as string,
            actual: p.actual as number,
            expected: p.expected as number,
            limit: p.limit as number,
            unit: p.unit as RfqRefusalUnit,
        });
    }
    if (p?.type !== "rfq_quote" || p.rfq_id !== rfqId) {
        throw new Error(`unexpected reply: ${p?.type ?? "no payload"}`);
    }
    if (requestedPair !== undefined && p.pair !== requestedPair) {
        throw new Error(
            `solver quoted ${JSON.stringify(p.pair)}, not the requested ${requestedPair}`,
        );
    }
    return payload as RfqQuote;
};

/** The pair of a request we built, when it named one. */
export const pairOf = (payload: Record<string, unknown>): string | undefined =>
    typeof payload.pair === "string" ? payload.pair : undefined;

/** HTTP: POST /v1/swap for quotes, GET /v1/rfq/<rfq_id> for status.
 * `fetchImpl` is injectable for tests and non-global-fetch runtimes. */
export const httpTransport = (
    baseUrl: string,
    options: { fetchImpl?: typeof fetch } = {},
): RfqTransport => {
    const fetchImpl = options.fetchImpl ?? fetch;
    /**
     * A refusal is a 4xx with an `rfq_refusal` body, so non-2xx is still read. A non-JSON body (a
     * proxy 502 page) is reported with its status rather than as a bare `SyntaxError`.
     */
    const readJson = async (response: Response, what: string): Promise<unknown> => {
        const body = await response.text();
        try {
            return JSON.parse(body) as unknown;
        } catch {
            throw new Error(
                `${what} returned HTTP ${response.status} with a non-JSON body: ${body.slice(0, 200)}`,
            );
        }
    };
    return {
        async requestQuote(payload) {
            const response = await fetchImpl(`${baseUrl}/v1/swap`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
            });
            return expectQuote(
                await readJson(response, "quote request"),
                String(payload.rfq_id),
                pairOf(payload),
            );
        },
        async status(rfqId) {
            const response = await fetchImpl(`${baseUrl}/v1/rfq/${rfqId}`, { method: "GET" });
            if (response.status === 404) return null;
            const payload = (await readJson(response, "status request")) as {
                type?: string;
            } | null;
            return payload?.type === "rfq_status" ? (payload as RfqStatus) : null;
        },
        async close() {},
    };
};

/** Minimal WebSocket surface the relay transport needs — satisfied by the DOM
 * WebSocket and by `ws` alike, so neither becomes a dependency. */
export interface RelaySocket {
    send(data: string): void;
    close(): void;
    addEventListener(type: "open" | "message" | "error", listener: (event: any) => void): void;
}

/** Relay: both parties outbound, addressed by x-only pubkey, speaking the dev
 * broker framing. Nostr (directed kind + NIP-44) replaces only this function.
 * One socket; replies correlated by rfq_id. */
export const relayTransport = (
    relayUrl: string,
    options: {
        solverPubkey: string;
        clientPubkey: string;
        WebSocketCtor?: new (url: string) => RelaySocket;
        timeoutMs?: number;
    },
): RfqTransport => {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const Ctor =
        options.WebSocketCtor ?? (WebSocket as unknown as new (url: string) => RelaySocket);
    const pending = new Map<string, (payload: unknown) => void>();
    let sequence = 0;

    const socketReady = new Promise<RelaySocket>((resolve, reject) => {
        const ws = new Ctor(relayUrl);
        ws.addEventListener("open", () => {
            ws.send(
                JSON.stringify({
                    op: "sub",
                    id: "s1",
                    filter: { recipient: options.clientPubkey },
                }),
            );
            resolve(ws);
        });
        ws.addEventListener("error", () => reject(new Error("relay connection failed")));
        ws.addEventListener("message", (event: { data: unknown }) => {
            let frame: { op?: string; event?: { payload?: { rfq_id?: string } } };
            try {
                frame = JSON.parse(String(event.data));
            } catch {
                return;
            }
            if (frame.op !== "event") return;
            const payload = frame.event?.payload;
            const rfqId = payload?.rfq_id;
            const settle = rfqId !== undefined ? pending.get(rfqId) : undefined;
            if (settle && rfqId !== undefined) {
                pending.delete(rfqId);
                settle(payload);
            }
        });
    });

    const roundTrip = async (payload: Record<string, unknown>, rfqId: string): Promise<unknown> => {
        const ws = await socketReady;
        const reply = new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(rfqId);
                reject(new Error(`no reply within ${timeoutMs}ms`));
            }, timeoutMs);
            pending.set(rfqId, (p) => {
                clearTimeout(timer);
                resolve(p);
            });
        });
        ws.send(
            JSON.stringify({
                op: "event",
                event: {
                    id: `${options.clientPubkey}:${(sequence += 1)}`,
                    author: options.clientPubkey,
                    recipient: options.solverPubkey,
                    createdAtMs: Date.now(),
                    payload,
                },
            }),
        );
        return reply;
    };

    return {
        async requestQuote(payload) {
            return expectQuote(
                await roundTrip(payload, String(payload.rfq_id)),
                String(payload.rfq_id),
                pairOf(payload),
            );
        },
        async status(rfqId) {
            const payload = (await roundTrip(
                { v: 1, type: "rfq_status_request", rfq_id: rfqId },
                rfqId,
            )) as { type?: string } | null;
            return payload?.type === "rfq_status" ? (payload as RfqStatus) : null;
        },
        async close() {
            try {
                (await socketReady).close();
            } catch {
                // socket never opened; nothing to close
            }
        },
    };
};

// ── Lightning send: derivation + the user flow ──────────────────────────────

/** BIP68 sequence granularity; the delay derivation rounds up to it. */
const SEQUENCE_GRANULARITY_SECONDS = 512;

/**
 * How long the sender's SOLO refund opens after the receiver's claim, seconds.
 *
 * The window a preimage-holding claimant has to finish before the funder can take the money back;
 * sized (reasoned, not measured) for the worst case, a full unilateral exit with the server gone.
 * Mirrors `SOLO_REFUND_HEADROOM_SECONDS` in the reference solver's `src/core/timelocks.ts`: the
 * two must move together or a trader derives an address the solver never quoted. A multiple of
 * the BIP68 granularity so the encoded timelock equals this number.
 */
export const SOLO_REFUND_HEADROOM_SECONDS = 8 * SEQUENCE_GRANULARITY_SECONDS;

/** The solver's unilateral-claim delay, derived from the Arkade operator's reported
 * exit delay exactly as the reference solver derives it — both sides read the
 * SAME server, so the derivation (not a quote field) is what keeps the two
 * scripts identical. */
export const unilateralClaimDelay = (operatorExitDelaySeconds: number): number => {
    if (
        !Number.isFinite(operatorExitDelaySeconds) ||
        operatorExitDelaySeconds < SEQUENCE_GRANULARITY_SECONDS
    ) {
        throw new Error(
            `operator exit delay must be at least ${SEQUENCE_GRANULARITY_SECONDS}s of seconds, got ${operatorExitDelaySeconds}`,
        );
    }
    // the headroom below BIP68's ceiling, not at it: the solo refund stacks
    // SOLO_REFUND_HEADROOM_SECONDS on top of this value, and it must encode too
    if (
        operatorExitDelaySeconds >
        0xffff * SEQUENCE_GRANULARITY_SECONDS - SOLO_REFUND_HEADROOM_SECONDS
    ) {
        throw new Error(
            `operator exit delay ${operatorExitDelaySeconds}s exceeds what BIP68 can encode ` +
                `once the solo refund's headroom is stacked above it`,
        );
    }
    return (
        Math.ceil(operatorExitDelaySeconds / SEQUENCE_GRANULARITY_SECONDS) *
        SEQUENCE_GRANULARITY_SECONDS
    );
};

/** VHTLC's `unilateralRefund` tier: sender + receiver, no server — LEVEL with
 * `claimDelay`, not above it. Neither party can spend a two-signature leaf
 * alone, so separating it buys no safety and would only eat into the headroom that matters. */
export const unilateralRefundDelay = (claimDelay: number): number => claimDelay;

/** VHTLC's `unilateralRefundWithoutReceiver` tier: sender alone, needing
 * nobody. The only leaf whose timing can steal — a funder able to refund
 * before the claimant can claim takes money from someone holding the preimage
 * — so it opens last, by {@link SOLO_REFUND_HEADROOM_SECONDS}. */
export const unilateralRefundWithoutReceiverDelay = (claimDelay: number): number =>
    claimDelay + SOLO_REFUND_HEADROOM_SECONDS;

const seconds = (value: number): { type: "seconds"; value: bigint } => ({
    type: "seconds",
    value: BigInt(value),
});

/** The VHTLC both directions compile; only `roles` differ between them. */
const suiteVhtlc = (
    params: {
        operatorPubkey: Uint8Array;
        paymentHash: string;
        refundLocktime: number;
        claimDelay: number;
        emulatorPubkey: Uint8Array;
        legacy?: "preTimelockedRefund";
    },
    roles: {
        sender: Uint8Array;
        receiver: Uint8Array;
        senderPkScript: Uint8Array;
        receiverPkScript: Uint8Array;
        refundWithoutReceiverDelay?: number;
    },
): InstanceType<typeof VHTLC.ScriptV2> =>
    new VHTLC.ScriptV2({
        sender: roles.sender,
        receiver: roles.receiver,
        server: params.operatorPubkey,
        preimageHash: ripemd160(hex.decode(params.paymentHash)),
        refundLocktime: BigInt(params.refundLocktime),
        unilateralClaimDelay: seconds(params.claimDelay),
        unilateralRefundDelay: seconds(unilateralRefundDelay(params.claimDelay)),
        unilateralRefundWithoutReceiverDelay: seconds(
            roles.refundWithoutReceiverDelay ??
                unilateralRefundWithoutReceiverDelay(params.claimDelay),
        ),
        nonInteractiveParameters: {
            receiverPkScript: roles.receiverPkScript,
            senderPkScript: roles.senderPkScript,
            emulatorPubkey: params.emulatorPubkey,
            ...(params.legacy !== undefined && { legacy: params.legacy }),
        },
    });

/** Compile the lightning-send VHTLC from the quote's binding fields plus the
 * trader's own data. `paymentHash` is the BOLT11 payment hash (`sha256(P)`,
 * hex); the script's HASH160 commitment is derived from it here, which is why
 * the trader never needs to see `P`.
 *
 * Nine leaves unless `legacy`: VHTLC's six plus the emulator-covenant suite —
 * `nonInteractiveClaim` (server + emulator, pays the solver's `receiverPkScript`),
 * `nonInteractiveRefund` (server + solver + emulator, pays the trader's `refundPkScript`, no
 * timelock or trader signature; see {@link VHTLC.Options.nonInteractiveParameters}), and
 * `nonInteractiveRefundWithoutReceiver` (server + emulator after `refundLocktime`).
 */
export function lightningSendContract(params: {
    /** Binding field #1: the solver's x-only key, from the quote. */
    solverPubkey: Uint8Array;
    /** Binding field #2: when the trader's refund path opens, from the quote. */
    refundLocktime: number;
    /** The Arkade operator's x-only key — the trader's OWN connection. */
    operatorPubkey: Uint8Array;
    /** BOLT11 payment hash, hex — from the trader's OWN invoice decode. */
    paymentHash: string;
    /** From {@link unilateralClaimDelay} over the trader's OWN server info; all three unilateral
     * tiers derive from it. */
    claimDelay: number;
    /** Binding quote field. Optional only for rebuilding pre-upgrade scripts. */
    refundWithoutReceiverDelay?: number;
    /** Emulator x-only key (32 bytes). */
    emulatorPubkey: Uint8Array;
    /** Where a refund must pay: the trader's P2TR pkScript (34 bytes). Also
     * the refund covenants' destination. */
    refundPkScript: Uint8Array;
    /** The trader's own key — VHTLC's `sender` role, on every interactive refund-side leaf. */
    senderPubkey: Uint8Array;
    /** The solver's claim destination (`profile.receiver_pk_script`, P2TR), used only to derive
     * `nonInteractiveClaim`'s covenant key; not otherwise trusted. */
    receiverPkScript: Uint8Array;
    /** LEGACY REBUILD ONLY: re-derive a lockup funded before the timelocked refund leaf shipped
     * (see {@link VHTLC.Options.nonInteractiveParameters}); set by {@link matchQuotedLockup}. */
    legacy?: "preTimelockedRefund";
}): InstanceType<typeof VHTLC.ScriptV2> {
    return suiteVhtlc(params, {
        sender: params.senderPubkey,
        receiver: params.solverPubkey,
        senderPkScript: params.refundPkScript,
        receiverPkScript: params.receiverPkScript,
        refundWithoutReceiverDelay: params.refundWithoutReceiverDelay,
    });
}

/** Every input {@link lightningSendContract} builds from. */
export type LightningSendContractParams = Parameters<typeof lightningSendContract>[0];

/** The BOLT11 facts the trader read from its OWN decode — this module takes
 * the facts, not the decoder, so any wallet's existing decoder serves
 * (`CorridorOverrides.lightning.decode` returns it). */
export interface InvoiceFacts {
    /** The raw BOLT11 — what travels in the request profile. */
    raw: string;
    /** `sha256(P)`, LOWERCASE hex (64 chars) — {@link verifyReceiveInvoice}
     * compares it byte-for-byte against `paymentHashOf`, which emits lowercase. */
    paymentHash: string;
    amountSats: number;
    /** Absolute expiry, unix seconds. */
    expiresAt: number;
}

/**
 * The pure core of {@link requestLightningSend}: derive the Arkade lockup from
 * the quote's binding fields plus the trader's own data, and refuse on a
 * mismatch. Binding: `solver_pubkey`, `refund_locktime`,
 * `profile.receiver_pk_script`; `profile.lockup_address` is compare-only.
 *
 * Pure, like its siblings, so the v2 quote path (which registers nothing until `accept()`) shares
 * this one derivation instead of copying it.
 */
export function deriveLightningSend(input: {
    quote: RfqQuote;
    /** BOLT11 payment hash, hex — from the trader's OWN invoice decode. */
    paymentHash: string;
    /** The trader's own key for the VHTLC's sender-side leaves. */
    senderPubkey: Uint8Array;
    /** Where a refund must pay: the trader's P2TR pkScript. */
    refundPkScript: Uint8Array;
    operatorPubkey: Uint8Array;
    emulatorPubkey: Uint8Array;
    claimDelay: number;
    hrp: string;
    /** Unix seconds used to prove the negotiated CSV covers the absolute refund. */
    now: number;
}): {
    /** The trader's OWN derivation — the only address to fund. */
    address: string;
    swapPkScript: Uint8Array;
    script: InstanceType<typeof VHTLC.ScriptV2>;
    contractParams: LightningSendContractParams;
    /** The deadline the covenant was built with. */
    refundLocktime: number;
} {
    const { quote } = input;
    if (quote.refund_locktime === undefined) {
        throw new Error("lightning-send quote is missing refund_locktime");
    }
    const refundWithoutReceiverDelay = quote.profile?.refund_without_receiver_delay;
    if (refundWithoutReceiverDelay === undefined) {
        throw new Error("lightning-send quote is missing profile.refund_without_receiver_delay");
    }
    if (
        !Number.isSafeInteger(refundWithoutReceiverDelay) ||
        refundWithoutReceiverDelay < input.claimDelay ||
        refundWithoutReceiverDelay % SEQUENCE_GRANULARITY_SECONDS !== 0 ||
        refundWithoutReceiverDelay > 0xffff * SEQUENCE_GRANULARITY_SECONDS
    ) {
        throw new Error("lightning-send quote carries an invalid refund_without_receiver_delay");
    }
    if (refundWithoutReceiverDelay < quote.refund_locktime - input.now) {
        throw new Error("lightning-send quote lets the solo refund open before refund_locktime");
    }
    const receiverPkScriptHex = quote.profile?.receiver_pk_script as string | undefined;
    if (receiverPkScriptHex === undefined) {
        throw new Error("lightning-send quote is missing profile.receiver_pk_script");
    }
    const contractParams = {
        solverPubkey: toXOnly(hex.decode(quote.solver_pubkey), "solver key"),
        refundLocktime: quote.refund_locktime,
        operatorPubkey: input.operatorPubkey,
        paymentHash: input.paymentHash,
        claimDelay: input.claimDelay,
        refundWithoutReceiverDelay,
        emulatorPubkey: input.emulatorPubkey,
        senderPubkey: input.senderPubkey,
        receiverPkScript: solverHex(receiverPkScriptHex, "profile.receiver_pk_script"),
        refundPkScript: input.refundPkScript,
    };
    // `contractParams` echoes the MATCHED build: downstream re-derives from it.
    const matched = matchQuotedLockup(quote, input.hrp, input.operatorPubkey, (legacy) =>
        lightningSendContract({ ...contractParams, ...(legacy !== undefined && { legacy }) }),
    );
    return {
        address: matched.address,
        swapPkScript: matched.script.pkScript,
        script: matched.script,
        contractParams: {
            ...contractParams,
            ...(matched.legacy !== undefined && { legacy: matched.legacy }),
        },
        refundLocktime: quote.refund_locktime,
    };
}

/**
 * The lightning-send user flow: quote → derive locally → verify → gate. Funds nothing: the caller
 * funds `address` with `fundAmount` before `quote.valid_until`, then may go OFFLINE. Success
 * reveals the preimage in the solver's claim witness; failure refunds to `refundAddress`.
 *
 * @throws {SwapRefusal} (closed reason), {@link AddressMismatch} (never fund), a gate error with a
 * stable `reason`, or {@link LockupRegistrationFailed} — only the last leaves the quote good for a
 * retry once local storage is.
 *
 * @remarks Registers the lockup with the contract manager before returning the address, so it is
 * watched (and out of coin selection) from the moment it lands, and a persistence failure throws
 * while nothing is funded. Persist `secrets` (a public descriptor) with the record: it is how the
 * refund signer is found again; without it `nonInteractiveRefund` still works but needs the
 * SOLVER's active cooperation.
 */
export async function requestLightningSend(
    wallet: IWallet,
    transport: RfqTransport,
    params: {
        invoice: InvoiceFacts;
        rfqId?: string;
        /** Co-signer key override (33-byte compressed hex); see
         * {@link resolveEmulatorPubkey}. */
        emulatorPubkey?: string;
    },
): Promise<{
    rfqId: string;
    quote: RfqQuote;
    /** The trader's OWN derivation — the only address to fund. */
    address: string;
    /** What the lockup must carry: the quote's `from_amount` (the invoice
     * amount plus the corridor's fee), in sats. */
    fundAmount: number;
    /** The covenant's scriptPubKey, for watching the lockup and its spend. */
    swapPkScript: Uint8Array;
    /** The covenant itself. Hand it to `RfqSwapManager` as the record's `lockup` (with
     * `address`); without it the manager can only poll and cannot retire the row. */
    script: InstanceType<typeof VHTLC.ScriptV2>;
    /** Where a failed swap refunds; the address `secrets.pkScript` was decoded from. */
    refundAddress: string;
    /** The VHTLC `sender` x-only key, bound into the covenant. Public. */
    senderPubkey: Uint8Array;
    /** How the `sender` key is recovered later. Persist it with the record;
     * it holds nothing secret. */
    secrets: ProvisionedKey;
    /**
     * Every input the covenant was built from, as it was AT REQUEST TIME (half are not on the
     * quote). All public, and optional to persist: `rebuildRfqSwap` reads the registered contract
     * row. To rebuild without that store, keep
     * `VHTLCV2ContractHandler.serializeParams(script.options)` instead.
     */
    contractParams: LightningSendContractParams;
}> {
    const rfqId = params.rfqId ?? newRfqId();
    // No preimage: a lightning send's P belongs to the payee.
    const secrets = await provisionRefundKey(wallet);
    const senderPubkey = secrets.pubkey;
    // One address read for both refund_address and refundPkScript, so a rotating receive address
    // cannot pair them with different scripts.
    const refundAddress = secrets.address;
    const info = await wallet.getArkadeInfo({ requireLive: true });

    const quote = await transport.requestQuote(
        lightningSendRequest({ rfqId, invoice: params.invoice.raw, refundAddress, senderPubkey }),
    );
    const now = Math.floor(Date.now() / 1000);
    const claimDelay = unilateralClaimDelay(Number(info.unilateralExitDelay));
    // Exact-out: `to_amount` must be the invoice verbatim; `from_amount` adds the fee.
    if (quoteSats(quote.to_amount, "to_amount") !== params.invoice.amountSats) {
        throw new Error(
            `quote to_amount ${quote.to_amount} does not match the invoice's ${params.invoice.amountSats}`,
        );
    }
    if (quoteSats(quote.from_amount, "from_amount") < quoteSats(quote.to_amount, "to_amount")) {
        throw new Error(
            `quote from_amount ${quote.from_amount} is below the invoice amount — a negative spread is not a quote`,
        );
    }

    const operatorPubkey = toXOnly(hex.decode(info.signerPubkey), "ark signer key");
    const network = networkFromArkadeInfo(info);
    const derived = deriveLightningSend({
        quote,
        paymentHash: params.invoice.paymentHash,
        senderPubkey,
        refundPkScript: secrets.pkScript,
        operatorPubkey,
        emulatorPubkey: toXOnly(
            hex.decode(resolveEmulatorPubkey(network, params.emulatorPubkey)),
            "emulator signer key",
        ),
        claimDelay,
        hrp: network.hrp,
        now,
    });
    const { address, script, contractParams } = derived;
    assertFundable({
        quote,
        invoiceExpiresAt: params.invoice.expiresAt,
        now,
    });

    // Last, so a refused quote leaves no row, but before the caller holds an address to fund.
    await registerLockupContract(await wallet.getContractManager(), script, address);

    return {
        rfqId,
        quote,
        address,
        fundAmount: quoteSats(quote.from_amount, "from_amount"),
        swapPkScript: derived.swapPkScript,
        script,
        refundAddress,
        senderPubkey,
        secrets,
        contractParams,
    };
}

// ── Arkade ↔ arkade: quote, then take by funding an offer ───────────────────

/**
 * Map an arkade↔arkade quote onto `createOffer` terms. The covenant only releases the deposit to a
 * tx delivering the quoted want-amount, so the solver fills or nothing moves; an unfilled offer is
 * cancelled cooperatively (`cancelOffer`).
 *
 * For asset-to-asset, the covenant commits to the wanted asset only; the offered asset rides the
 * funding VTXO's asset packet.
 */
export const offerTermsFromQuote = (
    quote: RfqQuote,
    assets: { wantAsset?: asset.AssetId; offerAsset?: asset.AssetId },
): { wantAmount: bigint; wantAsset?: asset.AssetId; offerAsset?: asset.AssetId } => {
    if (!assets.wantAsset && !assets.offerAsset) {
        throw new Error("set at least one of wantAsset or offerAsset");
    }
    const wantAmount = BigInt(quote.to_amount);
    if (assets.wantAsset) return { wantAmount, wantAsset: assets.wantAsset };
    return { wantAmount, offerAsset: assets.offerAsset };
};

/** Compare-only check of the solver's offer address AND script against YOUR OWN derivation.
 * Throws {@link AddressMismatch} unless both match exactly.
 *
 * @deprecated Internal to `client.quote()` and `client.accept()`. Moved off the package root to `@arkade-os/swap/protocol`. */
export const verifyOfferAddress = (
    quote: RfqQuote,
    derived: { address: string; swapPkScript: Uint8Array },
): { address: string; swapPkScript: Uint8Array } => {
    const quotedAddress = quote.profile?.offer_address as string | undefined;
    const quotedScript = quote.profile?.offer_pk_script as string | undefined;
    const derivedScript = hex.encode(derived.swapPkScript);
    if (quotedAddress !== derived.address || quotedScript !== derivedScript) {
        throw new AddressMismatch([derived.address], quotedAddress);
    }
    return derived;
};

/** Gate an arkade↔arkade quote immediately before funding. The only clock is `valid_until`:
 * funding after it leaves a deposit the solver won't fill, reclaimable only via `cancelOffer`.
 *
 * @deprecated Internal to `client.quote()` and `client.accept()`. Moved off the package root to `@arkade-os/swap/protocol`. */
export const assertArkadeFundable = (input: { quote: RfqQuote; now?: number }): void => {
    const now = input.now ?? Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(input.quote.valid_until)) {
        throw gateError("quote_expired", "quote carries no valid_until");
    }
    if (now >= input.quote.valid_until) {
        throw gateError("quote_expired", `quote lapsed at ${input.quote.valid_until} (now ${now})`);
    }
    if (BigInt(input.quote.from_amount) <= 0n || BigInt(input.quote.to_amount) <= 0n) {
        throw gateError("quote_expired", "quote carries a non-positive amount");
    }
};

/** Falls back on absent AND non-positive: zero would fund an asset with no carrier. */
export const quoteCarrierSats = (quote: RfqQuote): bigint => {
    const published = quote.carrier_sats === undefined ? 0n : BigInt(quote.carrier_sats);
    return published > 0n ? published : ASSET_CARRIER_SATS;
};

/**
 * The arkade↔arkade user flow: quote → derive locally → verify → gate. Funds nothing; the caller
 * funds before `quote.valid_until`, then may go offline. No timelock refund: an unfilled offer is
 * cancelled cooperatively (`cancelOffer`).
 *
 * Maker keys are read once here so the request profile and the local `createOffer` derivation
 * cannot diverge. Throws {@link SwapRefusal}, {@link AddressMismatch} (never fund), or a gate error
 * with a stable `reason`.
 *
 * `client.exchange()` now covers this route end to end — it opens the card's
 * Nostr rendezvous, sends this same request, runs the full verification set,
 * and registers, persists and funds in one step — so there is nothing left here
 * that it does not do. What it additionally refuses is a transport that cannot
 * say who answered, which this function, taking one from its caller, cannot.
 *
 * Funding (caller's job, immediately after, before `valid_until`):
 * - BTC->asset (`wantAsset`): `wallet.send({ address, amount: Number(fundAmount), extensions: [extension] })`
 * - asset->BTC or asset->asset (`offerAsset`): `wallet.send({ address, amount: Number(carrierSats), assets: [{ assetId: offerAsset, amount: fundAmount }], extensions: [extension] })`
 *
 * @deprecated Use `client.exchange()`. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export async function requestArkadeSwap(
    wallet: IWallet,
    transport: RfqTransport,
    params: {
        /** Asset the trader deposits; omit when depositing BTC. */
        offerAsset?: asset.AssetId;
        /** Asset the trader wants; omit when wanting BTC. */
        wantAsset?: asset.AssetId;
        /** Atomic units of whichever leg `amountSide` names. */
        amount: bigint | number | string;
        amountSide?: "from" | "to";
        /** Bounds the side the SOLVER chose — the named side is echoed back verbatim,
         * so asserting it proves nothing and an unbounded caller funds what it is asked. */
        maxFromAmount?: bigint | number | string;
        minToAmount?: bigint | number | string;
        rfqId?: string;
        /** Co-signer key override (33-byte compressed hex); see `createOffer`. */
        emulatorPubkey?: string;
        now?: number;
    },
): Promise<{
    rfqId: string;
    quote: RfqQuote;
    pair: string;
    /** The trader's OWN derivation — the only address to fund. */
    address: string;
    /** What the deposit must carry: the quote's `from_amount`. Sats for a BTC
     * deposit, asset units for an asset deposit (plus a dust carrier). */
    fundAmount: bigint;
    /** Dust sats to attach to an asset deposit; 0n for a BTC deposit. */
    carrierSats: bigint;
    /** The covenant's scriptPubKey, for watching the deposit and its spend. */
    swapPkScript: Uint8Array;
    /** The encoded offer. Persist this — it is the only input `cancelOffer`
     * needs, and the restore scan reads it back off the funding tx. */
    offerHex: string;
    /** Ready for `wallet.send`'s `extensions`. */
    extension: { type: number; payload: Uint8Array };
}> {
    if (!params.wantAsset && !params.offerAsset) {
        throw new Error("set at least one of wantAsset or offerAsset; BTC-to-BTC is not a swap");
    }
    const rfqId = params.rfqId ?? newRfqId();
    const amountSide = params.amountSide ?? "from";
    const [makerAddress, makerPublicKey] = await Promise.all([
        wallet.getAddress(),
        wallet.identity.xOnlyPublicKey(),
    ]);
    const makerPkScript = ArkAddress.decode(makerAddress).pkScript;
    const pair = rfqPair(
        params.offerAsset ? arkadeAssetLeg(params.offerAsset) : ARKADE_BTC,
        params.wantAsset ? arkadeAssetLeg(params.wantAsset) : ARKADE_BTC,
    );
    const quote = await transport.requestQuote(
        arkadeSwapRequest({
            rfqId,
            ...(params.offerAsset !== undefined ? { offerAsset: params.offerAsset } : {}),
            ...(params.wantAsset !== undefined ? { wantAsset: params.wantAsset } : {}),
            amount: params.amount,
            amountSide,
            makerPkScript,
            makerPublicKey,
        }),
    );
    if (quote.pair !== pair) {
        throw new Error(`solver quoted ${JSON.stringify(quote.pair)}, not the requested ${pair}`);
    }
    assertArkadeFundable({ quote, ...(params.now !== undefined ? { now: params.now } : {}) });
    const terms = offerTermsFromQuote(quote, {
        ...(params.offerAsset !== undefined ? { offerAsset: params.offerAsset } : {}),
        ...(params.wantAsset !== undefined ? { wantAsset: params.wantAsset } : {}),
    });
    const quoted = amountSide === "from" ? quote.from_amount : quote.to_amount;
    if (BigInt(quoted).toString() !== canonicalAssetAmount(params.amount)) {
        throw new Error(
            `quote ${amountSide}_amount ${quoted} does not match the requested ${canonicalAssetAmount(params.amount)}`,
        );
    }
    if (params.maxFromAmount !== undefined) {
        const cap = BigInt(canonicalAssetAmount(params.maxFromAmount));
        if (BigInt(quote.from_amount) > cap) {
            throw gateError(
                "quote_amount_rejected",
                `quote from_amount ${quote.from_amount} exceeds maxFromAmount ${cap}`,
            );
        }
    }
    if (params.minToAmount !== undefined) {
        const floorAmount = BigInt(canonicalAssetAmount(params.minToAmount));
        if (BigInt(quote.to_amount) < floorAmount) {
            throw gateError(
                "quote_amount_rejected",
                `quote to_amount ${quote.to_amount} is under minToAmount ${floorAmount}`,
            );
        }
    }
    const offer = await createOffer(wallet, {
        wantAmount: terms.wantAmount,
        ...(terms.wantAsset !== undefined ? { wantAsset: terms.wantAsset } : {}),
        ...(terms.offerAsset !== undefined ? { offerAsset: terms.offerAsset } : {}),
        ...(params.emulatorPubkey !== undefined ? { emulatorPubkey: params.emulatorPubkey } : {}),
    });
    verifyOfferAddress(quote, offer);
    const fundAmount = BigInt(quote.from_amount);
    return {
        rfqId,
        quote,
        pair,
        address: offer.address,
        fundAmount,
        carrierSats: params.offerAsset !== undefined ? quoteCarrierSats(quote) : 0n,
        swapPkScript: offer.swapPkScript,
        offerHex: offer.offerHex,
        extension: offer.extension,
    };
}

// ── Onchain corridor: off-board (arkade->onchain) and on-board wire ─────────

/** The onchain send's Arkade lockup is the SAME {@link lightningSendContract}; only the payment
 * hash's source differs (user-generated P, not a BOLT11). */

/**
 * The L1 network an Arkade network settles on.
 *
 * Three-valued where {@link NetworkName} is five: `signet` and `mutinynet` carry testnet address
 * parameters, so they fold into `testnet`.
 */
export const l1NetworkFromArk = (network: string): OnchainNetwork =>
    network === "bitcoin" ? "bitcoin" : network === "regtest" ? "regtest" : "testnet";

/** The covenant terms the trader's OWN live server info supplies. */
const serverTerms = (info: ArkadeInfo, emulatorPubkey: string | undefined) => {
    const network = networkFromArkadeInfo(info);
    return {
        operatorPubkey: toXOnly(hex.decode(info.signerPubkey), "ark signer key"),
        emulatorPubkey: toXOnly(
            hex.decode(resolveEmulatorPubkey(network, emulatorPubkey)),
            "emulator signer key",
        ),
        claimDelay: unilateralClaimDelay(Number(info.unilateralExitDelay)),
        hrp: network.hrp,
    };
};

/** The rfq_request for `arkade:BTC->onchain:BTC`. Exact-out means "this much
 * lands in the L1 HTLC". `senderPubkey` is the user's own key for the
 * VHTLC's sender-side leaves — same role as in {@link lightningSendRequest}.
 * On the wire it's `client_refund_pubkey`, same as there. */
export const onchainSendRequest = (input: {
    rfqId: string;
    /** `sha256(P)`, hex — user-chosen; see {@link paymentHashOf}. */
    paymentHash: string;
    /** User's x-only L1 key for the HTLC's claim leaf. */
    payoutPubkey: Uint8Array;
    /** User's arkade address — where the covenant refund must pay. */
    refundAddress: string;
    senderPubkey: Uint8Array;
    amount: number;
    amountSide: "from" | "to";
}): Record<string, unknown> => ({
    v: 1,
    type: "rfq_request",
    rfq_id: input.rfqId,
    pair: ONCHAIN_SEND_PAIR,
    amount_side: input.amountSide,
    amount: input.amount,
    profile: {
        payment_hash: input.paymentHash,
        payout_pubkey: hex.encode(input.payoutPubkey),
        refund_address: input.refundAddress,
        client_refund_pubkey: hex.encode(input.senderPubkey),
    },
});

/** The rfq_request for `lightning:BTC->arkade:BTC`. The trader sends only `H` plus `P` sealed to
 * covclaimd, so the solver never sees `P` before a claim witness. `payoutPubkey` is the covenant's
 * `receiver`, so the trader can claim without covclaimd. */
export const lightningReceiveRequest = (input: {
    rfqId: string;
    /** `H = sha256(P)`, hex — trader-chosen; see {@link paymentHashOf}. */
    paymentHash: string;
    /** Trader's arkade address — where the swapped sats land. */
    payoutAddress: string;
    /** Trader's x-only arkade key — the covenant's `receiver` role. */
    payoutPubkey: Uint8Array;
    /** `P` sealed to covclaimd, base64 — `sealClaimPacket(...).ciphertext`. Omitted from the wire
     * when there is no covclaimd: the solver refuses an empty packet. */
    claimPacket?: string;
    amount: number;
    amountSide: "from" | "to";
}): Record<string, unknown> => ({
    v: 1,
    type: "rfq_request",
    rfq_id: input.rfqId,
    pair: LIGHTNING_RECEIVE_PAIR,
    amount_side: input.amountSide,
    amount: input.amount,
    profile: {
        payment_hash: input.paymentHash,
        payout_address: input.payoutAddress,
        payout_pubkey: hex.encode(input.payoutPubkey),
        ...(input.claimPacket === undefined ? {} : { claim_packet: input.claimPacket }),
    },
});

/** The rfq_request for `onchain:BTC->arkade:BTC`. The user funds the L1 HTLC (holding its refund
 * role); P travels sealed to covclaimd so the user can go offline after funding. */
export const onchainReceiveRequest = (input: {
    rfqId: string;
    paymentHash: string;
    /** Trader's arkade address — where the swapped sats land. */
    payoutAddress: string;
    /** Trader's x-only arkade key — the covenant's `receiver` role. */
    payoutPubkey: Uint8Array;
    /** Trader's x-only L1 key for the HTLC's refund leaf. */
    refundPubkey: Uint8Array;
    /** `P` sealed to covclaimd, base64. Omitted when there is none to seal to —
     * see {@link lightningReceiveRequest}. */
    claimPacket?: string;
    amount: number;
    amountSide: "from" | "to";
}): Record<string, unknown> => ({
    v: 1,
    type: "rfq_request",
    rfq_id: input.rfqId,
    pair: ONCHAIN_RECEIVE_PAIR,
    amount_side: input.amountSide,
    amount: input.amount,
    profile: {
        payment_hash: input.paymentHash,
        ...(input.claimPacket === undefined ? {} : { claim_packet: input.claimPacket }),
        refund_pubkey: hex.encode(input.refundPubkey),
        payout_address: input.payoutAddress,
        payout_pubkey: hex.encode(input.payoutPubkey),
    },
});

/**
 * The pure core of {@link requestOnchainSend}: derive BOTH contracts locally
 * from the quote's binding fields plus the user's own data, and refuse on any
 * mismatch. Binding: `solver_pubkey`, `refund_locktime`, `htlc_pubkey`,
 * `htlc_locktime`, `min_confirmations`; `lockup_address` and `htlc_address`
 * are compare-only.
 */
export function deriveOnchainSend(input: {
    quote: RfqQuote;
    paymentHash: string;
    payoutPubkey: Uint8Array;
    operatorPubkey: Uint8Array;
    emulatorPubkey: Uint8Array;
    claimDelay: number;
    hrp: string;
    l1Network: OnchainNetwork;
    refundAddress: string;
    /** The user's own key for the VHTLC's sender-side leaves — same role as
     * in {@link requestLightningSend}. */
    senderPubkey: Uint8Array;
}): {
    address: string;
    swapPkScript: Uint8Array;
    /** The lockup covenant itself — what the contract row is registered from,
     * so the row can never key on a script other than the derived one. */
    script: InstanceType<typeof VHTLC.ScriptV2>;
    htlc: OnchainHtlc;
    /** The inputs {@link htlc} was built from; nothing else gives them back (L1 has no contract
     * row, and `OnchainHtlc` exposes only derived values). */
    htlcParams: OnchainHtlcParams;
    /** Echoed from the input so the result fully describes the L1 half
     * ({@link onchainSendProfile} reads it). */
    l1Network: OnchainNetwork;
    refundLocktime: number;
    htlcLocktime: number;
    minConfirmations: number;
    expectedAmount: number;
} {
    const { quote } = input;
    const profile = quote.profile ?? {};
    const refundLocktime = quote.refund_locktime ?? (profile.refund_locktime as number | undefined);
    const htlcPubkey = profile.htlc_pubkey as string | undefined;
    const htlcLocktime = profile.htlc_locktime as number | undefined;
    const htlcAddress = profile.htlc_address as string | undefined;
    const minConfirmations = profile.min_confirmations as number | undefined;
    const receiverPkScriptHex = profile.receiver_pk_script as string | undefined;
    if (
        refundLocktime === undefined ||
        htlcPubkey === undefined ||
        htlcLocktime === undefined ||
        minConfirmations === undefined ||
        receiverPkScriptHex === undefined
    ) {
        throw new Error("onchain-send quote is missing a binding field");
    }

    const contractParams = {
        solverPubkey: toXOnly(hex.decode(quote.solver_pubkey), "solver key"),
        refundLocktime,
        operatorPubkey: input.operatorPubkey,
        paymentHash: input.paymentHash,
        claimDelay: input.claimDelay,
        emulatorPubkey: input.emulatorPubkey,
        senderPubkey: input.senderPubkey,
        receiverPkScript: solverHex(receiverPkScriptHex, "profile.receiver_pk_script"),
        refundPkScript: ArkAddress.decode(input.refundAddress).pkScript,
    };
    const { script, address } = matchQuotedLockup(
        quote,
        input.hrp,
        input.operatorPubkey,
        (legacy) =>
            lightningSendContract({ ...contractParams, ...(legacy !== undefined && { legacy }) }),
    );

    const htlcParams = {
        paymentHash: input.paymentHash,
        claimKey: input.payoutPubkey,
        refundKey: toXOnly(hex.decode(htlcPubkey), "solver L1 htlc key"),
        refundLocktime: htlcLocktime,
    };
    const htlc = onchainHtlcScript(htlcParams, input.l1Network);
    if (htlc.address !== htlcAddress) throw new AddressMismatch(htlc.address, htlcAddress);

    return {
        address,
        swapPkScript: script.pkScript,
        script,
        htlc,
        htlcParams,
        l1Network: input.l1Network,
        refundLocktime,
        htlcLocktime,
        minConfirmations,
        expectedAmount: quoteExpectedSats(quote.to_amount, "to_amount"),
    };
}

/**
 * The `arkade:BTC->onchain:BTC` user flow, mirroring `requestLightningSend`:
 * quote → derive BOTH contracts locally → verify → gate. Pure of funding —
 * the caller funds `address` with its own wallet before `quote.valid_until`.
 *
 * Registers the arkade lockup before returning, as {@link requestLightningSend} does (the L1 HTLC
 * has no contract row).
 *
 * Two obligations, both LOUD:
 * - **Persist `secrets` (with the record) BEFORE funding.** On a non-HD wallet it carries raw
 *   secrets; losing them forfeits the L1 claim and every interactive refund path.
 * - **Stay claim-capable.** The user must claim the L1 HTLC (`awaitOnchainFill` →
 *   `claimOnchainFill`) before `htlc.refundLocktime`, or the fill is forfeit and the swap falls
 *   back to the Arkade covenant refund.
 */
export async function requestOnchainSend(
    wallet: IWallet,
    transport: RfqTransport,
    params: {
        amount: number;
        amountSide: "from" | "to";
        /** User's x-only L1 key that will claim the HTLC. */
        payoutPubkey: Uint8Array;
        /** Optional caller-owned P. Persist it with the returned secrets before funding. */
        preimage?: Uint8Array;
        rfqId?: string;
        /** Co-signer key override (33-byte compressed hex); see
         * {@link resolveEmulatorPubkey}. */
        emulatorPubkey?: string;
    },
): Promise<{
    rfqId: string;
    quote: RfqQuote;
    /** The user's OWN arkade lockup derivation — the only address to fund. */
    address: string;
    fundAmount: number;
    /** What the solver's L1 fill must carry — persist it with the record. */
    expectedAmount: number;
    swapPkScript: Uint8Array;
    /** The arkade covenant itself — the record's `lockup` for
     * `RfqSwapManager`, same role as {@link requestLightningSend}'s. */
    script: InstanceType<typeof VHTLC.ScriptV2>;
    refundAddress: string;
    /** The EXPECTED L1 fill, derived locally — watch and claim against this. */
    htlc: OnchainHtlc;
    /** The inputs {@link htlc} was built from — persist these (with `htlc.address`) to rebuild it
     * after a restart; nothing else gives them back. Prefer `onchainSendProfile(result)` to
     * mapping them by hand. */
    htlcParams: OnchainHtlcParams;
    /** Which bitcoin network the L1 HTLC was derived for. NOT the ark network name: signet,
     * mutinynet and testnet4 all become `"testnet"`. */
    l1Network: OnchainNetwork;
    /** `profile.min_confirmations`; gates when the L1 fill becomes claimable,
     * and part of what a restored swap needs to drive its own claim. */
    minConfirmations: number;
    /** The arkade lockup's refund deadline, as the covenant was built with it. Read this, not
     * `quote.refund_locktime`: a solver may carry the value in `profile` instead. */
    refundLocktime: number;
    /** The VHTLC `sender` x-only key, bound into the covenant. Public. */
    senderPubkey: Uint8Array;
    /** How the preimage and the `sender` key are recovered later — map it
     * through `swapSecretsToRecord` and persist BEFORE funding. Public unless
     * `mustPersistPreimage` says the wallet could not derive P. */
    secrets: ProvisionedClaimSecret;
}> {
    const rfqId = params.rfqId ?? newRfqId();
    // Both halves: the lockup's refund key and the HTLC's P. A supplied P is length-checked first:
    // the L1 claim leaf pins OP_SIZE 32, so any other length funds an unclaimable HTLC.
    const secrets = await provisionClaimSecret(wallet, { preimage: params.preimage });
    if (secrets.mustPersistPreimage) {
        console.warn(
            "[swap] this swap's preimage cannot be re-derived from the seed and MUST be persisted with the record before funding",
        );
    }
    const paymentHash = hex.encode(secrets.paymentHash);
    const senderPubkey = secrets.pubkey;
    const [info, refundAddress] = await Promise.all([
        wallet.getArkadeInfo({ requireLive: true }),
        wallet.getAddress(),
    ]);

    const quote = await transport.requestQuote(
        onchainSendRequest({
            rfqId,
            paymentHash,
            payoutPubkey: params.payoutPubkey,
            refundAddress,
            senderPubkey,
            amount: params.amount,
            amountSide: params.amountSide,
        }),
    );
    // `fundAmount` below is `quote.from_amount` verbatim, so without this a
    // quote naming a different amount is funded at the solver's number.
    assertQuotedAmount(quote, params.amountSide, params.amount);

    const derived = deriveOnchainSend({
        quote,
        paymentHash,
        payoutPubkey: params.payoutPubkey,
        ...serverTerms(info, params.emulatorPubkey),
        l1Network: l1NetworkFromArk(info.network),
        refundAddress,
        senderPubkey,
    });
    assertFundable({
        quote,
        now: Math.floor(Date.now() / 1000),
        onchain: {
            htlcLocktime: derived.htlcLocktime,
            minConfirmations: derived.minConfirmations,
            direction: "send",
        },
    });

    await registerLockupContract(
        await wallet.getContractManager(),
        derived.script,
        derived.address,
    );

    return {
        rfqId,
        quote,
        address: derived.address,
        fundAmount: quoteSats(quote.from_amount, "from_amount"),
        expectedAmount: quoteSats(quote.to_amount, "to_amount"),
        swapPkScript: derived.swapPkScript,
        script: derived.script,
        refundAddress,
        htlc: derived.htlc,
        htlcParams: derived.htlcParams,
        l1Network: derived.l1Network,
        minConfirmations: derived.minConfirmations,
        refundLocktime: derived.refundLocktime,
        senderPubkey,
        secrets,
    };
}

/** The fixed side of the quote must equal the amount the request named; anything else is a quote
 * for a different trade. (`requestLightningSend` compares against the invoice instead.) */
const assertQuotedAmount = (quote: RfqQuote, amountSide: "from" | "to", amount: number): void => {
    const quoted =
        amountSide === "from"
            ? quoteSats(quote.from_amount, "from_amount")
            : quoteSats(quote.to_amount, "to_amount");
    if (quoted !== amount) {
        throw new Error(
            `quote ${amountSide === "from" ? "from_amount" : "to_amount"} ${quoted} ` +
                `does not match the requested ${amount} — not this trade's quote`,
        );
    }
    if (quote.to_amount > quote.from_amount) {
        throw new Error("quote pays out more than it takes in — not a quote to fund");
    }
};

// ── Receive corridors: the solver funds Arkade, the trader pays outside ─────

/** Default floor for the window between the last moment the hold invoice can
 * be paid and the solver's refund leaf opening. */
export const MIN_CLAIM_WINDOW_SECONDS = 30 * 60;

/**
 * Bind the SOLVER's hold invoice to the quote and to the trader's own `H`.
 *
 * The only attack on this corridor with no on-chain trace: an invoice on another payment hash is
 * paid to the solver in full and no lockup on `H` is ever funded. NEVER publish an invoice that
 * has not passed this.
 *
 * The decoder is injected (no BOLT11 dependency), but the comparison lives here: a caller-supplied
 * summary of an adversary's invoice checks nothing. A hold invoice is indistinguishable on the
 * wire, so that is not checked.
 *
 * Reasons: `invoice_undecodable` | `invoice_hash_mismatch` |
 * `invoice_amount_mismatch` | `quote_malformed`.
 *
 * @deprecated Internal to `client.quote()` and `client.accept()`. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export const verifyReceiveInvoice = (input: {
    invoice: string;
    decode: (bolt11: string) => InvoiceFacts;
    /** `sha256(P)`, hex — the trader's OWN. */
    paymentHash: string;
    quote: RfqQuote;
}): { payDeadline: number } => {
    let decoded: InvoiceFacts;
    try {
        decoded = input.decode(input.invoice);
    } catch (error) {
        throw gateError(
            "invoice_undecodable",
            `solver sent an undecodable invoice: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    // Both `payDeadline` operands: NaN here would disarm every gate downstream (see assertFinite).
    assertFinite(decoded.expiresAt, "invoice_undecodable", "the decoded invoice expiry");
    assertFinite(input.quote.valid_until, "quote_malformed", "quote valid_until");
    if (decoded.paymentHash !== input.paymentHash) {
        throw gateError(
            "invoice_hash_mismatch",
            `solver's invoice pays ${decoded.paymentHash}, not this swap's ${input.paymentHash}`,
        );
    }
    // BOLT11 permits an amountless invoice, which lets a payer pay anything;
    // decoders surface that as 0, so a nullish check would miss it.
    if (decoded.amountSats <= 0) {
        throw gateError("invoice_amount_mismatch", "solver's invoice names no amount");
    }
    if (decoded.amountSats !== input.quote.from_amount) {
        throw gateError(
            "invoice_amount_mismatch",
            `solver's invoice asks for ${decoded.amountSats}, not the quoted from_amount ${input.quote.from_amount}`,
        );
    }
    return { payDeadline: Math.min(decoded.expiresAt, input.quote.valid_until) };
};

/**
 * The receive leg's gate, checked before the invoice is published. Separate from
 * {@link assertFundable} because `refund_locktime` is the SOLVER's here (BIP-113 lag extends the
 * trader's window); what runs out is the hold invoice, so the claim window is measured from
 * `payDeadline`, not `now`.
 *
 * `maxPayAmount` is an opt-in ceiling: with `amountSide: "to"` the price is the free variable.
 * Optional because a bad price is visible to the caller before anything is published.
 *
 * Reasons: `quote_expired` | `missing_refund_locktime` | `claim_window_too_short` |
 * `price_too_high` | `quote_malformed` | `invalid_gate_input`.
 */
export const assertReceivable = (input: {
    quote: RfqQuote;
    /** From {@link verifyReceiveInvoice}: `min(invoice expiry, valid_until)`. */
    payDeadline: number;
    now: number;
    minClaimWindowSeconds?: number;
    /** Absolute sats ceiling on `from_amount`. */
    maxPayAmount?: number;
}): void => {
    // Exported, so nothing here is pre-vetted: a NaN ceiling or clock would delete its gate.
    assertFinite(input.payDeadline, "quote_malformed", "payDeadline");
    assertFinite(input.now, "invalid_gate_input", "now");
    assertFinite(input.minClaimWindowSeconds, "invalid_gate_input", "minClaimWindowSeconds");
    assertFinite(input.maxPayAmount, "invalid_gate_input", "maxPayAmount");
    const minClaimWindow = input.minClaimWindowSeconds ?? MIN_CLAIM_WINDOW_SECONDS;
    if (input.now >= input.payDeadline) {
        throw gateError("quote_expired", "quote or invoice already expired — request a fresh one");
    }
    if (input.quote.refund_locktime === undefined) {
        throw gateError("missing_refund_locktime", "receive quote carries no refund_locktime");
    }
    assertFinite(input.quote.refund_locktime, "quote_malformed", "quote refund_locktime");
    if (input.quote.refund_locktime - input.payDeadline < minClaimWindow) {
        throw gateError(
            "claim_window_too_short",
            `a payment at the deadline would leave under ${minClaimWindow}s to claim before the solver's refund opens`,
        );
    }
    if (
        input.maxPayAmount !== undefined &&
        quoteSats(input.quote.from_amount, "from_amount") > input.maxPayAmount
    ) {
        throw gateError(
            "price_too_high",
            `quote asks ${input.quote.from_amount} sats, above the ${input.maxPayAmount} ceiling`,
        );
    }
};

/** Compile the RECEIVE-direction VHTLC: the same suite-carrying tree as {@link
 * lightningSendContract} with the roles inverted — the trader is the
 * `receiver` (it generated `P` and claims the lockup with it), the solver is
 * the `sender` (it funds the lockup and holds the refund recourse). Shared by both receive
 * corridors.
 *
 * @deprecated Internal to `client.quote()` and `client.accept()`. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export function lightningReceiveContract(params: {
    /** Binding field #1: the solver's x-only key, from the quote — VHTLC's
     * `sender` role on the receive corridors. */
    solverPubkey: Uint8Array;
    /** Binding field #2: the SOLVER's own refund deadline on these legs, from
     * the quote — after it the solver may reclaim an unclaimed lockup. */
    refundLocktime: number;
    /** The Arkade operator's x-only key — the trader's OWN connection. */
    operatorPubkey: Uint8Array;
    /** `sha256(P)`, hex — the trader's OWN preimage hash. */
    paymentHash: string;
    /** From {@link unilateralClaimDelay} over the trader's OWN server info. */
    claimDelay: number;
    /** Emulator x-only key — see {@link requestLightningSend}'s parameter. */
    emulatorPubkey: Uint8Array;
    /** The solver's covenant refund destination, from the quote
     * (`profile.solver_refund_pk_script`) — the one tree parameter nothing
     * else on the wire determines. */
    solverRefundPkScript: Uint8Array;
    /** The trader's own x-only Arkade key — VHTLC's `receiver` role on these
     * legs, so the trader can claim without covclaimd. */
    payoutPubkey: Uint8Array;
    /** The trader's own Arkade payout pkScript (decoded from its payout
     * address) — `nonInteractiveClaim`'s pinned destination. */
    payoutPkScript: Uint8Array;
    /** LEGACY REBUILD ONLY — see {@link lightningSendVtxoScript}'s `legacy`. */
    legacy?: "preTimelockedRefund";
}): InstanceType<typeof VHTLC.ScriptV2> {
    return suiteVhtlc(params, {
        sender: params.solverPubkey,
        receiver: params.payoutPubkey,
        senderPkScript: params.solverRefundPkScript,
        receiverPkScript: params.payoutPkScript,
    });
}

/** Every input {@link lightningReceiveContract} builds from; see
 * {@link LightningSendContractParams}.
 *
 * @deprecated Internal to `client.quote()` and `client.accept()`. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export type LightningReceiveContractParams = Parameters<typeof lightningReceiveContract>[0];

/** Both receive corridors' covenant: the inputs, and the quoted shape they match. */
const matchReceiveLockup = (
    input: {
        quote: RfqQuote;
        paymentHash: string;
        payoutPubkey: Uint8Array;
        payoutAddress: string;
        operatorPubkey: Uint8Array;
        emulatorPubkey: Uint8Array;
        claimDelay: number;
        hrp: string;
    },
    refundLocktime: number,
    solverRefundPkScriptHex: string,
) => {
    const contractParams = {
        solverPubkey: toXOnly(hex.decode(input.quote.solver_pubkey), "solver key"),
        refundLocktime,
        operatorPubkey: input.operatorPubkey,
        paymentHash: input.paymentHash,
        claimDelay: input.claimDelay,
        emulatorPubkey: input.emulatorPubkey,
        solverRefundPkScript: solverHex(solverRefundPkScriptHex, "profile.solver_refund_pk_script"),
        payoutPubkey: input.payoutPubkey,
        payoutPkScript: ArkAddress.decode(input.payoutAddress).pkScript,
    };
    const matched = matchQuotedLockup(input.quote, input.hrp, input.operatorPubkey, (legacy) =>
        lightningReceiveContract({ ...contractParams, ...(legacy !== undefined && { legacy }) }),
    );
    return { contractParams, matched };
};

/**
 * The pure core of {@link requestLightningReceive}: derive the solver-funded
 * covenant locally from the quote's binding fields plus the trader's own data
 * and refuse on any address mismatch. The trader funds nothing on Arkade here, but this is what
 * makes paying the hold invoice safe: the lockup must be a tree whose claim paths pay the trader.
 */
export function deriveLightningReceive(input: {
    quote: RfqQuote;
    paymentHash: string;
    payoutPubkey: Uint8Array;
    payoutAddress: string;
    operatorPubkey: Uint8Array;
    emulatorPubkey: Uint8Array;
    claimDelay: number;
    hrp: string;
}): {
    address: string;
    swapPkScript: Uint8Array;
    script: InstanceType<typeof VHTLC.ScriptV2>;
    /** The solver's hold invoice on `H` — what the trader pays to arm the swap. */
    invoice: string;
    refundLocktime: number;
    /** Every input the covenant was built from; see `requestLightningSend`'s result. */
    contractParams: LightningReceiveContractParams;
} {
    const { quote } = input;
    const profile = quote.profile ?? {};
    const refundLocktime = quote.refund_locktime;
    const invoice = profile.invoice as string | undefined;
    const solverRefundPkScriptHex = profile.solver_refund_pk_script as string | undefined;
    if (
        refundLocktime === undefined ||
        invoice === undefined ||
        solverRefundPkScriptHex === undefined
    ) {
        throw new Error("lightning-receive quote is missing a binding field");
    }

    // `contractParams` echoes the MATCHED build, so a persisted record rebuilds the funded lockup.
    const { contractParams, matched } = matchReceiveLockup(
        input,
        refundLocktime,
        solverRefundPkScriptHex,
    );
    return {
        address: matched.address,
        swapPkScript: matched.script.pkScript,
        script: matched.script,
        invoice,
        refundLocktime,
        contractParams: {
            ...contractParams,
            ...(matched.legacy !== undefined && { legacy: matched.legacy }),
        },
    };
}

/** Both receive flows' setup; `persistBefore` names the step the warning is for. */
const provisionReceive = async (
    wallet: IWallet,
    covclaimdPubkey: Uint8Array | undefined,
    persistBefore: "paying" | "funding",
) => {
    const secrets = await provisionClaimSecret(wallet);
    if (secrets.mustPersistPreimage) {
        console.warn(
            `[swap] this swap's preimage cannot be re-derived from the seed and MUST be persisted with the record before ${persistBefore}`,
        );
    }
    const preimage = secrets.preimage;
    const paymentHash = hex.encode(secrets.paymentHash);
    const payoutPubkey = secrets.pubkey;
    const [info, payoutAddress] = await Promise.all([
        wallet.getArkadeInfo({ requireLive: true }),
        wallet.getAddress(),
    ]);
    const claimPacket = covclaimdPubkey
        ? await sealClaimPacket({ preimage, covclaimdPubkey })
        : undefined;
    return { secrets, paymentHash, payoutPubkey, info, payoutAddress, claimPacket };
};

/**
 * The `lightning:BTC->arkade:BTC` user flow: quote → derive the covenant locally → verify → gate.
 * Returns the solver's hold invoice (already checked by {@link verifyReceiveInvoice}) for the
 * trader's own Lightning wallet to PAY before `invoiceExpiresAt`. Once the HTLC is held the solver
 * funds the lockup and the trader claims it with its own `P` ({@link claimReceiveLockup}).
 *
 * Three obligations, all before the invoice is handed to a payer:
 *
 * 1. Persist `secrets` and `expectedAmount`; without the latter the claim cannot check the funded
 *    value.
 * 2. Stay online. covclaimd cannot claim this covenant today, so an unclaimed lockup is reclaimed
 *    by the solver at `refund_locktime` and the payer refunded.
 * 3. On {@link LockupRegistrationFailed}, call this again once the store works. The failed attempt
 *    is inert (no invoice was returned); re-registering `error.script` does NOT resume it.
 */
export async function requestLightningReceive(
    wallet: IWallet,
    transport: RfqTransport,
    params: {
        amount: number;
        amountSide: "from" | "to";
        /** Co-signer key override (33-byte compressed hex); see
         * {@link resolveEmulatorPubkey}. */
        emulatorPubkey?: string;
        /** covclaimd's 33-byte compressed pubkey; the claim packet seals `P` to it. Unset where
         * none is deployed: nothing is sent, and claiming before `refund_locktime` is the caller's
         * job. Never substitute a throwaway key — nobody could open it. */
        covclaimdPubkey?: Uint8Array;
        /** The caller's own BOLT11 decoder, applied to the SOLVER's invoice. Required: skipping
         * this check can lose the whole payment. */
        decodeInvoice: (bolt11: string) => InvoiceFacts;
        /** Opt-in ceiling, in sats, on what the payer will be asked for. */
        maxPayAmount?: number;
        rfqId?: string;
    },
): Promise<{
    rfqId: string;
    quote: RfqQuote;
    /** The solver's hold invoice — what the trader pays, for `payAmount`.
     * Verified against this swap's `H` and the quote's `from_amount`. */
    invoice: string;
    /** What the trader pays: the quote's `from_amount`. */
    payAmount: number;
    /** What the solver's lockup must carry: the quote's `to_amount`. Persist it with the record:
     * `pushClaim` refuses to publish `P` for less. */
    expectedAmount: number;
    /** Last moment the invoice can be paid, unix seconds: `min(invoice
     * expiry, valid_until)`. */
    invoiceExpiresAt: number;
    /** The trader's OWN derivation of the lockup the solver must fund. */
    address: string;
    swapPkScript: Uint8Array;
    script: InstanceType<typeof VHTLC.ScriptV2>;
    payoutAddress: string;
    /** The trader's covenant `receiver` key, bound into the tree. Public. */
    payoutPubkey: Uint8Array;
    /** How the preimage and the payout key are recovered later — map it
     * through `swapSecretsToRecord` and persist BEFORE paying the invoice.
     * Public unless `mustPersistPreimage` says the wallet could not derive P. */
    secrets: ProvisionedClaimSecret;
    /** Every input the covenant was built from; see the same field on
     * `requestLightningSend`'s result. */
    contractParams: LightningReceiveContractParams;
}> {
    const rfqId = params.rfqId ?? newRfqId();
    const { secrets, paymentHash, payoutPubkey, info, payoutAddress, claimPacket } =
        await provisionReceive(wallet, params.covclaimdPubkey, "paying");

    const quote = await transport.requestQuote(
        lightningReceiveRequest({
            rfqId,
            paymentHash,
            payoutAddress,
            payoutPubkey,
            claimPacket: claimPacket?.packet,
            amount: params.amount,
            amountSide: params.amountSide,
        }),
    );
    assertQuotedAmount(quote, params.amountSide, params.amount);

    const derived = deriveLightningReceive({
        quote,
        paymentHash,
        payoutPubkey,
        payoutAddress,
        ...serverTerms(info, params.emulatorPubkey),
    });
    const now = Math.floor(Date.now() / 1000);
    const { payDeadline } = verifyReceiveInvoice({
        invoice: derived.invoice,
        decode: params.decodeInvoice,
        paymentHash,
        quote,
    });
    assertReceivable({ quote, payDeadline, now, maxPayAmount: params.maxPayAmount });

    // Watch the solver-funded lockup from the moment its address exists.
    await registerLockupContract(
        await wallet.getContractManager(),
        derived.script,
        derived.address,
    );

    return {
        rfqId,
        quote,
        invoice: derived.invoice,
        payAmount: quoteSats(quote.from_amount, "from_amount"),
        expectedAmount: quoteSats(quote.to_amount, "to_amount"),
        invoiceExpiresAt: payDeadline,
        address: derived.address,
        swapPkScript: derived.swapPkScript,
        script: derived.script,
        payoutAddress,
        payoutPubkey,
        secrets,
        contractParams: derived.contractParams,
    };
}

/**
 * The pure core of {@link requestOnchainReceive}: derive BOTH contracts
 * locally — the solver-funded Arkade covenant and the L1 HTLC the trader
 * funds — and refuse on any mismatch. Binding: `solver_pubkey`,
 * `refund_locktime`, `claim_pubkey`, `htlc_locktime`, `min_confirmations`;
 * `lockup_address` and `htlc_address` are compare-only.
 */
export function deriveOnchainReceive(input: {
    quote: RfqQuote;
    paymentHash: string;
    payoutPubkey: Uint8Array;
    payoutAddress: string;
    /** The trader's own x-only L1 key — the HTLC's refund role. */
    refundPubkey: Uint8Array;
    operatorPubkey: Uint8Array;
    emulatorPubkey: Uint8Array;
    claimDelay: number;
    hrp: string;
    l1Network: OnchainNetwork;
}): {
    address: string;
    swapPkScript: Uint8Array;
    script: InstanceType<typeof VHTLC.ScriptV2>;
    /** The L1 HTLC the trader funds, derived locally — fund only this. */
    htlc: OnchainHtlc;
    refundLocktime: number;
    htlcLocktime: number;
    minConfirmations: number;
} {
    const { quote } = input;
    const profile = quote.profile ?? {};
    const refundLocktime = quote.refund_locktime;
    const claimPubkey = profile.claim_pubkey as string | undefined;
    const htlcLocktime = profile.htlc_locktime as number | undefined;
    const htlcAddress = profile.htlc_address as string | undefined;
    const minConfirmations = profile.min_confirmations as number | undefined;
    const solverRefundPkScriptHex = profile.solver_refund_pk_script as string | undefined;
    if (
        refundLocktime === undefined ||
        claimPubkey === undefined ||
        htlcLocktime === undefined ||
        minConfirmations === undefined ||
        solverRefundPkScriptHex === undefined
    ) {
        throw new Error("onchain-receive quote is missing a binding field");
    }

    const { script, address } = matchReceiveLockup(
        input,
        refundLocktime,
        solverRefundPkScriptHex,
    ).matched;

    const htlc = onchainHtlcScript(
        {
            paymentHash: input.paymentHash,
            claimKey: toXOnly(hex.decode(claimPubkey), "solver L1 claim key"),
            refundKey: input.refundPubkey,
            refundLocktime: htlcLocktime,
        },
        input.l1Network,
    );
    if (htlc.address !== htlcAddress) throw new AddressMismatch(htlc.address, htlcAddress);

    return {
        address,
        swapPkScript: script.pkScript,
        script,
        htlc,
        refundLocktime,
        htlcLocktime,
        minConfirmations,
    };
}

/**
 * The `onchain:BTC->arkade:BTC` user flow: quote → derive BOTH contracts
 * locally → verify → gate. Returns the L1 HTLC for the trader's own L1 wallet to fund with
 * `fundAmount`. After `min_confirmations` the solver funds the Arkade lockup; the trader claims it
 * with `P`.
 *
 * Persist `secrets` BEFORE funding. If the swap never settles, the L1 refund leaf opens at
 * `htlc.refundLocktime` (see `buildHtlcRefund`).
 */
export async function requestOnchainReceive(
    wallet: IWallet,
    transport: RfqTransport,
    params: {
        amount: number;
        amountSide: "from" | "to";
        /** Co-signer key override (33-byte compressed hex); see
         * {@link resolveEmulatorPubkey}. */
        emulatorPubkey?: string;
        /** Trader's x-only L1 key for the HTLC's refund leaf. */
        refundPubkey: Uint8Array;
        /** covclaimd's 33-byte compressed pubkey; see {@link requestLightningReceive}. */
        covclaimdPubkey?: Uint8Array;
        rfqId?: string;
    },
): Promise<{
    rfqId: string;
    quote: RfqQuote;
    /** The trader's OWN derivation of the lockup the solver must fund. */
    address: string;
    /** What the trader's L1 funding must carry: the quote's `from_amount`. */
    fundAmount: number;
    /** What the solver's lockup must carry: the quote's `to_amount`. Persist
     * it with the record — see {@link requestLightningReceive}. */
    expectedAmount: number;
    swapPkScript: Uint8Array;
    script: InstanceType<typeof VHTLC.ScriptV2>;
    /** The EXPECTED L1 contract, derived locally — fund only this address. */
    htlc: OnchainHtlc;
    payoutAddress: string;
    payoutPubkey: Uint8Array;
    /** How the preimage and the payout key are recovered later — map it
     * through `swapSecretsToRecord` and persist BEFORE funding. Public unless
     * `mustPersistPreimage` says the wallet could not derive P. */
    secrets: ProvisionedClaimSecret;
}> {
    const rfqId = params.rfqId ?? newRfqId();
    const { secrets, paymentHash, payoutPubkey, info, payoutAddress, claimPacket } =
        await provisionReceive(wallet, params.covclaimdPubkey, "funding");

    const quote = await transport.requestQuote(
        onchainReceiveRequest({
            rfqId,
            paymentHash,
            payoutAddress,
            payoutPubkey,
            refundPubkey: params.refundPubkey,
            claimPacket: claimPacket?.packet,
            amount: params.amount,
            amountSide: params.amountSide,
        }),
    );
    assertQuotedAmount(quote, params.amountSide, params.amount);

    const derived = deriveOnchainReceive({
        quote,
        paymentHash,
        payoutPubkey,
        payoutAddress,
        refundPubkey: params.refundPubkey,
        ...serverTerms(info, params.emulatorPubkey),
        l1Network: l1NetworkFromArk(info.network),
    });
    assertFundable({
        quote,
        now: Math.floor(Date.now() / 1000),
        onchain: {
            htlcLocktime: derived.htlcLocktime,
            minConfirmations: derived.minConfirmations,
            direction: "receive",
        },
    });

    // Watch the solver-funded lockup from the moment its address exists.
    await registerLockupContract(
        await wallet.getContractManager(),
        derived.script,
        derived.address,
    );

    return {
        rfqId,
        quote,
        address: derived.address,
        fundAmount: quoteSats(quote.from_amount, "from_amount"),
        expectedAmount: quoteSats(quote.to_amount, "to_amount"),
        swapPkScript: derived.swapPkScript,
        script: derived.script,
        htlc: derived.htlc,
        payoutAddress,
        payoutPubkey,
        secrets,
    };
}
