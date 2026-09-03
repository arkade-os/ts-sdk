/**
 * The corridor axis, and its bijection with the rail namespaces.
 *
 * One axis, two vocabularies: discovery speaks `arkade | lightning | onchain`
 * and an asset id's CAIP-2 namespace is `arkade | bolt11 | bitcoin`. They agree
 * on one member of three. Collapsing them was the alternative and it loses
 * either way — take the rail names and every market lookup translates on the
 * way out to discovery; take the corridor names and `lightning:` overruns
 * CAIP-2's eight-character namespace cap.
 *
 * So both stay, and the disagreement is spent once, here: `Corridor` is
 * discovery's type verbatim, {@link railOfCorridor} is total, and `route.ts`
 * ties an endpoint's corridor to its asset's rail in the type system so the two
 * cannot disagree in a value.
 */
import type { Corridor as DiscoveryCorridor } from "@arkade-os/solver-discovery";
import type { BitcoinRail, Rail } from "./assetId";

/**
 * The corridor a leg settles on.
 *
 * Aliased from discovery rather than re-declared: it is discovery's vocabulary,
 * the alias layer has to speak it, and a re-declaration would drift silently
 * the day discovery adds a corridor.
 */
export type Corridor = DiscoveryCorridor;

/** Every corridor, in the order the route union uses them. */
export const CORRIDORS = ["arkade", "lightning", "onchain"] as const satisfies readonly Corridor[];

/**
 * A corridor id: the three implemented corridors plus §9's EVM chains.
 *
 * The template arm stays open against the registry's closed enum on purpose —
 * which chains a registry lists is a listing decision, not an id-grammar one.
 */
export type CorridorId = Corridor | `eip155:${number}`;

/** The rail namespace a corridor's assets are spelled on. */
export type RailOf<C extends CorridorId> = C extends "arkade"
    ? "arkade"
    : C extends "lightning"
      ? "bolt11"
      : C extends "onchain"
        ? "bitcoin"
        : "eip155";

const RAIL_BY_CORRIDOR = {
    arkade: "arkade",
    lightning: "bolt11",
    onchain: "bitcoin",
} as const satisfies Record<Corridor, BitcoinRail>;

const CORRIDOR_BY_RAIL = {
    arkade: "arkade",
    bolt11: "lightning",
    bitcoin: "onchain",
} as const satisfies Record<BitcoinRail, Corridor>;

/** The rail a corridor's assets are spelled on. Total, and the type agrees. */
export const railOfCorridor = <C extends CorridorId>(corridor: C): RailOf<C> =>
    (corridor in RAIL_BY_CORRIDOR ? RAIL_BY_CORRIDOR[corridor as Corridor] : "eip155") as RailOf<C>;

/**
 * The corridor a rail belongs to, or `undefined` for `eip155` — whose corridor
 * id carries a chain reference this side has no way to invent.
 */
export const corridorOfRail = (rail: Rail): Corridor | undefined =>
    rail === "eip155" ? undefined : CORRIDOR_BY_RAIL[rail];
