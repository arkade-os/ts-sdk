/**
 * Open RFQ — the client half of broadcast bidding (rfq-protocol § 4.6).
 *
 * Directed RFQ (§ 4.1–4.5) presumes the client already picked a solver. Open
 * RFQ inverts that: publish trade intent to everyone on a relay, collect
 * competing sealed bids, then close with the winner over the unchanged directed
 * flow. This is the client half; the solver half is already deployed, which is
 * why the wire details below are written against what solvers actually publish
 * rather than only against the spec.
 *
 * Three phases, and only the first two are new:
 *
 *  1. `rfq_open` — PLAINTEXT broadcast on kind 24860. No recipient, so nothing
 *     encryptable and nothing sensitive: no invoice, no address. Just the pair
 *     and the size.
 *  2. `rfq_bid` — each solver replies on the DIRECTED kind 24859, NIP-44
 *     sealed to the broadcast's author key. Sealed to the client rather than
 *     published, which makes this a sealed-bid auction: competitors cannot
 *     read each other's prices, so there is no undercutting race to run and
 *     no public price list to collude around.
 *  3. close — the ordinary directed flow against the winner. Nothing here.
 *
 * This module is deliberately transport-free. Everything below is pure: parse
 * a bid, price it, rank it. That keeps the part that must round IDENTICALLY to
 * the solver testable against the spec's own worked examples, with no relay in
 * the way.
 */

/** Broadcast kind for `rfq_open`. Directed traffic — including bids — is 24859. */
export const RFQ_BROADCAST_KIND = 24860;

/** Basis points denominator. A bid's `fee_bps` is a rate, bounded by this. */
const BPS_DENOMINATOR = 10_000n;

/**
 * § 2.1's canonical decimal: ASCII digits, no sign, no point, no exponent, no
 * leading zero unless the value is exactly "0".
 *
 * Anchored on purpose. `"1e18"`, `"1.5"` and `" 42"` are spellings a sender
 * might reach for, and reading any of them loosely misprices by orders of
 * magnitude — so they are refused rather than partially matched.
 */
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * Read an amount off the wire, in atomic units.
 *
 * Accepts BOTH forms the wire admits, and this is not politeness: § 2.1 makes
 * the canonical string the encoding, but a JSON number is still accepted where
 * it is provably lossless, and today's solver publishes a bid's `min`, `max`
 * and `fee_flat` as numbers. A client that accepted only strings would ignore
 * every real bid.
 *
 * Returns `null` rather than throwing: a malformed bid from one solver among
 * many is that solver's bid dropped, never the whole auction failing.
 */
export const parseWireAmount = (value: unknown): bigint | null => {
    if (typeof value === "number") {
        // Exactly the wire's own rule. A non-safe integer is precisely the case
        // where JSON.parse already rounded, so the value cannot be trusted even
        // though it looks like a number.
        if (!Number.isSafeInteger(value) || value < 0) return null;
        return BigInt(value);
    }
    if (typeof value === "string" && CANONICAL_DECIMAL.test(value)) return BigInt(value);
    return null;
};

/** Write an amount in § 2.1 canonical form. What this client PUBLISHES, always. */
export const formatWireAmount = (value: bigint): string => {
    if (value < 0n) throw new RangeError("amount cannot be negative");
    return value.toString(10);
};

/** Exactly one of these, per § 4.6. A bucket softens intent leakage. */
export type OpenRfqSize = { amount: bigint } | { sizeBucket: { min: bigint; max: bigint } };

/** A bid, parsed and attributed to the key that signed the event carrying it. */
export interface SolverBid {
    /** The bidding solver's pubkey — taken from the EVENT, never the payload. */
    solverPubkey: string;
    openId: string;
    pair: string;
    /** Spread in basis points. A rate, so a number: bounded by 10⁴, never an amount. */
    feeBps: number;
    /** The size-independent part, in atomic units of the FROM leg. Absent means zero. */
    feeFlat: bigint;
    /** Bounds on the TO leg — what the solver pays out. Both required (§ 4.6). */
    min: bigint;
    max: bigint;
    validUntil: number;
}

