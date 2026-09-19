/**
 * What the two v2 swap rails share: the client seam, the quote arithmetic, and
 * the handle that observes a swap through core's four-state stream.
 *
 * A rail here is a thin adapter and deliberately nothing more. Persistence,
 * refunds, recovery and the outcome vocabulary all live behind the v2 client;
 * the rail's whole job is to turn a `PaymentRequest` into a `QuoteInput`, a
 * `Quote` into a receiver-exact `RouteQuote`, and a swap's outcome stream into
 * a `PaymentHandle`.
 *
 * Two boundaries are crossed here and both are named. Amounts narrow from P3's
 * `bigint` to core's `number` (see `client/sats.ts`). And a ranking estimate
 * meets a binding quote: `RouteQuote.fee` is documented as "a display and
 * ranking figure, not a guarantee" while a v2 `Quote` is verified before return
 * and expires. `PaymentOption.quote()` is lazy and `options()` never calls it,
 * so ranking is free — but a swap rail's `quote()` is an RFQ round trip that
 * discloses an invoice and an amount, and an app that ranks then quotes several
 * options would disclose to every solver. `available()` therefore **never
 * quotes**: it resolves, which is network-free against the cached snapshot.
 *
 * A held `RouteQuote` can outlive its `Quote` — core's shape carries no
 * `expiresAt` — and then `send()` throws `QuoteExpired` inside `makeHandle`'s
 * run, which core turns into a terminal `failed`. That stays: re-quoting inside
 * `send()` is the silent re-quote §3.2 forbids.
 */
import type { PaymentHandle, PaymentStatus, RouteResult } from "@arkade-os/sdk";
import { makeHandle } from "@arkade-os/sdk";
import { isSwapError } from "../client/errors";
import type { Outcome, SwapUpdate, Unsubscribe } from "../client/outcome";
import type { Quote, QuoteInput, RouteResolution } from "../client/quote";
import type { Swap } from "../client/record";
import { satsOf } from "../client/sats";
import { isTerminalStatus, paymentStatusOf } from "./status";

/**
 * The slice of `SwapClient` a rail uses.
 *
 * Structural and minimal, so what a rail can reach is visible in one place and
 * a test can stand in for it without a wallet, a repository or a solver behind
 * it. A full `SwapClient` satisfies it.
 */
export interface SwapRailClient {
    resolve(input: QuoteInput): Promise<RouteResolution>;
    quote(input: QuoteInput): Promise<Quote>;
    accept(quote: Quote): Promise<Swap>;
    onUpdate(fn: (update: SwapUpdate) => void): Unsubscribe;
}

/**
 * A payment that ended in something other than success.
 *
 * Not a member of §7's taxonomy and suffixed to say so: that taxonomy is thrown
 * *before* value moves, and this is an outcome reported after it did. It exists
 * to carry the {@link Outcome} onto the handle's terminal `error`, which is
 * where `refunded` and `lapsed` stay distinguishable after the four-state
 * projection has mapped both to `failed`.
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

/**
 * Whether a resolution refusal means "not routable" rather than "broken".
 *
 * `available()` answers false for the first and lets the second through, where
 * the router warns and drops the rail — which is the intended fallback and
 * louder than swallowing it here would be.
 */
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
 * The three receiver-exact numbers, checked against each other.
 *
 * `total === amount + fee` is core's contract and this is where a rail proves
 * it rather than asserting it in a comment: `amount` is what the recipient
 * gets, `fee` is what the rail and its counterparty charge on top, and `total`
 * is what leaves the wallet. A `Quote` whose give leg does not equal the take
 * leg plus the spread has broken an invariant M3 owns, and surfacing it here
 * beats quoting a number that would rank this rail against the collaborative
 * exit on a fee it does not charge.
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

/** What a rail reports back: the tagged swap id, and the wallet's own txid. */
const resultOf = (railId: string, swap: Swap): RouteResult => ({
    railId,
    // The tagged public form M6 minted — round-trippable to `client.swaps()`,
    // which is where the outcomes past this handle's terminal one are read.
    swapId: swap.id,
    // The transaction that left THIS wallet, which is what `txid` means on
    // every other rail. A swap's later legs — the solver's fill, the trader's
    // L1 claim — are the client's to report, not the handle's.
    ...(swap.fundingTxid === undefined ? {} : { txid: swap.fundingTxid }),
});

/**
 * Accept the quote, then observe it to its first terminal outcome.
 *
 * The handle's contract, stated once: it observes the payment up to and
 * including the first terminal outcome, and every recovery past that point is
 * observed on `client.onUpdate` — keyed by the tagged `RouteResult.swapId`, so
 * the two views join. `client.onUpdate` replays synchronously on subscribe, so
 * a swap that was already terminal by the time we subscribed still resolves.
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
                // `unsubscribe` is still undefined when the replay — which runs
                // INSIDE `onUpdate` — is itself terminal. The flag is what the
                // line after the subscription reads, and this call is what
                // covers every later transition.
                unsubscribe?.();
                if (status === "settled") {
                    emit({ status, result });
                    resolve(result);
                    return;
                }
                // Rejecting rather than emitting: `makeHandle` turns the
                // rejection into the terminal `failed` update itself, and its
                // `error` is where the outcome survives the projection.
                reject(new SwapPaymentFailedError(railId, update.outcome, update.swap));
            };
            unsubscribe = client.onUpdate(listener);
            if (finished) unsubscribe();
        });
    });
