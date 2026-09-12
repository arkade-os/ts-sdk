/**
 * The §7 taxonomy, as typed errors.
 *
 * The contract every member shares: it is thrown before value moves, or not at
 * all. Anything that can go wrong after funding is an outcome, not an exception,
 * and belongs to the drive loop instead. Each class names the boundary it fires
 * at, because that is the part a caller cannot infer from the name.
 *
 * Naming rule, and it cuts both ways. A member of this taxonomy is a bare
 * condition noun — `QuoteExpired`, `NotCancellable` — because `SwapRefusal` is
 * one and §8 keeps it unchanged, so a module holding all sixteen is bare or it
 * is the first mixed-convention module in the package. An error class that is
 * *not* a member keeps the `Error` suffix: `AssetIdError` and
 * `AmountFormatError` are codec faults on caller input, and the suffix is what
 * says so at the catch site.
 *
 * v1's `AddressMismatch` (`rfq.ts:163`) is deliberately not a seventeenth
 * member: M3 folds it into {@link QuoteVerificationFailed}'s `lockup_address`
 * check, and M8 gives it the `/protocol` re-export and the `@deprecated`
 * pointer. Tagging it here would deprecate a live behaviour against a
 * replacement that does not exist yet.
 */
import type { NetworkName } from "@arkade-os/sdk";
import { SwapRefusal } from "../rfq";
import type { AssetId } from "./assetId";
import type { CorridorId } from "./corridor";

/**
 * A solver declined, with its closed-set reason. The protocol's own class,
 * reused rather than shadowed or wrapped: §8 keeps it on the v2 surface
 * unchanged, and a second class would give two `SwapRefusal`s that fail
 * `instanceof` against each other across the v1/v2 seam.
 *
 * Boundary: the RFQ response, before anything is funded.
 */
export { SwapRefusal };

/**
 * The checks §3.1 runs on every quote, before it is returned.
 *
 * Four of them are the spec's, and the fifth is M3's answer to G2. §3.1 states
 * that "who answered is a transport property, not one of those four checks",
 * and the two dev transports authenticate nobody — so leaving attestation at
 * the transport makes verification skippable by configuration, which is the one
 * thing verification may not be. `responder` is therefore *delivered* as a
 * transport property and *run* as a check, and §3.1's sentence narrows to
 * addressed mode with it: published RFQ (§10) attributes each bid by its own
 * signature and inherits no transport attestation at all.
 */
export type QuoteCheck = "pair" | "lockup_address" | "invoice" | "refund_window" | "responder";

/**
 * `to` is underdetermined — it parses as nothing, as more than one thing, or as
 * one thing the corridor that owns it refuses.
 *
 * The third arm is the one a name reading only "ambiguous" would hide. A
 * corridor module answers *mine, and wrong* for a `tb1…` on a mainnet wallet,
 * another operator's Arkade address, or a bolt11 the shape-only classifier
 * admits and the decoder then rejects; collapsing that into *not mine* would
 * hand a well-formed destination to {@link UnsupportedRoute}, which names the
 * wrong fault. The refusal rides on `detail`, so the taxonomy stays at sixteen.
 *
 * A destination core classifies but no module claims — an LNURL today — is NOT
 * this: it is left unclaimed at the parse and becomes {@link UnsupportedRoute}
 * at route resolution.
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
 * Boundary: route resolution, before RFQ disclosure, artifact creation,
 * persistence or funding. Also the alias layer, for a rail no corridor serves,
 * and `quote()` for a pair no discovered market serves on the active snapshot —
 * a resolved route with an empty eligible set, which is an absence of a
 * market-shaped thing rather than a wrong pairing, and so this member rather
 * than a seventeenth.
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
 * `resolve()` needs market data and has neither an injected nor a cached
 * snapshot. Deliberately not a third, half-resolved route state: the type system
 * excludes one, and a caller that needs offline resolution warms or injects a
 * snapshot.
 *
 * Boundary: `resolve()`, and `quote()` when the fetch it is allowed to make
 * leaves it with nothing either — no registry configured, an unindexed network,
 * or an unreachable registry with no cache behind it. Fetching is what `quote()`
 * may do that `resolve()` may not; having no market data at all is the same
 * condition on both.
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
 * Boundary: the RFQ adapter, both directions; from M7, core's payment rails.
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
 * A solver response failed a local check. v1 documented the pair check as the
 * caller's job, in bold; here it is an invariant. v1's `AddressMismatch` is the
 * `lockup_address` case of this and folds into it at M3.
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
        /** The gate or derivation this folds in, kept as the `cause` chain:
         * `expected`/`actual` say what disagreed, and the cause says which
         * check said so. */
        options?: ErrorOptions,
    ) {
        super(`quote failed the ${check} check — refusing to fund`, options);
        this.expected = expected;
        this.actual = actual;
    }
}

