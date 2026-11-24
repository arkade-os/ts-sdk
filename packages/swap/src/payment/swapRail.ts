/**
 * What the two v2 swap rails share: the client seam, the quote arithmetic, and the handle that
 * observes a swap through core's four-state stream. A rail is a thin adapter; persistence, refunds,
 * recovery and outcomes live behind the v2 client.
 *
 * Amounts narrow from `bigint` to core's `number` here (see `client/sats.ts`). `available()`
 * **never quotes**: a swap rail's `quote()` is an RFQ round trip disclosing an invoice and amount, so
 * ranking must not call it — it resolves, network-free against the cached snapshot. A held
 * `RouteQuote` can outlive its `Quote` (core's shape has no `expiresAt`); `send()` then fails with
 * `QuoteExpired` rather than silently re-quoting.
 */
import type { PaymentHandle, PaymentStatus, RouteResult } from "@arkade-os/sdk";
import { makeHandle } from "@arkade-os/sdk";
import { isSwapError } from "../client/errors";
import type { Outcome, SwapUpdate, Unsubscribe } from "../client/outcome";
import type { Quote, QuoteInput, RouteResolution } from "../client/quote";
import type { Swap } from "../client/record";
import { satsOf } from "../client/sats";
import { isTerminalStatus, paymentStatusOf } from "./status";

/** The minimal structural slice of `SwapClient` a rail uses, so a test can stand in for it. */
export interface SwapRailClient {
    resolve(input: QuoteInput): Promise<RouteResolution>;
    quote(input: QuoteInput): Promise<Quote>;
    accept(quote: Quote): Promise<Swap>;
    onUpdate(fn: (update: SwapUpdate) => void): Unsubscribe;
}

/**
 * A payment that ended in something other than success. Not part of the error taxonomy (thrown
 * *before* value moves): this is an outcome reported after, carrying the {@link Outcome} so
 * `refunded` and `lapsed` stay distinguishable once both project to `failed`.
 */
export class SwapPaymentFailedError extends Error {
    override readonly name = "SwapPaymentFailedError";
    constructor(
        readonly railId: string,
        readonly outcome: Outcome,
        readonly swap: Swap,
    ) {
        super(
            `${railId}: swap ${swap.id} ended ${outcome}` +
                (swap.failure === undefined ? "" : `: ${swap.failure}`) +
                (swap.blockedReason === undefined ? "" : ` (${swap.blockedReason})`),
        );
    }
}

/** "Not routable" rather than "broken": other errors propagate so the router warns and drops the
 * rail, which is louder than swallowing them. */
const unroutable = (error: unknown): boolean =>
    isSwapError(error, "UnsupportedRoute") || isSwapError(error, "AmbiguousDestination");

/** `eligible > 0` for this input, or false for anything that will not route. */
export const railAvailable = async (
    client: SwapRailClient,
    input: QuoteInput,
): Promise<boolean> => {
    try {
        return (await client.resolve(input)).eligible > 0;
    } catch (error) {
        if (unroutable(error)) return false;
        throw error;
    }
};

/**
 * The three receiver-exact numbers, checked: `total === amount + fee` is core's contract (`amount`
 * delivered, `fee` on top, `total` leaving the wallet). A violation is surfaced rather than ranked
 * against the collaborative exit on a fee this rail does not charge.
 */
export const receiverExact = (
    railId: string,
    parts: { amount: bigint; fee: bigint; total: bigint },
): { amount: number; fee: number; total: number } => {
    if (parts.total !== parts.amount + parts.fee) {
        throw new Error(
            `${railId}: ${parts.total} leaving the wallet is not ${parts.amount} delivered ` +
                `plus ${parts.fee} in fees — the quote is not receiver-exact`,
        );
    }
    return {
        amount: satsOf(parts.amount, `${railId}.amount`),
        fee: satsOf(parts.fee, `${railId}.fee`),
        total: satsOf(parts.total, `${railId}.total`),
    };
};

/** The `RouteQuote.meta` both swap rails report; `expiresAt` because `RouteQuote` has none. */
export const quoteMeta = (quote: Quote) => ({
    quoteId: quote.id,
    expiresAt: quote.expiresAt,
    ...(quote.refundLocktime === undefined ? {} : { refundLocktime: quote.refundLocktime }),
    ...(quote.solver === undefined ? {} : { solver: quote.solver }),
    ...(quote.lock === undefined ? {} : { paymentHash: quote.lock.hash }),
    ...(quote.market.kind === "restored" ? {} : { market: quote.market.key }),
});

/** What a rail reports back: the tagged swap id, and the wallet's own txid. */
const resultOf = (railId: string, swap: Swap): RouteResult => ({
    railId,
    // tagged, so it joins `client.swaps()`/`onUpdate` for outcomes past this handle's terminal one
    swapId: swap.id,
    // the tx that left THIS wallet, as on every other rail; later legs are the client's to report
    ...(swap.fundingTxid === undefined ? {} : { txid: swap.fundingTxid }),
});

/**
 * Accept the quote, then observe it up to its first terminal outcome; recovery past that is observed
 * on `client.onUpdate`, keyed by the same `RouteResult.swapId`. `onUpdate` replays synchronously, so
 * an already-terminal swap still resolves.
 */
export const swapHandle = async (
    railId: string,
    client: SwapRailClient,
    quote: Quote,
): Promise<PaymentHandle> =>
    makeHandle(railId, async (emit) => {
        const accepted = await client.accept(quote);
        return await new Promise<RouteResult>((resolve, reject) => {
            let finished = false;
            let unsubscribe: Unsubscribe | undefined;
            const listener = (update: SwapUpdate): void => {
                if (finished || update.swap.id !== accepted.id) return;
                const status: PaymentStatus = paymentStatusOf(update.outcome);
                const result = resultOf(railId, update.swap);
                if (!isTerminalStatus(status)) {
                    emit({ status, result });
                    return;
                }
                finished = true;
                // still undefined when the replay (INSIDE `onUpdate`) is itself terminal; the
                // `finished` check after subscribing covers that case
                unsubscribe?.();
                if (status === "settled") {
                    emit({ status, result });
                    resolve(result);
                    return;
                }
                // reject, not emit: `makeHandle` turns it into the terminal `failed` update, and its
                // `error` is where the outcome survives the projection
                reject(new SwapPaymentFailedError(railId, update.outcome, update.swap));
            };
            unsubscribe = client.onUpdate(listener);
            if (finished) unsubscribe();
        });
    });
