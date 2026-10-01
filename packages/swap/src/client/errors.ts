/**
 * The §7 taxonomy, as typed errors. Every member is thrown before value moves, or not at all;
 * anything after funding is an outcome of the drive loop, not an exception. Each class names
 * the boundary it fires at.
 *
 * Members are bare condition nouns (`QuoteExpired`), matching `SwapRefusal`. Non-members keep the
 * `Error` suffix (`AssetIdError`, `AmountFormatError`: codec faults on caller input). v1's
 * `AddressMismatch` is not a member: it is the `lockup_address` case of
 * {@link QuoteVerificationFailed}.
 */
import type { NetworkName } from "@arkade-os/sdk";
import { SwapRefusal } from "../rfq";
import type { AssetId } from "./assetId";
import type { CorridorId } from "./corridor";

/**
 * A solver declined, with its closed-set reason. The protocol's own class, reused rather than
 * wrapped, so `instanceof` works across the v1/v2 seam.
 *
 * Boundary: the RFQ response, before anything is funded.
 */
export { SwapRefusal };

/**
 * The checks §3.1 runs on every quote, before it is returned. `responder` is delivered by the
 * transport but *run* as a check, so verification cannot be skipped by configuring a dev
 * transport that authenticates nobody. Published RFQ (§10) attributes bids by signature instead.
 */
export type QuoteCheck = "pair" | "lockup_address" | "invoice" | "refund_window" | "responder";

/**
 * `to` is underdetermined — it parses as nothing, as more than one thing, or as one thing the
 * corridor that owns it refuses (a `tb1…` on mainnet, another operator's Arkade address, a
 * bolt11 the decoder rejects). The refusal rides on `detail`.
 *
 * A destination core classifies but no module claims (an LNURL today) is NOT this: it becomes
 * {@link UnsupportedRoute}.
 *
 * Boundary: `resolve()`/`quote()`, the single place `to` is parsed.
 */
export class AmbiguousDestination extends Error {
    override readonly name = "AmbiguousDestination";
    constructor(
        readonly destination: string,
        detail: string,
    ) {
        super(`cannot route ${JSON.stringify(destination)}: ${detail}`);
    }
}

/**
 * The corridor pair is not in the implemented route union — `onchain -> arkade`
 * included, until the manager owns the trader's L1 refund path end to end.
 *
 * Boundary: route resolution, before RFQ disclosure, artifact creation, persistence or funding.
 * Also the alias layer (a rail no corridor serves), and `quote()` when no discovered market
 * serves the pair on the active snapshot.
 */
export class UnsupportedRoute extends Error {
    override readonly name = "UnsupportedRoute";
    readonly give: CorridorId | undefined;
    readonly take: CorridorId | undefined;
    constructor(detail: string, corridors: { give?: CorridorId; take?: CorridorId } = {}) {
        super(`unsupported route: ${detail}`);
        this.give = corridors.give;
        this.take = corridors.take;
    }
}

/**
 * No market data: neither an injected nor a cached snapshot. For offline resolution, warm or
 * inject a snapshot.
 *
 * Boundary: `resolve()`, and `quote()` when its permitted fetch also yields nothing (no registry
 * configured, an unindexed network, or an unreachable registry with no cache).
 */
export class DiscoverySnapshotUnavailable extends Error {
    override readonly name = "DiscoverySnapshotUnavailable";
    constructor(
        readonly network: NetworkName,
        detail: string,
    ) {
        super(`cannot resolve on ${network} offline: ${detail}`);
    }
}

/**
 * Two amounts are pinned. Exactly one may be: the caller's `amount` +
 * `amountOn`, or the invoice's.
 *
 * Boundary: `quote()`, before any network round trip.
 */
export class AmountMismatch extends Error {
    override readonly name = "AmountMismatch";
    constructor(readonly sources: readonly [string, string]) {
        super(`exactly one amount may be pinned; got ${sources[0]} and ${sources[1]}`);
    }
}

/**
 * The amount cannot cross this encoding without an unsafe narrowing — a quote
 * field arriving as a JSON number past 2^53, a non-canonical decimal string, or
 * a `bigint` too large for a foreign `number` amount.
 *
 * Boundary: the RFQ adapter, both directions; core's payment rails.
 */