/**
 * Parse one decrypted bid payload.
 *
 * `solverPubkey` comes from the event, NOT the payload — the payload could
 * claim anything, while the event's signature is what actually binds a price
 * to an identity. A bid is only non-repudiable because of that signature, so
 * attributing it to a self-declared field would throw away the property.
 *
 * `null` for anything malformed: on a shared bus, a stray or hostile payload
 * is one dropped bid, never a thrown auction.
 */
export const parseBid = (payload: unknown, solverPubkey: string): SolverBid | null => {
    if (typeof payload !== "object" || payload === null) return null;
    const bid = payload as Record<string, unknown>;
    if (bid.type !== "rfq_bid" || bid.v !== 1) return null;
    if (typeof bid.open_id !== "string" || typeof bid.pair !== "string") return null;

    // A rate, not an amount: integral, and inside [0, 10⁴]. Outside that it is
    // not a spread at all, and a "bid" of 20 000 bps would rank as a price.
    if (typeof bid.fee_bps !== "number" || !Number.isInteger(bid.fee_bps)) return null;
    if (bid.fee_bps < 0 || bid.fee_bps > Number(BPS_DENOMINATOR)) return null;

    if (typeof bid.valid_until !== "number" || !Number.isFinite(bid.valid_until)) return null;

    // OPTIONAL, and omitted means zero — a corridor charging no flat component
    // publishes exactly the bytes it published before the field existed.
    const feeFlat = bid.fee_flat === undefined ? 0n : parseWireAmount(bid.fee_flat);
    const min = parseWireAmount(bid.min);
    const max = parseWireAmount(bid.max);
    if (feeFlat === null || min === null || max === null) return null;
    if (min > max) return null;

    return {
        solverPubkey,
        openId: bid.open_id,
        pair: bid.pair,
        feeBps: bid.fee_bps,
        feeFlat,
        min,
        max,
        validUntil: bid.valid_until,
    };
};

/**
 * What an exact-OUT trade costs under this bid: the largest `from_amount` a
 * conforming quote may ask for a given `to_amount`.
 *
 * § 4.6: `from_amount ≤ ceil(to_amount · (1 + fee_bps/10⁴)) + fee_flat`.
 *
 * The CEILING is the spec's, not a choice — both sides must round the product
 * identically or a boundary quote conforms on one side and not the other. Done
 * in bigint throughout, because the whole reason § 2.1 encodes amounts as
 * strings is that an 18-decimal asset overruns a double long before it
 * overruns this.
 */
