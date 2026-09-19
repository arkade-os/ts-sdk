/**
 * Type-level assertions for the durable record. Checked by `tsconfig.test.json`,
 * which the package's `typecheck` script runs, so every `@ts-expect-error` here
 * is an assertion CI enforces — and one that stops erroring fails the build.
 *
 * The load-bearing one is {@link NoBigint}: the SQLite and Realm backends
 * `JSON.stringify` the record whole, so a `bigint` anywhere in it throws on two
 * of the four backends and round-trips on the third. That asymmetry is not
 * something a review catches reliably, and the conformance suite cannot catch a
 * field no fixture happens to populate — so it is proved structurally instead.
 */
import type { Artifact, Instrument } from "../../src/client/route";
import type { Quote, QuoteLeg } from "../../src/client/quote";
import type {
    CorridorSwapRecord,
    OfferSwapRecord,
    RecordedArtifact,
    RecordedInstrument,
    Swap,
    SwapRecord,
} from "../../src/client/record";

/**
 * Every `bigint` reachable from `T`, as the paths that reach one.
 *
 * Recursive on purpose: a `keyof` check over the top level passes happily on a
 * `bigint` nested inside an artifact, an instrument or a corridor profile,
 * which is exactly where the ones that got away would hide. `never` when the
 * type is clean, so the assertion below is an equality against `never` rather
 * than a boolean nobody can read the failure of.
 *
 * `Record<string, unknown>` — the corridor profile's declared type — stops the
 * recursion at `unknown`, which is honest: the bag is opaque by contract and
 * what goes in it is checked by the writer, not by this type.
 */
type NoBigint<T, Path extends string = ""> = T extends bigint
    ? Path
    : T extends string | number | boolean | null | undefined
      ? never
      : T extends readonly (infer E)[]
        ? NoBigint<E, `${Path}[]`>
        : T extends object
          ? { [K in keyof T & string]-?: NoBigint<T[K], `${Path}.${K}`> }[keyof T & string]
          : never;

/** `true` only when `T` is `never`. */
type IsNever<T> = [T] extends [never] ? true : false;

/**
 * The record carries no `bigint`, at any depth.
 *
 * Asserted as `IsNever<...> = true` rather than against a list of field paths:
 * a failure then reads as "expected true, got false" beside the type whose
 * paths TypeScript prints in full, and adding a clean field to the record does
 * not require editing an expectation.
 */
export const recordIsJsonSafe: IsNever<NoBigint<SwapRecord>> = true;
export const offerRecordIsJsonSafe: IsNever<NoBigint<OfferSwapRecord>> = true;
export const corridorRecordIsJsonSafe: IsNever<NoBigint<CorridorSwapRecord>> = true;
export const recordedArtifactIsJsonSafe: IsNever<NoBigint<RecordedArtifact>> = true;
export const recordedInstrumentIsJsonSafe: IsNever<NoBigint<RecordedInstrument>> = true;

/**
 * The helper actually finds one — otherwise every assertion above would pass
 * against a type that returned `never` unconditionally, which is the way a
 * structural proof like this fails silently.
 *
 * `Quote` is the natural control: the same information in public form, carrying
 * `bigint` amounts deliberately.
 */
// @ts-expect-error Quote carries bigint amounts, so it is NOT json-safe
export const quoteIsNotJsonSafe: IsNever<NoBigint<Quote>> = true;

/** And it finds a nested one, not just a top-level field. */
type Nested = { outer: { inner: bigint } };
// @ts-expect-error the bigint is two levels down, and must still be found
export const nestedIsFound: IsNever<NoBigint<Nested>> = true;

/** ...and it reports *where*, which is what makes a failure actionable. */
export const nestedPath: ".outer.inner" = ".outer.inner" satisfies NoBigint<Nested>;

// ── What `Swap` promises the milestones after this one ─────────────────────

/**
 * `artifact` stays optional, so M7's `ReceiveRequest` can narrow it.
 *
 * An intersection cannot make a required field required — if `Swap.artifact`
 * were already non-optional the intersection would be a no-op and the guarantee
 * it exists to state would be unstated.
 */
export type ReceiveRequest = Swap & { artifact: Artifact };
export const narrowed = (r: ReceiveRequest): Artifact => r.artifact;

// @ts-expect-error a plain Swap's artifact may be absent
export const notNarrowed = (s: Swap): Artifact => s.artifact;

/** The public shape keeps `bigint` amounts: it is the answer, not the storage. */
export const swapAmountsAreBigint = (s: Swap): [bigint, bigint, bigint] => [
    s.give.amount,
    s.take.amount,
    s.fee.amount,
];

/** And its legs are the quote's own leg type, not a second spelling of it. */
export const legsAgree = (s: Swap): QuoteLeg => s.give;

// ── The two records are told apart by their tag, never by a probe ──────────

export const familyDiscriminates = (record: SwapRecord): string =>
    record.family === "offer" ? record.offerHex : record.lockupAddress;

// @ts-expect-error the offer arm has no lockup
export const noLockupOnOffer = (record: OfferSwapRecord): string => record.lockupAddress;

// @ts-expect-error the corridor arm has no offer TLV
export const noOfferOnCorridor = (record: CorridorSwapRecord): string => record.offerHex;

/**
 * A corridor record's lock hash and refund locktime are non-optional.
 *
 * They are optional on `Quote`, because an asset swap has neither — and a
 * corridor record that inherited that optionality would make every read of the
 * refund deadline a `?? throw` at the call site.
 */
export const corridorClocksAreCertain = (record: CorridorSwapRecord): [string, number] => [
    record.lock.hash,
    record.refundLocktime,
];

// ── The instrument round trip covers every arm ────────────────────────────

/** Each union stays total: a new arm on one must be added to the other. */
export const instrumentArms: Instrument["kind"][] = ["wallet", "address", "invoice"];
export const recordedInstrumentArms: RecordedInstrument["kind"][] = [
    "wallet",
    "address",
    "invoice",
];
export const artifactArms: Artifact["kind"][] = ["invoice", "deposit"];
export const recordedArtifactArms: RecordedArtifact["kind"][] = ["invoice", "deposit"];
