/**
 * The corridor axis, and its bijection with the rail namespaces.
 *
 * Routes speak `arkade | lightning | onchain`; CAIP-2 asset namespaces are `arkade | bolt11 |
 * bitcoin`. Both stay: rail names would make the public route vocabulary protocol-shaped, and
 * `lightning:` overruns CAIP-2's eight-character namespace cap. {@link railOfCorridor} is total, and
 * `route.ts` ties an endpoint's corridor to its asset's rail in the type system.
 */
import type { BitcoinRail, Rail } from "./assetId";

/** The corridor a leg settles on — caller-facing route names, independent of discovery's CAIP rail
 * identifiers. */
export const CORRIDORS = ["arkade", "lightning", "onchain"] as const;
export type Corridor = (typeof CORRIDORS)[number];

/** A corridor id: the three implemented corridors plus EVM chains. The template arm stays open on
 * purpose — which chains a registry lists is a listing decision, not an id-grammar one. */
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

/** The corridor a rail belongs to, or `undefined` for `eip155`, whose corridor id needs a chain
 * reference this side cannot invent. */
export const corridorOfRail = (rail: Rail): Corridor | undefined =>
    rail === "eip155" ? undefined : CORRIDOR_BY_RAIL[rail];
