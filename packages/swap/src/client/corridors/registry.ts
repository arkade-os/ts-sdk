/**
 * The registry: the one place a destination string becomes a corridor plus an instrument.
 *
 * Keyed on `Corridor`, not `CorridorId`: `noUncheckedIndexedAccess` is off, so a
 * `CorridorId`-keyed record would type an `eip155:` lookup as present and return `undefined` at
 * runtime. Internal, because an externally registered corridor would parse, quote, persist and
 * restore, then sit undriven.
 */
import { isLnurl } from "@arkade-os/sdk";
import { CORRIDORS, type Corridor } from "../corridor";
import { AmbiguousDestination } from "../errors";
import type { Instrument } from "../route";
import { arkadeCorridor } from "./arkade";
import type { CorridorFactory, CorridorModule } from "./contract";
import {
    resolveCorridorDeps,
    type CorridorBase,
    type CorridorDeps,
    type CorridorDepsByCorridor,
    type CorridorOverrides,
} from "./deps";
import { lightningCorridor } from "./lightning";
import { onchainCorridor } from "./onchain";

/** The shipped corridors. Total over `Corridor`, checked at compile time. */
export const CORRIDOR_FACTORIES = {
    arkade: arkadeCorridor,
    lightning: lightningCorridor,
    onchain: onchainCorridor,
} as const satisfies { [C in Corridor]: CorridorFactory<CorridorDepsByCorridor[C]> };

/** What a destination resolves to: the corridor that claimed it, and how it
 * settles. No asset — every Arkade asset shares a single address form. */
export interface ClaimedDestination {
    corridor: Corridor;
    instrument: Instrument;
}

/**
 * The corridors of one client, with deps resolved lazily on first use, so a dep overridden to
 * `null` on a corridor nobody uses is not an error.
 */
export interface CorridorSet {
    /** The module for `corridor`, resolving and memoizing its deps on the first
     * call. Throws `MissingCorridorDep` when a dep of THIS corridor was
     * overridden to nothing. */
    get<C extends Corridor>(corridor: C): CorridorModule<CorridorDepsByCorridor[C]>;

    /**
     * Which corridor claims `raw`, if any.
     *
     * @throws {AmbiguousDestination} when more than one corridor claims it,
     *   when the corridor that owns its class refuses it, or when nothing
     *   classifies it at all.
     * @throws {MissingCorridorDep} when the corridor that owns this destination
     *   has a dep disabled via overrides.
     * @returns `undefined` when core classifies the string but no corridor
     *   serves it — an LNURL today — which becomes `UnsupportedRoute` at route
     *   resolution rather than a parse failure here.
     */
    claim(raw: string): ClaimedDestination | undefined;
}

export const corridorSet = (base: CorridorBase, overrides?: CorridorOverrides): CorridorSet => {
    const built = new Map<Corridor, CorridorModule<CorridorDeps>>();
    const get = <C extends Corridor>(corridor: C): CorridorModule<CorridorDepsByCorridor[C]> => {
        const memoized = built.get(corridor);
        if (memoized) return memoized as CorridorModule<CorridorDepsByCorridor[C]>;
        // TS won't correlate two indexed accesses through one type parameter; the `satisfies`
        // on CORRIDOR_FACTORIES is what keeps this cast honest.
        const factory = CORRIDOR_FACTORIES[corridor] as unknown as CorridorFactory<
            CorridorDepsByCorridor[C]
        >;
        const module = factory(resolveCorridorDeps(corridor, overrides, base));
        built.set(corridor, module as CorridorModule<CorridorDeps>);
        return module;
    };

    return {
        get,
        claim(raw: string): ClaimedDestination | undefined {
            // Classify with no deps first, so a `null` override on an unused corridor can't throw.
            const owners = CORRIDORS.filter(
                (corridor) => CORRIDOR_FACTORIES[corridor].target(raw) !== undefined,
            );

            if (owners.length === 0) {
                // Unclaimed, so route resolution names it `UnsupportedRoute`, the real fault.
                if (isLnurl(raw)) return undefined;
                throw new AmbiguousDestination(raw, "no corridor recognises this destination");
            }

            const claims: ClaimedDestination[] = [];
            const refusals: string[] = [];
            for (const corridor of owners) {
                const answer = get(corridor).matches(raw);
                if (answer?.claimed) claims.push({ corridor, instrument: answer.claimed });
                else if (answer?.refused) refusals.push(`${corridor}: ${answer.refused}`);
            }

            if (claims.length > 1) {
                // Core silently picks a multi-target URI's rail by priority, safe there because
                // its rails are interchangeable. Here the choice changes which asset moves and
                // against which counterparty, so it is refused.
                throw new AmbiguousDestination(
                    raw,
                    `it names ${claims.map((claim) => claim.corridor).join(" and ")}, ` +
                        "with nothing to choose between them",
                );
            }
            if (claims.length === 1) return claims[0];
            if (refusals.length > 0) throw new AmbiguousDestination(raw, refusals.join("; "));
            // Only reachable if a module's `target` and `matches` disagree.
            return undefined;
        },
    };
};