/**
 * A quote past its TTL, or so close to it that acting on it is the same thing.
 *
 * Two boundaries, one condition. At `accept()` it is the spec's: the client
 * never silently re-quotes, because the price the caller saw is not the price
 * they would get. At `quote()` it is `policy.quoteTtlFloorSeconds` — a quote arriving
 * with less validity left than the caller can use is expired on arrival, and
 * saying so beats handing back terms that die between the return and the accept.
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
 * The quote's fee is over the verb's ceiling.
 *
 * Carries the terms rather than the quote: a `Quote` field would make this
 * module depend on M3, and an app re-presenting the terms calls `quote()` again
 * anyway.
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
 * The wallet cannot fund the give leg. v1 left this to `validatePlan` and the
 * caller, and `validatePlan` returned rather than threw.
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
 * `cancel()` on a swap this client cannot cancel. The asymmetry is structural:
 * an offer covenant has no expiry, so cancellation is an unfilled offer's only
 * exit, where an HTLC has phases and its exits are a claim or a refund.
 *
 * Three ways of refusing, one condition. A corridor-tagged id is refused on the
 * parse of its prefix, with no repository read; an `offer:` id no record backs
 * is refused after the one read cancel needed anyway; and an untagged id from
 * `/protocol`'s readers takes that same read. The taxonomy stays at sixteen —
 * a "no such swap" member would split one condition across two classes by
 * which call noticed it.
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
 * A destination disagrees with its asset's chain.
 *
 * Inert by ruling. §9's EVM corridor is the only place two chain identities can
 * disagree, and it is deferred, so nothing throws this yet. Declared anyway so
 * the taxonomy has no unowned member, and so M6's coverage pass can assert that
 * exactly one declared error has no throwing site — this one. Its fields are
 * pinned now for the same reason: nothing throws it, so this is the moment to
 * say what the evidence is.
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
 * A corridor's dependency was explicitly overridden to nothing, or is required
 * on this network and absent.
 *
 * Four overridable deps, not three: the arkade repository, the lightning
 * decoder, the lightning covclaimd deployment key, and the onchain chain
 * source. `undefined` takes the default; `null` is the refusal this names. The
 * arkade module's co-signer key reaches it by the second door — it is not a
 * `CorridorOverrides` key, but `EMULATOR_PUBKEYS` pins three of the five
 * networks, so on `testnet` and `signet` the override is required and its
 * absence is this rather than a bare `Error`.
 *
 * Boundary: dep resolution, when a route first touches that corridor. Never
 * construction: a missing dep for a corridor nobody uses is not an error.
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
 * Name to class.
 *
 * The `satisfies` is what makes drift a compile error rather than a review
 * catch: a member missing here fails the `Record`, an extra key fails the
 * excess-property check, and a class whose `name` disagrees with its identifier
 * fails both at once.
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
 * Whether `e` belongs to the taxonomy, optionally narrowed to one member.
 *
 * Catalog-driven rather than a chain of `instanceof`, so it stays total as
 * members are added, and it rejects an impostor: a foreign error that happens to
 * be named `QuoteExpired` fails the constructor check.
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
