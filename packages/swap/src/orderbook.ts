/**
 * Deterministic, integer-only planning for a book of full-fill Arkade offers.
 *
 * This module deliberately stops at transaction construction. A book may be
 * untrusted input; the covenant remains the authority for whether every input
 * can be spent and which output it requires. The planner only chooses offers
 * and totals their already-committed amounts.
 */

/** A funded offer visible to an order-book indexer. Amounts are base units. */
export interface BookOffer {
    /** Funding transaction id (and therefore the stable identity of a deposit). */
    fundingTxid: string;
    /** Asset deposited by the user. Use `BTC` for sats. */
    offerAsset: string;
    offerAmount: bigint;
    /** Asset the user must receive when this input is filled. */
    wantAsset: string;
    wantAmount: bigint;
    /** Optional output index; Arkade offer deposits conventionally use zero. */
    vout?: number;
}

/** One atomic input selected from the book. */
export interface BookFill {
    fundingTxid: string;
    vout: number;
    takeAmount: bigint;
    payAmount: bigint;
}

export interface BookSweep {
    fills: BookFill[];
    /** Sum delivered to the taker. */
    takeAmount: bigint;
    /** Sum of the deterministic covenant outputs owed to makers. */
    payAmount: bigint;
}

const positive = (value: bigint, name: string): void => {
    if (value <= 0n) throw new Error(`${name} must be positive`);
};

const assertOffer = (offer: BookOffer): void => {
    if (!offer.fundingTxid) throw new Error("fundingTxid is required");
    if (!offer.offerAsset || !offer.wantAsset || offer.offerAsset === offer.wantAsset) {
        throw new Error("an offer must exchange two different assets");
    }
    positive(offer.offerAmount, "offerAmount");
    positive(offer.wantAmount, "wantAmount");
    if (offer.vout !== undefined && (!Number.isSafeInteger(offer.vout) || offer.vout < 0)) {
        throw new Error("vout must be a non-negative safe integer");
    }
};

/**
 * Compare prices without floating point. Lower `wantAmount / offerAmount` is
 * better for the taker. The txid and vout tie-break make every client produce
 * the same sweep from the same snapshot, regardless of relay arrival order.
 */
export function compareBookOffers(a: BookOffer, b: BookOffer): number {
    assertOffer(a);
    assertOffer(b);
    const left = a.wantAmount * b.offerAmount;
    const right = b.wantAmount * a.offerAmount;
    if (left !== right) return left < right ? -1 : 1;
    const txid = a.fundingTxid < b.fundingTxid ? -1 : a.fundingTxid > b.fundingTxid ? 1 : 0;
    return txid || (a.vout ?? 0) - (b.vout ?? 0);
}

/**
 * Select whole covenant UTXOs at the best available price.
 *
 * Offers are indivisible: the final offer may take the result above `minimumTake`.
 * This is intentional. Inventing a partial output would no longer satisfy the
 * full-fill covenant. All returned inputs can instead be spent atomically in a
 * single transaction with one deterministic maker output per input.
 */
export function planBookSweep(
    offers: readonly BookOffer[],
    offerAsset: string,
    wantAsset: string,
    minimumTake: bigint,
): BookSweep {
    positive(minimumTake, "minimumTake");
    if (!offerAsset || !wantAsset || offerAsset === wantAsset) {
        throw new Error("a market must contain two different assets");
    }

    const candidates = offers.filter(
        (offer) => offer.offerAsset === offerAsset && offer.wantAsset === wantAsset,
    );
    for (const offer of candidates) assertOffer(offer);
    candidates.sort(compareBookOffers);

    const fills: BookFill[] = [];
    const selected = new Set<string>();
    let takeAmount = 0n;
    let payAmount = 0n;
    for (const offer of candidates) {
        const outpoint = `${offer.fundingTxid}:${offer.vout ?? 0}`;
        if (selected.has(outpoint)) throw new Error(`duplicate book outpoint: ${outpoint}`);
        selected.add(outpoint);
        fills.push({
            fundingTxid: offer.fundingTxid,
            vout: offer.vout ?? 0,
            takeAmount: offer.offerAmount,
            payAmount: offer.wantAmount,
        });
        takeAmount += offer.offerAmount;
        payAmount += offer.wantAmount;
        if (takeAmount >= minimumTake) break;
    }

    if (takeAmount < minimumTake) {
        throw new Error(
            `insufficient book depth: ${takeAmount} available, ${minimumTake} required`,
        );
    }
    return { fills, takeAmount, payAmount };
}
