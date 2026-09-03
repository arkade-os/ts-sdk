/**
 * The EVM corridors' wire layer — `arkade:BTC->ethereum:<token>` and
 * `ethereum:<token>->arkade:BTC`.
 *
 * The negotiation half only: the pair form, the token identity, the amount
 * encoding, the two `rfq_request` shapes and the two quote shapes a solver
 * answers with. Deriving the Arkade covenant, checking the two deadlines
 * against each other and funding are NOT here — see the deadline note on
 * {@link EvmSendQuoteProfile.evm_timeout_block} for why the ordering check
 * needs a per-chain block cadence this module deliberately does not invent.
 *
 * Its own file rather than more of `rfq.ts` because nothing here is shared
 * with the four BTC corridors: those dispatch on a pair CONSTANT, and an EVM
 * pair cannot be one — it names its ERC20, and which tokens are served is a
 * solver deployment's choice, known only at runtime.
 *
 * ## The reference solver, and where the parity is pinned
 *
 * Every shape below is the client half of a schema that already exists and is
 * already strict. The source of truth is `arkade-os/intent-solver` at
 * `9751a1c`:
 *
 * - `packages/solver-corridors-evm/src/wire/evmPayloads.ts` — the two
 *   `.strict()` request schemas and the two quote payload builders.
 * - `packages/solver-core/src/core/corridorPolicy.ts` — `evmCorridorFor`,
 *   `evmDirectionOf`, and the LOWERCASE-only pair regex.
 * - `docs/rfq-protocol.md` §§ 2.1, 7.1.5 — the amount encoding and the EVM
 *   profiles.
 *
 * Restated here rather than imported, for the reason `rfq.ts` gives for
 * restating the wire's pair cap: this repo does not own those numbers, and a
 * copy that drifts is caught by a test that pins it (`test/evmRfq.test.ts`)
 * rather than by a swap that silently never matches.
 *
 * ## Amounts
 *
 * **A token quantity is a `bigint` in this API and a canonical decimal string
 * on the wire.** Not a `number`, at either end.
 *
 * An ERC20 amount is 256-bit. A JSON number is an IEEE-754 double, exact only
 * to 2^53 − 1 — which at 18 decimals is 0.009 tokens, so one whole DAI does
 * not survive the round trip. The rounding would happen inside `JSON.parse`,
 * before any validator on either side could see it, and neither party could
 * detect that it had happened. That is why the solver's schema types
 * `evm_amount` as a string, why its store declares the column TEXT, and why
 * § 2.1 of the protocol specifies a canonical decimal string for every amount.
 *
 * `bigint` at the API boundary because it is the only exact integer JS has,
 * and every comparison a client makes against these values — is this the
 * amount I asked for, is the lock funded for what was quoted — has to be
 * exact. `String(aBigint)` is already the canonical form for a non-negative
 * value: digits only, no separator, no exponent, no leading zero. So encoding
 * needs no formatter, and the only real work is on the way IN — see {@link
 * evmAmountFromWire}, which refuses a JSON number outright.
 *
 * The SATS side of both corridors stays a JSON `number`, matching the four BTC
 * corridors and the solver's own schemas. § 2.1 makes those strings too; that
 * is a migration for corridors that already ship, in flight separately, and
 * bundling it here would change five corridors to add one.
 */
import { hex } from "@scure/base";

import { ARKADE_BTC, assertPairLength, rfqPair } from "./rfq";

// ── Pairs and token identity ────────────────────────────────────────────────

/** The EVM leg's chain namespace. One value: the corridor is EVM-shaped, and
 * WHICH chain it runs on is named by the quote's `evm_chain_id`, not by the
 * pair. A second namespace here would be a second market key for one corridor. */
export const EVM_CHAIN = "ethereum";

/** `0x` then 40 hex, either case — what an EIP-55 checksummed address looks
 * like, and what the solver's profile schema accepts for `evm_claim_address`
 * and `evm_refund_address`. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Atomic units as a canonical decimal string: digits only, no sign, no point,
 * no exponent, no leading zero. The solver's `TOKEN_AMOUNT`, restated.
 *
 * Anchored, so `1e18` is refused rather than partially matched. Three
 * spellings of exponent notation exist, and quietly reading one wrong
 * misprices by eighteen orders of magnitude.
 */