export const exactOutCost = (
    bid: Pick<SolverBid, "feeBps" | "feeFlat">,
    toAmount: bigint,
): bigint => {
    const scaled = toAmount * (BPS_DENOMINATOR + BigInt(bid.feeBps));
    // ceil(a / b) for non-negative integers.
    const ceiled = (scaled + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
    return ceiled + bid.feeFlat;
};

/**
 * What an exact-IN trade yields under this bid: the smallest `to_amount` a
 * conforming quote may pay out for a given `from_amount`.
 *
 * § 4.6: `to_amount ≥ floor((from_amount − fee_flat) · 10⁴ / (10⁴ + fee_bps))`.
 *
 * `null` when `from_amount` does not exceed `fee_flat`. That trade is
 * UNQUOTABLE rather than merely expensive — the payout would be zero or
 * negative — and the spec has the solver refuse it as `pricing_unavailable`.
 * Returning null keeps the client from ranking a bid on a payout that cannot
 * exist.
 */
export const exactInPayout = (
    bid: Pick<SolverBid, "feeBps" | "feeFlat">,
    fromAmount: bigint,
): bigint | null => {
    const net = fromAmount - bid.feeFlat;
    if (net <= 0n) return null;
    return (net * BPS_DENOMINATOR) / (BPS_DENOMINATOR + BigInt(bid.feeBps));
};

/** What the client asked for, as the ranking needs to see it. */
export interface OpenRfqTerms {
    pair: string;
    openId: string;
    /** Which leg `amount` fixes — the § 4.1 semantics, unchanged here. */
    amountSide: "from" | "to";
    amount: bigint;
}

/** A ranked bid and the number it was ranked on, so a caller can show its work. */
export interface RankedBid {
    bid: SolverBid;
    /**
     * Atomic units of the leg the client did NOT fix: what it pays for an
     * exact-out trade, what it receives for an exact-in one.
     */
    counterAmount: bigint;
}

/**
 * Rank the conforming bids, best first.
 *
 * Conformance is always evaluated on the TO leg (§ 4.6), which for an
 * exact-out request is `amount` itself and for an exact-in one is the payout
 * the bid implies — so an exact-in size is checked against the bounds only
 * after pricing, exactly as the spec describes.
 *
 * Dropped, and why each matters on a shared bus where anyone may reply:
 *  - a bid for another `open_id` or another `pair` — not an answer to this
 *  - one already past `valid_until` — a lapsed price is not a price
 *  - one whose TO-leg size falls outside `[min, max]`
 *  - one that cannot quote this size at all (exact-in under the flat fee)
 *
 * Ties break on the solver pubkey, so the ranking is deterministic rather than
 * dependent on relay arrival order — two runs over the same bids agree.
 */
export const rankBids = (
    bids: readonly SolverBid[],
    terms: OpenRfqTerms,
    now: number,
): RankedBid[] => {
    const ranked: RankedBid[] = [];

    for (const bid of bids) {
        if (bid.openId !== terms.openId || bid.pair !== terms.pair) continue;
        if (bid.validUntil <= now) continue;

        if (terms.amountSide === "to") {
            if (terms.amount < bid.min || terms.amount > bid.max) continue;
            ranked.push({ bid, counterAmount: exactOutCost(bid, terms.amount) });
        } else {
            const payout = exactInPayout(bid, terms.amount);
            if (payout === null) continue;
            if (payout < bid.min || payout > bid.max) continue;
            ranked.push({ bid, counterAmount: payout });
        }
    }

    // Exact-out ranks by what the client PAYS, ascending; exact-in by what it
    // RECEIVES, descending. Same field, opposite direction — which is why the
    // comparison reads off `amountSide` rather than being baked into the sort.
    const better = terms.amountSide === "to" ? -1 : 1;
    return ranked.sort((a, b) => {
        if (a.counterAmount !== b.counterAmount)
            return a.counterAmount < b.counterAmount ? better : -better;
        return a.bid.solverPubkey < b.bid.solverPubkey ? -1 : 1;
    });
};

/** The winning bid, or `null` when nothing conformed. */
export const pickBestBid = (
    bids: readonly SolverBid[],
    terms: OpenRfqTerms,
    now: number,
): RankedBid | null => rankBids(bids, terms, now)[0] ?? null;

/**
 * Build the `rfq_open` broadcast payload.
 *
 * Amounts go out in § 2.1 canonical string form — the client always publishes
 * the encoding the spec names, even though it accepts the legacy number form
 * when reading. Being liberal in what you accept does not mean being sloppy in
 * what you send.
 */
export const openRfqPayload = (input: {
    openId: string;
    pair: string;
    amountSide: "from" | "to";
    size: OpenRfqSize;
    bidsUntil?: number;
}): Record<string, unknown> => ({
    v: 1,
    type: "rfq_open",
    open_id: input.openId,
    pair: input.pair,
    amount_side: input.amountSide,
    ...("amount" in input.size
        ? { amount: formatWireAmount(input.size.amount) }
        : {
              size_bucket: {
                  min: formatWireAmount(input.size.sizeBucket.min),
                  max: formatWireAmount(input.size.sizeBucket.max),
              },
          }),
    // OPTIONAL: omitted means the client did not commit to a collection window.
    ...(input.bidsUntil === undefined ? {} : { bids_until: input.bidsUntil }),
});
