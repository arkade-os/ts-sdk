/**
 * A route is two endpoints, each an asset on a corridor, plus the instrument
 * that settles it.
 *
 * Two invariants live in the types rather than in a check. An endpoint's
 * corridor and its asset's rail cannot disagree, because {@link Endpoint} spells
 * the asset as `AssetId<RailOf<C>>`. And `onchain -> arkade` is not in
 * {@link Route} at all, so once a route has been resolved the misroute is a
 * compile error; before resolution it is `UnsupportedRoute`, thrown ahead of
 * RFQ disclosure, artifact creation, persistence and funding.
 */
import type { AssetId } from "./assetId";
import type { CorridorId, RailOf } from "./corridor";
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
 * An asset on a corridor, with the instrument that settles it.
 *
 * `corridor` is a cross-check rather than an input: every id already carries
 * its rail. Typing `asset` against that rail is what makes the cross-check free
 * — there is no value in which the two disagree.
 */
export interface Endpoint<C extends CorridorId = CorridorId> {
    corridor: C;
    asset: AssetId<RailOf<C>>;
    /** Resolved by the client, never constructed by callers. */
    instrument: Instrument;
}

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
export type Artifact =
    | { kind: "invoice"; bolt11: string }
    | {
          kind: "deposit";
          corridor: CorridorId;
          address: string;
          asset: AssetId;
          amount: bigint;
          expiresAt?: number;
      };