const TOKEN_AMOUNT = /^(0|[1-9][0-9]*)$/;

/** The two directional pair spellings, LOWERCASE token only — the solver's
 * `evmDirectionOf`, restated. */
const SEND_PAIR = /^arkade:BTC->ethereum:0x[0-9a-f]{40}$/;
const RECEIVE_PAIR = /^ethereum:0x[0-9a-f]{40}->arkade:BTC$/;

/**
 * The `ethereum:<token>` leg for an ERC20, LOWERCASED.
 *
 * Accepts a checksummed address and emits a lowercase one, deliberately. The
 * solver's pair regex is lowercase-only while its profile address schema is
 * case-insensitive, so the same address is legal in one field of a request and
 * refused in another — and a client that normalised in only one place would
 * build a request whose profile parses and whose pair is `unsupported_pair`.
 *
 * The same rule, and the same reason, as `arkadeAssetLeg` for asset ids:
 * solvers compare pair strings byte for byte, so one spelling normalised in
 * one layer and not another derives the right market key and is then skipped
 * as an unserved pair.
 */
export const evmTokenLeg = (tokenAddress: string): string =>
    `${EVM_CHAIN}:${assertEvmAddress(tokenAddress, "token address").toLowerCase()}`;

/** `arkade:BTC->ethereum:<token>` — the client locks sats, the solver pays
 * tokens. */
export const evmSendPair = (tokenAddress: string): string => {
    const pair = rfqPair(ARKADE_BTC, evmTokenLeg(tokenAddress));
    assertPairLength(pair);
    return pair;
};

/** `ethereum:<token>->arkade:BTC` — the client locks tokens, the solver pays
 * sats. */
export const evmReceivePair = (tokenAddress: string): string => {
    const pair = rfqPair(evmTokenLeg(tokenAddress), ARKADE_BTC);
    assertPairLength(pair);
    return pair;
};

/**
 * Which EVM direction a pair names, or `null` when it names neither.
 *
 * Mirrors the solver's `evmDirectionOf`, and exists for the same reason: an
 * EVM pair is not a constant, so nothing can dispatch on it by equality. A
 * client holding a stored swap or an inbound status has only the pair string
 * to decide what it is looking at.
 */
export const evmDirectionOf = (pair: string): "send" | "receive" | null => {
    if (SEND_PAIR.test(pair)) return "send";
    if (RECEIVE_PAIR.test(pair)) return "receive";
    return null;
};

/** The lowercase ERC20 address an EVM pair names, or `null` when the pair is
 * not an EVM one. */
export const evmTokenOf = (pair: string): string | null => {
    const direction = evmDirectionOf(pair);
    if (direction === null) return null;
    const leg =
        direction === "send"
            ? pair.slice(pair.indexOf("->") + 2)
            : pair.slice(0, pair.indexOf("->"));
    return leg.slice(EVM_CHAIN.length + 1);
};

// ── Amounts ─────────────────────────────────────────────────────────────────

/**
 * A token quantity in the wire's canonical decimal form.
 *
 * Refuses a negative value rather than emitting `-1`: the solver's schema is
 * anchored, so it would answer `unsupported_payload`, which says nothing about
 * which field was wrong.
 */
export const evmAmountToWire = (units: bigint): string => {
    if (units < 0n) throw new Error(`token amount may not be negative, got ${units}`);
    return units.toString();
};

/**
 * A token quantity off the wire, as an exact `bigint`.
 *
 * **A JSON number is refused, never coerced.** This is the whole point of the
 * string encoding: by the time a number is sitting in one of these fields,
 * `JSON.parse` has already rounded it to the nearest double and the original
 * value is gone. Accepting it — via `BigInt(Math.trunc(v))`, or the implicit
 * coercion any arithmetic on it would do — turns a detectable protocol
 * violation into a silently wrong amount, which is exactly the failure the
 * encoding exists to make impossible.
 *
 * Non-canonical strings are refused for the same reason: `"0x10"`, `"1e18"`,
 * `"01"` and `" 1"` all have a plausible reading and at least one wrong one.
 */
export const evmAmountFromWire = (value: unknown, field: string): bigint => {
    if (typeof value !== "string") {
        throw new Error(
            `${field} must be a decimal string of atomic units, not a JSON ${typeof value} — ` +
                `a number here has already been rounded by the parser`,
        );
    }
    if (!TOKEN_AMOUNT.test(value)) {
        throw new Error(`${field} is not a canonical decimal amount: ${JSON.stringify(value)}`);
    }
    return BigInt(value);
};

