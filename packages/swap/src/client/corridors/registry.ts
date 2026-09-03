/**
 * The registry: three modules, keyed on the corridor, and the one place a
 * destination string becomes a corridor plus an instrument.
 *
 * Keyed on `Corridor` and not `CorridorId`, deliberately.
 * `noUncheckedIndexedAccess` is off in this workspace, so a `CorridorId`-keyed
 * record types an `eip155:` lookup as present and hands back `undefined` at
 * runtime — the EVM corridor is deferred and its absence should be a type
 * error, not a null deref three layers down.
 *
 * Internal, exactly as v1's kind-keyed registry argues: a corridor registered
 * from outside would parse, quote, persist and restore correctly and then sit
 * undriven, which is worse than not being registrable at all.
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
 * settles. No asset — no destination class carries one, since every Arkade
 * asset shares a single address form. */
export interface ClaimedDestination {
    corridor: Corridor;
    instrument: Instrument;
}

/**
 * The corridors of one client, with deps resolved on first use.
 *
 * The laziness is the contract: `resolveCorridorDeps` throws
 * `MissingCorridorDep` for a dep overridden to `null`, and a missing dep for a
 * corridor nobody uses is not an error.
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
        // The `satisfies` above pins every factory to its own dep record and
        // `resolveCorridorDeps` returns exactly that record for the same `C`.
        // TypeScript will not correlate two indexed accesses through one type
        // parameter, so the pairing is asserted here — at the single place it
        // is needed, and against a `satisfies` that fails to compile if a
        // factory and its deps ever stop agreeing.
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
            // Which corridors this string is even the business of, decided with
            // no deps at all: `CorridorFactory.target` is core's own classifier,
            // the same one the module extracts with. Asking first is what keeps
            // a `null` override on an unused corridor from throwing.
            const owners = CORRIDORS.filter(
                (corridor) => CORRIDOR_FACTORIES[corridor].target(raw) !== undefined,
            );

            if (owners.length === 0) {
                // Core classifies it and no corridor serves it: leave it
                // unclaimed, and let route resolution name it `UnsupportedRoute`
                // — which is the fault, where "ambiguous" would not be.
                if (isLnurl(raw)) return undefined;
                // Nothing classifies it at all — `0x…` is the realizable case.
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
                // Core resolves a multi-target URI by rail priority and chooses
                // in silence, which is safe for core: its rails are
                // interchangeable and `RouteQuote`'s amounts are receiver-exact,
                // so a swapped rail changes nothing the recipient gets. A route
                // choice here changes which asset moves and against which
                // counterparty, so it is refused instead.
                throw new AmbiguousDestination(
                    raw,
                    `it names ${claims.map((claim) => claim.corridor).join(" and ")}, ` +
                        "with nothing to choose between them",
                );
            }
            if (claims.length === 1) return claims[0];
            if (refusals.length > 0) throw new AmbiguousDestination(raw, refusals.join("; "));
            // The classifier took it and the module answered neither — which
            // only happens if a module's `target` and its `matches` disagree.
            return undefined;
        },
    };
};
