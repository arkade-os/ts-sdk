export const RFQ_BROADCAST_KIND = 24860;

export interface OpenRfqRequest {
    readonly openId: string;
    readonly pair: string;
    readonly amountSide: "from" | "to";
    readonly amount: bigint;
    readonly bidsUntil: number;
}

export interface OpenRfqBid {
    readonly id: string;
    readonly solverPubkey: string;
    readonly openId: string;
    readonly pair: string;
    readonly amountSide: "from" | "to";
    readonly fromAmount: bigint;
    readonly toAmount: bigint;
    readonly validUntil: number;
    readonly card: unknown;
}

const idPattern = /^[a-f0-9]{64}$/;
const pairPattern = /^[a-zA-Z0-9:/._%-]{1,256}->[a-zA-Z0-9:/._%-]{1,256}$/;
const hexKey = /^[a-f0-9]{64}$/;
const positiveAtomic = (value: unknown): bigint | undefined =>
    typeof value === "string" && /^[1-9][0-9]{0,127}$/.test(value) ? BigInt(value) : undefined;
const positiveSeconds = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export const openRfqPayload = (request: OpenRfqRequest) => {
    if (
        !idPattern.test(request.openId) ||
        !pairPattern.test(request.pair) ||
        (request.amountSide !== "from" && request.amountSide !== "to") ||
        typeof request.amount !== "bigint" ||
        positiveAtomic(request.amount.toString()) === undefined ||
        !positiveSeconds(request.bidsUntil)
    )
        throw new Error("invalid open RFQ request");
    return {
        v: 1,
        type: "rfq_open",
        open_id: request.openId,
        pair: request.pair,
        amount_side: request.amountSide,
        amount: request.amount.toString(),
        bids_until: request.bidsUntil,
    } as const;
};

export const parseOpenRfqBid = (
    payload: unknown,
    solverPubkey: string,
    eventId: string,
): OpenRfqBid | null => {
    if (
        !payload ||
        typeof payload !== "object" ||
        !hexKey.test(solverPubkey) ||
        !hexKey.test(eventId)
    )
        return null;
    const value = payload as Record<string, unknown>;
    const fromAmount = positiveAtomic(value.from_amount);
    const toAmount = positiveAtomic(value.to_amount);
    if (
        value.v !== 1 ||
        value.type !== "rfq_bid" ||
        typeof value.open_id !== "string" ||
        !idPattern.test(value.open_id) ||
        typeof value.pair !== "string" ||
        !pairPattern.test(value.pair) ||
        (value.amount_side !== "from" && value.amount_side !== "to") ||
        fromAmount === undefined ||
        toAmount === undefined ||
        !positiveSeconds(value.valid_until) ||
        !value.card ||
        typeof value.card !== "object" ||
        Array.isArray(value.card)
    )
        return null;
    return {
        id: eventId,
        solverPubkey,
        openId: value.open_id,
        pair: value.pair,
        amountSide: value.amount_side,
        fromAmount,
        toAmount,
        validUntil: value.valid_until,
        card: value.card,
    };
};

export const rankOpenRfqBids = (
    bids: readonly OpenRfqBid[],
    amountSide: "from" | "to",
): OpenRfqBid[] =>
    [...bids].sort((left, right) => {
        const difference =
            amountSide === "from"
                ? right.toAmount - left.toAmount
                : left.fromAmount - right.fromAmount;
        return difference < 0n
            ? -1
            : difference > 0n
              ? 1
              : left.solverPubkey.localeCompare(right.solverPubkey) ||
                left.id.localeCompare(right.id);
    });