// ── Requests ────────────────────────────────────────────────────────────────

/**
 * The `rfq_request` for `arkade:BTC->ethereum:<token>`.
 *
 * **Exact-in only.** `amount_side` is pinned to `"from"` and `amount` is sats:
 * the `to` leg is a different asset, so exact-out would mean inverting a
 * fetched, rounded, directional rate. The solver's schema pins the literal, so
 * an exact-out request is refused rather than served at a worse price.
 *
 * The client funds the Arkade covenant FIRST on this corridor, and funding is
 * acceptance — so it holds that side's refund role, and `client_refund_pubkey`
 * is its own x-only key for the covenant's client-side refund leaves. Same
 * role and same field name as on the Lightning and onchain send legs.
 *
 * `evmClaimAddress` is the client's own EVM address, and the only party
 * `ERC20Swap.claim` will pay. Sent as given: the solver's schema is
 * case-insensitive here, and flattening an EIP-55 checksum would throw away
 * the typo protection that spelling exists for.
 */
export const evmSendRequest = (input: {
    rfqId: string;
    /** The ERC20 being bought. Normalised into the pair — see {@link evmTokenLeg}. */
    tokenAddress: string;
    /** `sha256(P)`, hex — client-chosen; see `paymentHashOf`. */
    paymentHash: string;
    /** Where the CLIENT takes the tokens. */
    evmClaimAddress: string;
    /** The client's Arkade address — where the covenant refund must pay. */
    refundAddress: string;
    /** The client's own x-only key for the covenant's refund leaves. */
    senderPubkey: Uint8Array;
    /** Sats the client locks. Exact-in. */
    amountSats: number;
}): Record<string, unknown> => {
    assertPositiveInteger(input.amountSats, "amountSats");
    return {
        v: 1,
        type: "rfq_request",
        rfq_id: input.rfqId,
        pair: evmSendPair(input.tokenAddress),
        amount_side: "from",
        amount: input.amountSats,
        profile: {
            payment_hash: input.paymentHash,
            evm_claim_address: assertEvmAddress(input.evmClaimAddress, "evmClaimAddress"),
            refund_address: input.refundAddress,
            client_refund_pubkey: hex.encode(input.senderPubkey),
        },
    };
};

/**
 * The `rfq_request` for `ethereum:<token>->arkade:BTC`.
 *
 * **The envelope carries no `amount` at all**, and its absence is load-bearing
 * rather than an omission. What the client gives is a token quantity; the
 * envelope's `amount` is a JSON number, so it cannot hold one. `evm_amount`
 * carries it in the profile as a decimal string instead. The solver's schema
 * is `.strict()`, so an `amount` added "for symmetry" is not ignored — it is
 * an undeclared key, and the whole request is refused as `unsupported_payload`.
 *
 * `amount_side` stays `"from"`: the client still names what it gives.
 *
 * **`evm_timeout_block` is the CLIENT's own deadline** on this corridor,
 * because the client locks the ERC20 first. The solver validates it, derives
 * its own `refund_locktime` underneath it, and refuses outright if the
 * ordering cannot hold. It is a BLOCK HEIGHT — see {@link
 * EvmSendQuoteProfile.evm_timeout_block}.
 *
 * There is deliberately no `claim_packet` here, unlike the two BTC receive
 * legs: this profile does not offer the covclaimd non-interactive path, so the
 * client must be online to claim its own Arkade payout.
 */
