/**
 * The three product-facing verbs, and the one thing they add.
 *
 * `pay`, `receive` and `exchange` compile a {@link QuoteInput}, call `quote`,
 * check `quote.fee` against a ceiling and call `accept`. Everything they call
 * was built in M3–M6; what they add is the ceiling — and what they subtract is
 * vocabulary. A product integrating payments never sees the words route,
 * corridor, market or quote.
 *
 * The verbs are deliberately thin, and one asymmetry is the reason they exist
 * at all: `receive` is what makes the artifact's exposure order unlosable. It
 * returns only after `accept()` has persisted, so a caller cannot show a payer
 * an invoice whose claim secret is still in memory — the ordering M4 bought,
 * stated in a signature.
 *
 * §5's fourth row — `pay` to a plain Arkade address — is not a swap and must
 * not become one. It delegates: same asset, same rail, rate 1, nothing swapped.
 * See {@link PayResult}.
 */
import type { IWallet } from "@arkade-os/sdk";
import { arkTarget, resolveSendAmount } from "@arkade-os/sdk";
import { sameAsset, type AssetId } from "./assetId";
import type { CorridorId } from "./corridor";
import { MaxFeeExceeded } from "./errors";
import type { AmountOn } from "./rfqAmount";
import type { AssetRef, Quote, QuoteInput } from "./quote";
import type { Swap } from "./record";
import type { Artifact } from "./route";
import { satsOf } from "./sats";

/**
 * A fee ceiling: an amount, and the asset it is denominated in.
 *
 * The asset is not ceremony. M3/D denominates the fee on the give leg on
 * corridor routes and on the take leg on asset swaps, so a bare `bigint` names
 * no asset — and on `exchange` the caller cannot know which leg carries it
 * before quoting. A ceiling whose asset is not the fee's is a refusal rather
 * than a conversion: the SDK holds no rate, and inventing one to compare two
 * numbers is how a ceiling silently stops being one.
 *
 * The same shape on every verb and on {@link SwapPolicy.maxFee}, so the call
 * ceiling and the policy ceiling it is taken against are comparable without a
 * translation.
 */
export interface FeeCeiling {
    readonly amount: bigint;
    readonly asset: AssetId;
}

/**
 * What `pay` takes beside the destination.
 *
 * `amount` is what the *recipient* gets, and it is omitted exactly when the
 * destination pins it — an amount-bearing bolt11 does, and passing one beside
 * it is `AmountMismatch`. §9.5's EVM destinations grow a required `take` here;
 * they are deferred, so it is not declared yet.
 */
export interface PayOptions {
    /** Atomic units delivered to the recipient. Omitted when an invoice pins it. */
    readonly amount?: bigint;
    readonly maxFee?: FeeCeiling;
}

/**
 * What `receive` takes.
 *
 * `via` names the corridor because a receive has no instrument to parse — the
 * instrument *is* the artifact the solver mints, and it does not exist until
 * the quote comes back. `asset` is reserved for §9.5's EVM form: on the
 * implemented corridors the corridor carries BTC and nothing else, so naming
 * one would be a fact with nothing to disagree with.
 */
export interface ReceiveOptions {
    /** Atomic units the trader receives. */
    readonly amount: bigint;
    readonly via: CorridorId;
    /** §9.5, reserved: the asset arriving, where a corridor carries more than one. */
    readonly asset?: AssetRef;
    readonly maxFee?: FeeCeiling;
}

/**
 * What `exchange` takes: {@link QuoteInput} minus `to` and `via`, plus the
 * ceiling.
 *
 * Thin because `exchange` hides the two-step, not the vocabulary — an asset
 * swap names both assets by construction, and there is nothing left to infer.
 */
export interface ExchangeOptions {
    readonly give?: AssetRef;
    readonly take?: AssetRef;
    readonly amount?: bigint;
    readonly amountOn?: AmountOn;
    readonly maxFee?: FeeCeiling;
}

/**
 * What `receive` answers with: a {@link Swap} whose artifact is a guarantee
 * rather than a maybe.
 *
 * An intersection rather than a parallel record, because that is where the
 * guarantee gets *stated*: `Quote.artifact` and `Swap.artifact` are optional —
 * three of the four routes have nothing a counterparty must see — and a receive
 * always has one. Narrowing the field on the base type is not open to an
 * intersection, so this is the shape that says it.
 */
export type ReceiveRequest = Swap & { readonly artifact: Artifact };

/**
 * What `pay` answers with.
 *
 * Two arms, because §5's four destination rows are not four swaps. A bolt11 and
 * a `bc1…` cross a corridor and produce a {@link Swap}; a plain Arkade address
 * is a plain Arkade payment and produces a txid and no swap id. Manufacturing a
 * `Swap` for the second would be a swap record for something nothing swapped —
 * same asset, same rail, rate 1 — and rejecting it instead would put a branch in
 * every product's one pay box rather than once here.
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
 * The effective ceiling, and the refusal when the quote is over it.
 *
 * The effective ceiling is the **minimum** of the call's and the policy's: a
 * policy ceiling a call could raise would be decorative, and a call ceiling a
 * policy could raise would make the tighter of two explicit instructions lose.
 * Either may be absent; both absent means no ceiling, which is the documented
 * default and not a zero.
 *
 * A ceiling denominated in another asset is refused as caller input rather than
 * as a member of §7's taxonomy: the taxonomy's members are conditions of the
 * swap, and this is a field naming the wrong unit — the same rule that keeps
 * "amount needs amountOn" a plain `Error`.
 *
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
 * The Arkade arm is checked first and against core's own parse, so a bare
 * address and a BIP21 `ark=` param behave identically here and in the `ark`
 * rail — one classification, not two that can drift. It settles through
 * `wallet.send`, which is what the `ark` rail settles through: fee 0 and
 * receiver-exact for free, with nothing to quote and nothing to persist.
 */
export const pay = async (
    deps: VerbDeps,
    destination: string,
    options: PayOptions = {},
): Promise<PayResult> => {
    const arkade = arkTarget(destination);
    if (arkade !== undefined) {
        // Core's own amount law, so an amountless `ark:` URI is refused in the
        // same words the `ark` rail refuses it in.
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
            // `amountOn: "take"` because the number a caller writes beside a
            // destination is what the recipient gets. An invoice pins the same
            // leg by existing, which is why passing both is `AmountMismatch`.
            ...(options.amount === undefined ? {} : { amount: options.amount, amountOn: "take" }),
        },
        options.maxFee,
    );
    return { kind: "swap", swap };
};

/**
 * Ask for an incoming payment over `via`, and get back the artifact to show.
 *
 * The artifact is non-optional on the return type and the assertion behind it
 * is real: a receive route has one by construction, and a client that answered
 * without one has failed rather than answered.
 */
export const receive = async (deps: VerbDeps, options: ReceiveOptions): Promise<ReceiveRequest> => {
    const swap = await settle(
        deps,
        {
            via: options.via,
            ...(options.asset === undefined ? {} : { take: options.asset }),
            amount: options.amount,
            // The trader's side is the take leg: `receive({ amount })` is
            // "credit me this much", not "let the payer send this much".
            amountOn: "take",
        },
        options.maxFee,
    );
    if (swap.artifact === undefined) {
        throw new Error(
            `receive over ${options.via} returned no artifact — there is nothing to show a payer`,
        );
    }
    return swap as ReceiveRequest;
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
