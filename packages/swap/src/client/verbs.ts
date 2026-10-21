/**
 * The three product-facing verbs: `pay`, `receive` and `exchange` each compile a
 * {@link QuoteInput}, `quote`, enforce a fee ceiling, and `accept`.
 *
 * `receive` returns only after `accept()` has persisted, so a caller cannot show a payer
 * an invoice whose claim secret exists only in memory.
 */
import type { IWallet } from "@arkade-os/sdk";
import { arkTarget, resolveSendAmount } from "@arkade-os/sdk";
import { sameAsset, type AssetId } from "./assetId";
import type { CorridorId } from "./corridor";
import { MaxFeeExceeded } from "./errors";
import type { AmountOn } from "./rfqAmount";
import type { AssetRef, Quote, QuoteInput } from "./quote";
import type { Swap } from "./record";
import type { DepositArtifact } from "./route";
import { satsOf } from "./sats";

/**
 * A fee ceiling: an amount, and the asset it is denominated in.
 *
 * The fee is on the give leg for corridor routes and the take leg for asset swaps, so a
 * bare `bigint` names no asset. A ceiling in another asset than the fee's is refused,
 * never converted: the SDK holds no rate. Same shape as {@link SwapPolicy.maxFee}.
 */
export interface FeeCeiling {
    readonly amount: bigint;
    readonly asset: AssetId;
}

/** What `pay` takes beside the destination. */
export interface PayOptions {
    /** Atomic units delivered to the recipient. Omitted when the destination pins it;
     * passing one beside an amount-bearing invoice is `AmountMismatch`. */
    readonly amount?: bigint;
    readonly maxFee?: FeeCeiling;
}

/**
 * What `receive` takes. `via` names the corridor because a receive has no instrument to
 * parse: the instrument is the artifact the solver mints in the quote.
 */
export interface ReceiveOptions {
    /** Atomic units the trader receives. */
    readonly amount: bigint;
    readonly via: CorridorId;
    /** §9.5, reserved: the asset arriving, where a corridor carries more than one. */
    readonly asset?: AssetRef;
    readonly maxFee?: FeeCeiling;
}

/** What `exchange` takes: {@link QuoteInput} minus `to` and `via`, plus the ceiling. */
export interface ExchangeOptions {
    readonly give?: AssetRef;
    readonly take?: AssetRef;
    readonly amount?: bigint;
    readonly amountOn?: AmountOn;
    readonly maxFee?: FeeCeiling;
}

/**
 * The artifact a receive over corridor `C` comes back with: an invoice on `lightning`,
 * a deposit otherwise. The conditional lets `receive({ via: "lightning" }).artifact.bolt11`
 * compile without a manual `kind` check; distributed over `C` like {@link DepositArtifact}.
 */
export type ReceiveArtifact<C extends CorridorId = CorridorId> = C extends CorridorId
    ? C extends "lightning"
        ? { kind: "invoice"; bolt11: string }
        : DepositArtifact<C>
    : never;

/** What `receive` answers with: a {@link Swap} whose (otherwise optional) artifact is
 * guaranteed. */
export type ReceiveRequest<C extends CorridorId = CorridorId> = Swap & {
    readonly artifact: ReceiveArtifact<C>;
};

/**
 * What `pay` answers with. A bolt11 or `bc1…` crosses a corridor and yields a
 * {@link Swap}; a plain Arkade address is a plain payment and yields only a txid.
 */
export type PayResult =
    | { readonly kind: "swap"; readonly swap: Swap }
    | { readonly kind: "payment"; readonly txid: string };

/** What a verb needs from the client it hangs off. */
export interface VerbDeps {
    readonly wallet: IWallet;
    quote(input: QuoteInput): Promise<Quote>;
    accept(quote: Quote): Promise<Swap>;
    /** {@link SwapPolicy.maxFee}, when the client was configured with one. */
    readonly policyMaxFee?: FeeCeiling;
}

