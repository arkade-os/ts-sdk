/**
 * A route is two endpoints, each an asset on a corridor, plus the instrument
 * that settles it.
 *
 * Two invariants live in the types rather than in a check. An endpoint's
 * corridor and its asset cannot disagree, because {@link Endpoint} is a union
 * with one member per corridor and each member types its asset as
 * {@link AssetOn} of that one corridor. And `onchain -> arkade` is not in
 * {@link Route} at all, so once a route has been resolved the misroute is a
 * compile error; before resolution it is `UnsupportedRoute`, thrown ahead of
 * RFQ disclosure, artifact creation, persistence and funding.
 */
import type { AssetId, AssetPart } from "./assetId";
import type { Corridor, CorridorId, RailOf } from "./corridor";
import type { Hex } from "./primitives";

/**
 * A leg's concrete settlement locus. Direction comes from give versus take,
 * never from the instrument.
 *
 * `{ kind: "wallet" }` is the only instrument the SDK holds signing authority
 * over, which is why it is the only one nobody passes: `accept()` spends the
 * balance and lands the claim on wallet legs and merely watches the others. The
 * supply law is that the caller provides non-wallet take instruments (that is
 * what `to` is), the quote provides non-wallet give instruments (that is
 * exactly what the artifact is), and every remaining slot resolves to `wallet`.
 *
 * `wallet` is an explicit variant rather than an absent field because absence
 * would mean two unrelated things — wallet-by-default and not-yet-resolved —
 * and a receive leg lives in the second state until the quote returns.
 */
export type Instrument =
    | { kind: "wallet" }
    | { kind: "address"; address: string }
    | {
          kind: "invoice";
          bolt11: string;
          paymentHash: Hex;
          amount?: bigint;
          expiresAt: number;
      };

/**
 * The asset ids corridor `C` can carry.
 *
 * On the three bitcoin-family corridors the corridor names no network, so the
 * tie is the rail alone. On an EVM corridor it is more than that: `eip155:8453`
 * *is* the CAIP-2 chain part its assets are spelled with, so the asset id has to
 * start with the corridor id verbatim. Enforcing only the rail there would admit
 * `eip155:1/erc20:…` on a Base corridor — the same near-miss `sameAsset` refuses
 * one layer up, an address being a chain's fact and not a token's.
 */
export type AssetOn<C extends CorridorId> = C extends Corridor
    ? AssetId<RailOf<C>>
    : `${C}/${AssetPart}`;

/**
 * An asset on a corridor, with the instrument that settles it.
 *
 * `corridor` is a cross-check rather than an input: every id already carries
 * its rail. Typing `asset` against that rail is what makes the cross-check free
 * — there is no value in which the two disagree.
 *
 * Distributed over `C` rather than written as one object whose two fields both
 * mention it: `{ corridor: C; asset: AssetOn<C> }` at `C = CorridorId` widens
 * *each field independently* to its own union, and correlates nothing —
 * `{ corridor: "arkade", asset: "bitcoin:…" }` satisfies it. The conditional
 * makes `Endpoint` the union of the four single-corridor shapes instead, so the
 * pairing survives the default type argument, which is the case every unwitnessed
 * `Endpoint` in a signature lands on.
 */
export type Endpoint<C extends CorridorId = CorridorId> = C extends CorridorId
    ? {
          corridor: C;
          asset: AssetOn<C>;
          /** Resolved by the client, never constructed by callers. */
          instrument: Instrument;
      }
    : never;

/** Shorthand for one corridor's endpoint, as the route union spells it. */
export type Ep<C extends CorridorId> = Endpoint<C>;

/**
 * The implemented routes, as a closed union.
 *
 * `onchain -> arkade` is deliberately absent until the manager owns the
 * trader's L1 refund path end to end.
 */
export type Route =
    | { give: Ep<"arkade">; take: Ep<"arkade"> }
    | { give: Ep<"arkade">; take: Ep<"lightning"> }
    | { give: Ep<"lightning">; take: Ep<"arkade"> }
    | { give: Ep<"arkade">; take: Ep<"onchain"> };

/**
 * The one thing a counterparty must see, when a route has one.
 *
 * The deposit variant carries no `chain` field. §3.4 reserved one and Q12 made
 * it redundant: the chain part lives inside `asset`, and a second, untyped
 * spelling of it is a fact two fields can disagree about with nothing checking.
 * `corridor` stays because it is the typed axis `route.ts` already ties to the
 * asset's rail — a cross-check, where `chain?: string | number` was a copy.
 */
export type Artifact = { kind: "invoice"; bolt11: string } | DepositArtifact;

/**
 * The deposit half of {@link Artifact}, distributed over the corridor for the
 * reason {@link Endpoint} is: `corridor` is only a cross-check if a value cannot
 * spell it against an asset from another corridor.
 */
export type DepositArtifact<C extends CorridorId = CorridorId> = C extends CorridorId
    ? {
          kind: "deposit";
          corridor: C;
          address: string;
          asset: AssetOn<C>;
          amount: bigint;
          expiresAt?: number;
      }
    : never;