export class AmountEncodingUnsupported extends Error {
    override readonly name = "AmountEncodingUnsupported";
    constructor(
        readonly field: string,
        readonly value: string,
        detail: string,
        options?: ErrorOptions,
    ) {
        super(`${field}: ${detail}`, options);
    }
}

/**
 * A solver response failed a local check (see {@link QuoteCheck}); v1's `AddressMismatch` is the
 * `lockup_address` case.
 *
 * Boundary: `quote()`, before the quote is returned and so before funding.
 */
export class QuoteVerificationFailed extends Error {
    override readonly name = "QuoteVerificationFailed";
    readonly expected: string | undefined;
    readonly actual: string | undefined;
    constructor(
        readonly check: QuoteCheck,
        expected?: string,
        actual?: string,
        /** The gate or derivation this folds in, kept as the `cause` chain. */
        options?: ErrorOptions,
    ) {
        super(`quote failed the ${check} check — refusing to fund`, options);
        this.expected = expected;
        this.actual = actual;
    }
}

/**
 * A quote past its TTL, or so close to it that acting on it is the same thing. At `accept()` the
 * client never silently re-quotes, since the price seen is not the price one would get. At
 * `quote()` a quote arriving with less than `policy.quoteTtlFloorSeconds` left is expired on
 * arrival.
 *
 * Boundary: `quote()`, against the policy floor; `accept()`, before persistence.
 */
export class QuoteExpired extends Error {
    override readonly name = "QuoteExpired";
    constructor(
        readonly quoteId: string,
        readonly expiresAt: number,
        readonly now: number,
    ) {
        super(`quote ${quoteId} expired at ${expiresAt}, ${now - expiresAt} ago`);
    }
}

/**
 * The quote's fee is over the verb's ceiling. Carries the terms rather than the `Quote`; to
 * re-present them, call `quote()` again.
 *
 * Boundary: the verbs layer, between `quote` and `accept` — before funding.
 */
export class MaxFeeExceeded extends Error {
    override readonly name = "MaxFeeExceeded";
    constructor(
        readonly quoteId: string,
        readonly asset: AssetId,
        readonly fee: bigint,
        readonly maxFee: bigint,
    ) {
        super(`fee ${fee} of ${asset} exceeds the ${maxFee} ceiling`);
    }
}

/**
 * The wallet cannot fund the give leg.
 *
 * Boundary: `accept()`, before persistence and funding.
 */
export class InsufficientFunds extends Error {
    override readonly name = "InsufficientFunds";
    readonly available: bigint | undefined;
    constructor(
        readonly asset: AssetId,
        readonly required: bigint,
        available?: bigint,
    ) {
        super(
            `funding needs ${required} of ${asset}` +
                (available === undefined ? "" : `, wallet holds ${available}`),
        );
        this.available = available;
    }
}

/**
 * A quote id maps to a persisted accept record that contradicts it. Only
 * incompatible *durable evidence* qualifies — an ordinary duplicate `accept()`
 * returns or resumes the original swap, and a funding txid appearing where there
 * was none is a benign resume.
 *
 * Boundary: `accept()`, on the persisted record, before any second funding.
 */
export class AcceptConflict extends Error {
    override readonly name = "AcceptConflict";
    constructor(
        readonly quoteId: string,
        readonly swapId: string,
        readonly fields: readonly string[],
    ) {
        super(`accept ${quoteId} conflicts with swap ${swapId} on ${fields.join(", ")}`);
    }
}

/**
 * A method called after async disposal. Disposal is terminal for the instance;
 * the durable records survive it and a new client resumes them.
 *
 * Boundary: every client method, before it does anything.
 */
export class ClientDisposed extends Error {
    override readonly name = "ClientDisposed";
    constructor(readonly method: string) {
        super(`${method}() called after the client was disposed`);
    }
}

/**
 * `cancel()` on a swap this client cannot cancel. Only an unfilled offer is cancellable (an offer
 * covenant never expires); an HTLC's exits are a claim or a refund. Also thrown for an `offer:`
 * or untagged id no record backs — "no such swap" is the same condition.
 *
 * Boundary: `cancel()`.
 */