export const evmReceiveRequest = (input: {
    rfqId: string;
    /** The ERC20 being sold. Normalised into the pair — see {@link evmTokenLeg}. */
    tokenAddress: string;
    /** `sha256(P)`, hex — client-chosen. */
    paymentHash: string;
    /** Atomic units of the token the client locks. */
    evmAmount: bigint;
    /** BLOCK HEIGHT after which the client may take its own tokens back. */
    evmTimeoutBlock: number;
    /** Where the client's own EVM refund goes. */
    evmRefundAddress: string;
    /** The client's Arkade address — where the swapped sats land. */
    payoutAddress: string;
    /** The client's x-only Arkade key — the covenant's `receiver` role. */
    payoutPubkey: Uint8Array;
}): Record<string, unknown> => {
    assertPositiveInteger(input.evmTimeoutBlock, "evmTimeoutBlock");
    return {
        v: 1,
        type: "rfq_request",
        rfq_id: input.rfqId,
        pair: evmReceivePair(input.tokenAddress),
        amount_side: "from",
        profile: {
            payment_hash: input.paymentHash,
            evm_amount: evmAmountToWire(input.evmAmount),
            evm_timeout_block: input.evmTimeoutBlock,
            evm_refund_address: assertEvmAddress(input.evmRefundAddress, "evmRefundAddress"),
            payout_address: input.payoutAddress,
            payout_pubkey: hex.encode(input.payoutPubkey),
        },
    };
};

// ── Quotes ──────────────────────────────────────────────────────────────────

/** What both EVM quote profiles carry. */
interface EvmQuoteProfileCommon {
    /** Echo of the client's own `payment_hash`. */
    payment_hash: string;
    /** Compare-only: the solver's derivation of the Arkade covenant. NEVER
     * fund it without re-deriving it locally and matching. */
    lockup_address: string;
    /** Which `ERC20Swap` the lock lives in. */
    evm_contract_address: string;
    /** Which chain. The same swap key can exist on two of them. */
    evm_chain_id: number;
    /** Depth AND age, and the observing side waits for the LATER of the two:
     * a rollup sequencer can put a lock many confirmations deep in seconds
     * while the L1 posting it has not finalised. */
    min_confirmations: number;
    min_age_seconds: number;
    [key: string]: unknown;
}

/** `arkade:BTC->ethereum:<token>`. */
export interface EvmSendQuoteProfile extends EvmQuoteProfileCommon {
    /**
     * Compare-only, and the client cannot re-derive `lockup_address` without
     * it: the covenant's merkle root spans every leaf, and this one's
     * destination — the solver's own claim pkScript — is known to nobody else.
     * It carries none of `lockup_address`'s trust weight itself, since a wrong
     * value only makes that one leaf unusable for the solver.
     */
    receiver_pk_script: string;
    /**
     * The deadline the SOLVER's own ERC20 lock carries, as a BLOCK HEIGHT —
     * `ERC20Swap` denominates its timeout in `block.number`.
     *
     * Do NOT diff it against `refund_locktime`, which sits beside it in the
     * same quote and is unix seconds. The `_block` suffix is the only thing
     * distinguishing them, and a client reading this one as seconds measures
     * its recourse window against a ~5-million-block integer, concludes it has
     * centuries in hand, and skips the check that was protecting it.
     *
     * Comparing the two needs a per-chain block cadence, and the safe
     * direction differs by use — reading someone else's timeout assumes the
     * FASTEST cadence, sizing your own assumes the SLOWEST. This module does
     * not invent a constant for that; the ordering gate lands with the
     * covenant derivation.
     */
    evm_timeout_block: number;
}

/** `ethereum:<token>->arkade:BTC`. */
export interface EvmReceiveQuoteProfile extends EvmQuoteProfileCommon {
    /** The mirror of the send leg's `receiver_pk_script`: with the roles
     * exchanged, the leaf the client cannot supply for itself is the SOLVER's
     * refund destination. Compare-only, and needed to rebuild the merkle root
     * behind the client's own payout. */
    solver_refund_pk_script: string;
    /** The SOLVER's EVM address — the value the client MUST pass as
     * `claimAddress` when it locks. */
    evm_claim_address: string;
}

/**
 * A quote for `arkade:BTC->ethereum:<token>`.
 *
 * `from_amount` and `to_amount` are in DIFFERENT ASSETS — sats in, token
 * atomic units out — so they are not comparable as numbers, and the spread
 * between them is not a fee. What a fee ceiling needs on a cross-asset pair is
 * a reference rate of the caller's own; `assertFundable`'s `maxFee` takes one,
 * and `maxFee.referenceRate` is `to`-units per `from`-unit, which on this
 * direction means **token atomic units per sat**.
 */
