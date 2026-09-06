/**
 * The disposition diff: `scripts/dispositions.json` against the barrels as they
 * actually are.
 *
 * M8's premise is that a hand-kept inventory of this surface cannot stay true —
 * the one it replaced was wrong in every count by the time it was read, and not
 * from drift: the branch moved under it. So the record is diffed against a
 * re-derivation of `src/index.ts` and `src/protocol.ts` on every run, and a name
 * in one and not the other fails here rather than at a consumer's first import.
 *
 * What it is NOT is a snapshot of the v2 surface. `export * from "./client"`
 * puts 270 names on the root that no disposition covers, because they were never
 * v1's to dispose of; the rule is that a root export is either a v2 name or a
 * name with a recorded disposition, which is what catches a v1 building block
 * quietly coming back.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    CLIENT_ENTRY,
    PROTOCOL_ENTRY,
    ROOT_ENTRY,
    SWAP_ROOT,
    inventory,
} from "../scripts/export-inventory.mjs";

const dispositions = JSON.parse(
    readFileSync(resolve(SWAP_ROOT, "scripts/dispositions.json"), "utf8"),
);
const { S, P, I, D, R } = dispositions;

const namesOf = (entry: string) => new Set(inventory(entry).map((e) => e.name));
const moduleOf = (entry: string) =>
    new Map(inventory(entry).map((e) => [e.name, e.module] as const));

const root = namesOf(ROOT_ENTRY);
const client = namesOf(CLIENT_ENTRY);
const protocol = namesOf(PROTOCOL_ENTRY);

describe("the M8 disposition record", () => {
    it("gives every name exactly one disposition", () => {
        const all = [...S, ...P, ...I, ...D, ...R];
        expect(all.length).toBe(new Set(all).size);
    });

    it("puts every S name on the root", () => {
        expect([...S].filter((n: string) => !root.has(n))).toEqual([]);
    });

    it("puts every P name on /protocol, and nothing else", () => {
        expect([...protocol].sort()).toEqual([...P].sort());
    });

    it("keeps every P name OFF the root", () => {
        // The window was collapsed deliberately: `0.1.0` breaks against
        // `0.1.0-rc.1` whatever this barrel does, so re-exporting the v1 names
        // from the root for a version would have split one migration into two
        // and left 200 of them on a root whose claim is to be the v2 surface.
        // A P name reappearing here is that decision being undone by accident.
        expect([...P].filter((n: string) => root.has(n))).toEqual([]);
    });

    it("keeps every I and D name off both barrels", () => {
        const gone = [...I, ...D];
        expect(gone.filter((n: string) => root.has(n) || protocol.has(n))).toEqual([]);
    });

    it("binds each R name to the v2 declaration, not the facade it replaced", () => {
        // The whole of B in one assertion: the name survived, the declaration
        // behind it did not. `src/swapClient.ts` is unreferenced after this and
        // goes with the removal pass.
        const declaredIn = moduleOf(ROOT_ENTRY);
        for (const name of R) {
            expect(client.has(name)).toBe(true);
            expect(declaredIn.get(name)).toMatch(/^src\/client\//);
        }
    });

    it("leaves no root export undisposed", () => {
        // A new name landing on the root without a ruling fails here. v2 names
        // are covered by being on `./client`; a v1 name coming back is caught
        // one assertion up, since P is no longer a legal reason to be here.
        const disposed = new Set<string>([...S, ...R]);
        const undisposed = [...root].filter((n) => !disposed.has(n) && !client.has(n));
        expect(undisposed).toEqual([]);
    });
});

describe("the @deprecated pointers", () => {
    // Every tag sits on the declaration, because a block tag above an
    // `export { … } from` does not reach the consumer's editor — the alias
    // resolves to the target and reads ITS JSDoc. So they are counted in the
    // source files, not in the barrel.
    const sources = new Map<string, string>();
    const sourceOf = (module: string) => {
        if (!sources.has(module)) {
            sources.set(module, readFileSync(resolve(SWAP_ROOT, module), "utf8"));
        }
        return sources.get(module)!;
    };
    const declaredIn = moduleOf(PROTOCOL_ENTRY);

    it("tags every P declaration", () => {
        const untagged = [...P].filter((name: string) => {
            const module = declaredIn.get(name);
            if (!module) return true;
            const source = sourceOf(module);
            // The tag is in the JSDoc immediately above the declaration, so it
            // is the nearest `@deprecated` before the name.
            const at = source.search(
                new RegExp(
                    `^(export )?(async )?(const|function|class|interface|type|enum) ${name}\\b`,
                    "m",
                ),
            );
            if (at < 0) return true;
            const window = source.slice(Math.max(0, at - 1400), at);
            return !window.includes("@deprecated");
        });
        expect(untagged).toEqual([]);
    });

    it("names a replacement or says so", () => {
        // Greppable rather than reviewed: a pointer either names a v2 spelling
        // in backticks or admits there is none.
        const tags = [...new Set(P.map((n: string) => declaredIn.get(n)))]
            .flatMap((module) => sourceOf(module as string).match(/@deprecated[^\n]*/g) ?? [])
            // The shared tail names the subpath, so it carries backticks of its
            // own; strip it before asking whether the POINTER says anything.
            .map((t) => t.replace(/Moved off the package root to `[^`]+`\./, ""));
        expect(tags.length).toBeGreaterThanOrEqual(P.length);
        const empty = tags.filter((t) => !/`[^`]+`/.test(t) && !t.includes("no replacement"));
        expect(empty).toEqual([]);
    });
});
