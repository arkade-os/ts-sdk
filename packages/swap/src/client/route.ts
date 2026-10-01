/**
 * A route is two endpoints, each an asset on a corridor, plus the instrument that settles it.
 *
 * Two invariants live in the types: an {@link Endpoint}'s corridor and asset cannot disagree, and
 * `onchain -> arkade` is not in {@link Route}, so a resolved misroute is a compile error (before
 * resolution it is `UnsupportedRoute`, thrown ahead of RFQ disclosure, persistence and funding).
 */
import type { AssetId, AssetPart } from "./assetId";
import type { Corridor, CorridorId, RailOf } from "./corridor";
import type { Hex } from "./primitives";

/**
 * A leg's concrete settlement locus. Direction comes from give versus take,
 * never from the instrument.
 *
 * `{ kind: "wallet" }` is the only instrument the SDK can sign for, so nobody passes it: the
 * caller provides non-wallet take instruments (`to`), the quote provides non-wallet give
 * instruments (the artifact), and every remaining slot resolves to `wallet`. It is an explicit
 * variant because an absent field would conflate wallet-by-default with not-yet-resolved.
 */
export type Instrument =
    | { kind: "wallet" }
    | {
          kind: "address";
          address: string;
          /**
           * The amount a BIP21 URI pinned beside the address, when one did. Carried here so a
           * caller passing a different `amount` trips `AmountMismatch`, as with a bolt11 amount.
           */
          amount?: bigint;
      }
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
 * On bitcoin-family corridors the tie is the rail alone. On EVM, `eip155:8453` is the CAIP-2 chain
 * part, so the asset id must start with the corridor id verbatim; a rail-only check would admit
 * `eip155:1/erc20:…` on a Base corridor.
 */
export type AssetOn<C extends CorridorId> = C extends Corridor
    ? AssetId<RailOf<C>>
    : `${C}/${AssetPart}`;

/**
 * An asset on a corridor, with the instrument that settles it. `corridor` is a cross-check (the id
 * already carries its rail), typed so the two cannot disagree.
 *
 * Distributive over `C` on purpose: `{ corridor: C; asset: AssetOn<C> }` at `C = CorridorId`
 * widens each field independently and would admit `{ corridor: "arkade", asset: "bitcoin:…" }`.
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
 * No `chain` field on the deposit: the chain part lives inside `asset`, and a second spelling
 * would be a fact two fields can disagree about.
 */
export type Artifact = { kind: "invoice"; bolt11: string } | DepositArtifact;

/**
 * The deposit half of {@link Artifact}, distributed over the corridor for the same reason as
 * {@link Endpoint}.
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