export interface EvmSendQuote {
    v: 1;
    type: "rfq_quote";
    rfq_id: string;
    pair: string;
    /** Sats the client locks in the Arkade covenant. */
    from_amount: number;
    /** Token atomic units the solver will lock, canonical decimal string. */
    to_amount: string;
    solver_pubkey: string;
    valid_until: number;
    /** Unix seconds — the CLIENT's Arkade refund deadline on this corridor. */
    refund_locktime: number;
    profile: EvmSendQuoteProfile;
    [key: string]: unknown;
}

/** A quote for `ethereum:<token>->arkade:BTC`. `maxFee.referenceRate` on this
 * direction is **sats per token atomic unit**, the `to`-per-`from` convention
 * again — the reciprocal of the send leg's, and the easiest thing here to get
 * wrong by a factor of the token's decimals. */
export interface EvmReceiveQuote {
    v: 1;
    type: "rfq_quote";
    rfq_id: string;
    pair: string;
    /** Token atomic units the client locks, canonical decimal string. */
    from_amount: string;
    /** Sats the solver's Arkade lockup will carry. */
    to_amount: number;
    solver_pubkey: string;
    valid_until: number;
    /** Unix seconds — the SOLVER's Arkade refund deadline on this corridor. */
    refund_locktime: number;
    profile: EvmReceiveQuoteProfile;
    [key: string]: unknown;
}

/** Either direction. Use where a quote is carried rather than decided upon. */
export type EvmRfqQuote = EvmSendQuote | EvmReceiveQuote;

/**
 * Narrow and check a solver's reply to {@link evmSendRequest}.
 *
 * Checks SHAPE, not trust. Nothing here makes `lockup_address` safe to fund —
 * that takes a local re-derivation of the covenant. What it does buy is that
 * every field the funding path will later read is present and of the right
 * kind, so a missing `min_age_seconds` fails here, at the quote, rather than
 * by deleting an acceptance gate hours later.
 *
 * **Unknown fields are ignored**, in both the envelope and the profile.
 * Requests are strict and responses are tolerant (§ 1 of the protocol), so a
 * solver may extend a quote without a version bump, and a client that refused
 * the extension would be the one that broke.
 *
 * Pass the token you asked for: a quote naming a different one is a different
 * market, and comparing the pair is the only way to notice.
 *
 * **Takes `unknown`, and pass a transport's result straight in.**
 * `RfqTransport.requestQuote` is typed `Promise<RfqQuote>`, which is not
 * accurate for an EVM quote — `RfqQuote` declares both amounts `number`, and
 * on this corridor one of them is a decimal string. The transport does not
 * inspect them, so the value is right and only the type is wrong; running it
 * through here is what makes the two agree again. Do not read `to_amount` off
 * the transport's return value directly: it types as a `number`, it is a
 * string, and `+` on it concatenates.
 */
export const readEvmSendQuote = (
    payload: unknown,
    expected: { tokenAddress: string },
): EvmSendQuote => {
    const { quote, profile } = readEvmQuoteEnvelope(payload, evmSendPair(expected.tokenAddress));
    readCommonProfile(profile);
    assertHex(profile.receiver_pk_script, "profile.receiver_pk_script");
    assertPositiveInteger(profile.evm_timeout_block, "profile.evm_timeout_block");
    // Refused rather than read as a number: the token side of this quote is
    // what the client is buying, and a rounded value would be compared against
    // the ERC20 lock and match nothing.
    evmAmountFromWire(quote.to_amount, "to_amount");
    assertPositiveInteger(quote.from_amount, "from_amount");
    return quote as unknown as EvmSendQuote;
};

/** Narrow and check a solver's reply to {@link evmReceiveRequest}. See {@link
 * readEvmSendQuote} for what this does and does not promise. */
export const readEvmReceiveQuote = (
    payload: unknown,
    expected: { tokenAddress: string },
): EvmReceiveQuote => {
    const { quote, profile } = readEvmQuoteEnvelope(payload, evmReceivePair(expected.tokenAddress));
    readCommonProfile(profile);
    assertHex(profile.solver_refund_pk_script, "profile.solver_refund_pk_script");
    assertEvmAddress(
        asString(profile.evm_claim_address, "profile.evm_claim_address"),
        "profile.evm_claim_address",
    );
    evmAmountFromWire(quote.from_amount, "from_amount");
    assertPositiveInteger(quote.to_amount, "to_amount");
    return quote as unknown as EvmReceiveQuote;
};