export class NotCancellable extends Error {
    override readonly name = "NotCancellable";
    constructor(readonly swapId: string) {
        super(`swap ${swapId} is not a cancellable asset swap`);
    }
}

/**
 * A destination disagrees with its asset's chain. Inert: only §9's deferred EVM corridor could
 * throw it, so it is the one declared error with no throwing site today.
 */
export class InconsistentRoute extends Error {
    override readonly name = "InconsistentRoute";
    constructor(
        readonly asset: AssetId,
        readonly destination: string,
    ) {
        super(`destination ${JSON.stringify(destination)} is not on ${asset}'s chain`);
    }
}

/**
 * `getArkadeInfo({ requireLive: true })` failed while deriving a covenant. A
 * snapshot would bind the covenant to a signer key the operator may no longer
 * co-sign for, so this fails closed rather than falling back.
 *
 * Boundary: `quote()`, at covenant derivation — before funding.
 */
export class OperatorUnreachable extends Error {
    override readonly name = "OperatorUnreachable";
    constructor(detail: string, options?: ErrorOptions) {
        super(`cannot derive a covenant: ${detail}`, options);
    }
}

/**
 * A corridor's dependency was explicitly overridden to nothing (`null`; `undefined` takes the
 * default), or is required on this network and absent — e.g. the arkade co-signer key on
 * `testnet`/`signet`, which `EMULATOR_PUBKEYS` does not pin.
 *
 * Boundary: dep resolution, when a route first touches that corridor. Never construction: a
 * missing dep for a corridor nobody uses is not an error.
 */
export class MissingCorridorDep extends Error {
    override readonly name = "MissingCorridorDep";
    constructor(
        readonly corridor: CorridorId,
        readonly dep: string,
    ) {
        super(`the ${corridor} corridor has no ${dep}`);
    }
}

/** Every member of the taxonomy. */
export type SwapError =
    | AmbiguousDestination
    | UnsupportedRoute
    | DiscoverySnapshotUnavailable
    | AmountMismatch
    | AmountEncodingUnsupported
    | QuoteVerificationFailed
    | SwapRefusal
    | QuoteExpired
    | MaxFeeExceeded
    | InsufficientFunds
    | AcceptConflict
    | ClientDisposed
    | NotCancellable
    | InconsistentRoute
    | OperatorUnreachable
    | MissingCorridorDep;

/** The sixteen names. Derived, so there is no second list to drift. */
export type SwapErrorName = SwapError["name"];

/**
 * Name to class. The `satisfies` makes drift a compile error: a missing member fails the
 * `Record`, an extra key the excess-property check, a mismatched `name` both.
 */
const SWAP_ERRORS = {
    AmbiguousDestination,
    UnsupportedRoute,
    DiscoverySnapshotUnavailable,
    AmountMismatch,
    AmountEncodingUnsupported,
    QuoteVerificationFailed,
    SwapRefusal,
    QuoteExpired,
    MaxFeeExceeded,
    InsufficientFunds,
    AcceptConflict,
    ClientDisposed,
    NotCancellable,
    InconsistentRoute,
    OperatorUnreachable,
    MissingCorridorDep,
} as const satisfies Record<SwapErrorName, new (...args: never[]) => SwapError>;

/** The sixteen, as values — what the coverage pass counts. */
export const SWAP_ERROR_NAMES = Object.keys(SWAP_ERRORS) as readonly SwapErrorName[];

/**
 * Whether `e` belongs to the taxonomy, optionally narrowed to one member. Catalog-driven, and
 * rejects an impostor: a foreign error merely named `QuoteExpired` fails the constructor check.
 */
export function isSwapError(e: unknown): e is SwapError;
export function isSwapError<N extends SwapErrorName>(
    e: unknown,
    name: N,
): e is Extract<SwapError, { name: N }>;
export function isSwapError(e: unknown, name?: SwapErrorName): boolean {
    if (!(e instanceof Error)) return false;
    const table: Record<string, new (...args: never[]) => SwapError> = SWAP_ERRORS;
    const ctor = table[e.name];
    if (ctor === undefined || !(e instanceof ctor)) return false;
    return name === undefined || e.name === name;
}