/**
 * Enforce the effective ceiling: the **minimum** of the call's and the policy's, so
 * neither can raise the other. Both absent means no ceiling.
 *
 * @throws {Error} when a ceiling is in another asset than the fee (caller input, not a
 *   swap condition).
 * @throws {MaxFeeExceeded} when `quote.fee` is over the effective ceiling —
 *   between `quote` and `accept`, so nothing was funded.
 */
export const enforceFeeCeiling = (
    quote: Quote,
    call: FeeCeiling | undefined,
    policy: FeeCeiling | undefined,
): void => {
    let ceiling: bigint | undefined;
    for (const [source, limit] of [
        ["maxFee", call],
        ["policy.maxFee", policy],
    ] as const) {
        if (limit === undefined) continue;
        if (!sameAsset(limit.asset, quote.fee.asset)) {
            throw new Error(
                `${source} is denominated in ${limit.asset} and the quote's fee in ` +
                    `${quote.fee.asset} — no rate converts one ceiling into the other`,
            );
        }
        ceiling = ceiling === undefined || limit.amount < ceiling ? limit.amount : ceiling;
    }
    if (ceiling !== undefined && quote.fee.amount > ceiling) {
        throw new MaxFeeExceeded(quote.id, quote.fee.asset, quote.fee.amount, ceiling);
    }
};

/** quote -> ceiling -> accept, which is every verb's whole body. */
const settle = async (
    deps: VerbDeps,
    input: QuoteInput,
    maxFee: FeeCeiling | undefined,
): Promise<Swap> => {
    const quote = await deps.quote(input);
    enforceFeeCeiling(quote, maxFee, deps.policyMaxFee);
    return deps.accept(quote);
};

/**
 * Pay a destination: a bolt11, a `bc1…`, or a plain Arkade address.
 *
 * The Arkade arm uses core's own parse (so it classifies exactly as the `ark` rail does)
 * and settles through `wallet.send`: fee 0, nothing quoted or persisted.
 */
export const pay = async (
    deps: VerbDeps,
    destination: string,
    options: PayOptions = {},
): Promise<PayResult> => {
    const arkade = arkTarget(destination);
    if (arkade !== undefined) {
        // Core's own amount law, so refusals match the `ark` rail's.
        const amount = resolveSendAmount(
            "ark",
            destination,
            options.amount === undefined ? undefined : satsOf(options.amount, "amount"),
        );
        return { kind: "payment", txid: await deps.wallet.send({ address: arkade, amount }) };
    }
    const swap = await settle(
        deps,
        {
            to: destination,
            // The amount beside a destination is what the recipient gets.
            ...(options.amount === undefined ? {} : { amount: options.amount, amountOn: "take" }),
        },
        options.maxFee,
    );
    return { kind: "swap", swap };
};

/**
 * Ask for an incoming payment over `via`, and get back the artifact to show.
 *
 * @throws {Error} if the accepted swap carries no artifact.
 */
export const receive = async <C extends CorridorId = CorridorId>(
    deps: VerbDeps,
    options: ReceiveOptions & { readonly via: C },
): Promise<ReceiveRequest<C>> => {
    const swap = await settle(
        deps,
        {
            via: options.via,
            ...(options.asset === undefined ? {} : { take: options.asset }),
            amount: options.amount,
            // "Credit me this much", not "let the payer send this much".
            amountOn: "take",
        },
        options.maxFee,
    );
    if (swap.artifact === undefined) {
        throw new Error(
            `receive over ${options.via} returned no artifact — there is nothing to show a payer`,
        );
    }
    // `options.via` pins the artifact's kind via the route, which `Quote.artifact`'s type
    // cannot express; the cast states it.
    return swap as ReceiveRequest<C>;
};

/** Swap one Arkade asset for another. */
export const exchange = async (deps: VerbDeps, options: ExchangeOptions): Promise<Swap> =>
    settle(
        deps,
        {
            ...(options.give === undefined ? {} : { give: options.give }),
            ...(options.take === undefined ? {} : { take: options.take }),
            ...(options.amount === undefined ? {} : { amount: options.amount }),
            ...(options.amountOn === undefined ? {} : { amountOn: options.amountOn }),
        },
        options.maxFee,
    );