/**
 * The token quantity an EVM quote names, exactly.
 *
 * Whichever leg is the token's — `to_amount` on a send quote, `from_amount` on
 * a receive one. The direction is read off the pair rather than taken as an
 * argument, so a caller cannot ask for the wrong side and get the sats leg
 * turned into a `bigint` that looks like a token amount.
 */
export const evmQuoteTokenAmount = (quote: EvmRfqQuote): bigint => {
    const direction = evmDirectionOf(quote.pair);
    if (direction === null) throw new Error(`not an EVM pair: ${JSON.stringify(quote.pair)}`);
    return direction === "send"
        ? evmAmountFromWire(quote.to_amount, "to_amount")
        : evmAmountFromWire(quote.from_amount, "from_amount");
};

/** The sats leg of an EVM quote — `from_amount` on a send quote, `to_amount`
 * on a receive one. The counterpart of {@link evmQuoteTokenAmount}, read the
 * same way off the pair, so the two can never be taken off the same side. */
export const evmQuoteSats = (quote: EvmRfqQuote): number => {
    const direction = evmDirectionOf(quote.pair);
    if (direction === null) throw new Error(`not an EVM pair: ${JSON.stringify(quote.pair)}`);
    const field = direction === "send" ? "from_amount" : "to_amount";
    const sats = quote[field];
    assertPositiveInteger(sats, field);
    return sats as number;
};

// ── Shared checks ───────────────────────────────────────────────────────────

const assertEvmAddress = (value: string, field: string): string => {
    if (!EVM_ADDRESS.test(value)) {
        throw new Error(`${field} must be 0x then 40 hex, got ${JSON.stringify(value)}`);
    }
    return value;
};

const assertPositiveInteger = (value: unknown, field: string): void => {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new Error(`${field} must be a positive integer, got ${String(value)}`);
    }
};

const assertNonNegativeInteger = (value: unknown, field: string): void => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new Error(`${field} must be a non-negative integer, got ${String(value)}`);
    }
};

const assertHex = (value: unknown, field: string): void => {
    if (typeof value !== "string" || value.length === 0 || !/^[0-9a-f]+$/.test(value)) {
        throw new Error(`${field} must be lowercase hex, got ${String(value)}`);
    }
};

const asString = (value: unknown, field: string): string => {
    if (typeof value !== "string") {
        throw new Error(`${field} must be a string, got ${String(value)}`);
    }
    return value;
};

const readEvmQuoteEnvelope = (
    payload: unknown,
    expectedPair: string,
): { quote: Record<string, unknown>; profile: Record<string, unknown> } => {
    if (!payload || typeof payload !== "object") throw new Error("EVM quote is not an object");
    const quote = payload as Record<string, unknown>;
    if (quote.type !== "rfq_quote") {
        throw new Error(`expected an rfq_quote, got ${String(quote.type)}`);
    }
    if (quote.pair !== expectedPair) {
        throw new Error(`solver quoted ${JSON.stringify(quote.pair)}, not ${expectedPair}`);
    }
    asString(quote.solver_pubkey, "solver_pubkey");
    assertPositiveInteger(quote.valid_until, "valid_until");
    // Required on both directions, unlike the arkade-to-arkade class: an EVM
    // corridor always has an Arkade covenant on one side, and a quote with no
    // refund deadline for it is one whose recourse window cannot be checked.
    assertPositiveInteger(quote.refund_locktime, "refund_locktime");
    if (!quote.profile || typeof quote.profile !== "object") {
        throw new Error("EVM quote carries no profile");
    }
    return { quote, profile: quote.profile as Record<string, unknown> };
};

const readCommonProfile = (profile: Record<string, unknown>): void => {
    asString(profile.payment_hash, "profile.payment_hash");
    asString(profile.lockup_address, "profile.lockup_address");
    assertEvmAddress(
        asString(profile.evm_contract_address, "profile.evm_contract_address"),
        "profile.evm_contract_address",
    );
    assertPositiveInteger(profile.evm_chain_id, "profile.evm_chain_id");
    assertPositiveInteger(profile.min_confirmations, "profile.min_confirmations");
    // Zero is legal and meaningful: it says the corridor gates on depth alone,
    // which is a solver's choice on a chain with real block times. Refusing it
    // would refuse a correct quote.
    assertNonNegativeInteger(profile.min_age_seconds, "profile.min_age_seconds");
};
