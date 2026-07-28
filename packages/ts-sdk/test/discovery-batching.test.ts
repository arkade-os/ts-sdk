import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { detectUsedScripts } from "../src/contracts/handlers/helpers";
import { DefaultContractHandler } from "../src/contracts/handlers/default";
import { DelegateContractHandler } from "../src/contracts/handlers/delegate";
import { SCRIPT_QUERY_CHUNK_SIZE } from "../src/contracts/constants";
import type { DiscoveredContract, DiscoveryDeps } from "../src/contracts/types";
import type { IndexerProvider } from "../src/providers/indexer";

/**
 * Indexer that reports one VTXO per requested script present in `used`, and
 * records the script list of every call so a test can assert on request COUNT
 * and per-request width — the two properties Phase 2 exists to change.
 */
function makeIndexer(used: Set<string>, onCall?: (scripts: string[]) => void) {
    const calls: string[][] = [];
    const indexerProvider = {
        async getVtxos({ scripts }: { scripts?: string[] }) {
            const list = scripts ?? [];
            calls.push(list);
            onCall?.(list);
            return {
                vtxos: list
                    .filter((s) => used.has(s))
                    .map((script) => ({ script }) as unknown as never),
            };
        },
    } as unknown as IndexerProvider;
    return { indexerProvider, calls };
}

/** Distinct x-only pubkeys, so every index derives a distinct script. */
function descriptorAt(index: number): string {
    const priv = new Uint8Array(32).fill(1);
    priv[31] = index + 1;
    return `tr(${hex.encode(schnorr.getPublicKey(priv))})`;
}

function makeDeps(indexerProvider: IndexerProvider, delegate = false): DiscoveryDeps {
    const deps: DiscoveryDeps = {
        indexerProvider,
        onchainProvider: {} as DiscoveryDeps["onchainProvider"],
        network: { hrp: "ark" } as DiscoveryDeps["network"],
        serverPubKey: new Uint8Array(32).fill(9),
        csvTimelocks: [
            { value: 144n, type: "blocks" },
            { value: 512n, type: "seconds" },
        ],
    };
    return delegate ? { ...deps, delegatePubKey: new Uint8Array(32).fill(7) } : deps;
}

const scriptsOf = (found: DiscoveredContract[]) => found.map((c) => c.script);

describe("detectUsedScripts chunking", () => {
    it("splits past the chunk cap and unions the results", async () => {
        const all = Array.from({ length: 70 }, (_, i) => `aa${i.toString(16).padStart(4, "0")}`);
        const used = new Set([all[0], all[40], all[69]]);
        const { indexerProvider, calls } = makeIndexer(used);

        const found = await detectUsedScripts(indexerProvider, all);

        expect(found).toEqual(used);
        expect(calls).toHaveLength(Math.ceil(70 / SCRIPT_QUERY_CHUNK_SIZE));
        expect(calls.every((c) => c.length <= SCRIPT_QUERY_CHUNK_SIZE)).toBe(true);
        // Every script was asked about exactly once.
        expect(calls.flat().sort()).toEqual([...all].sort());
    });

    it("collapses duplicate scripts instead of padding the query string", async () => {
        const { indexerProvider, calls } = makeIndexer(new Set());
        await detectUsedScripts(indexerProvider, ["aa", "bb", "aa", "bb"]);
        expect(calls).toEqual([["aa", "bb"]]);
    });

    it("rejects when a later chunk fails, discarding the earlier chunk's hits", async () => {
        // All-or-nothing: a partial answer would let the scanner read an
        // unprobed script as "unused" and close the gap window on a failure.
        const all = Array.from({ length: 40 }, (_, i) => `bb${i.toString(16).padStart(4, "0")}`);
        let seen = 0;
        const { indexerProvider } = makeIndexer(new Set(all), () => {
            if (++seen === 2) throw new Error("rate limited");
        });

        await expect(detectUsedScripts(indexerProvider, all)).rejects.toThrow("rate limited");
    });
});

describe("Discoverable.discoverRange", () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
        index: i,
        descriptor: descriptorAt(i),
    }));

    for (const [name, handler, delegate] of [
        ["default", DefaultContractHandler, false],
        ["delegate", DelegateContractHandler, true],
    ] as const) {
        it(`${name}: discovers exactly what per-index discoverAt discovers`, async () => {
            // Pick a hit by probing index 4 first, then assert both verbs
            // agree — the batched path must not become a second source of
            // truth about which contracts a wallet owns.
            const probe = makeIndexer(new Set());
            await handler.discoverAt(
                4,
                entries[4].descriptor,
                makeDeps(probe.indexerProvider, delegate),
            );
            const used = new Set([probe.calls.flat()[0]]);

            const perIndex = makeIndexer(used);
            const serial: Record<number, string[]> = {};
            for (const e of entries) {
                serial[e.index] = scriptsOf(
                    await handler.discoverAt(
                        e.index,
                        e.descriptor,
                        makeDeps(perIndex.indexerProvider, delegate),
                    ),
                );
            }

            const batched = makeIndexer(used);
            const ranged = await handler.discoverRange!(
                entries,
                makeDeps(batched.indexerProvider, delegate),
            );

            expect(Object.fromEntries([...ranged].map(([i, f]) => [i, scriptsOf(f)]))).toEqual(
                serial,
            );
            expect(serial[4]).toHaveLength(1);
        });

        it(`${name}: answers a whole window in one request instead of one per index`, async () => {
            const { indexerProvider, calls } = makeIndexer(new Set());
            await handler.discoverRange!(entries, makeDeps(indexerProvider, delegate));
            // 10 indices × 2 csvTimelocks = 20 scripts, one chunk.
            expect(calls).toHaveLength(1);
            expect(calls[0]).toHaveLength(20);
        });

        it(`${name}: covers every requested index`, async () => {
            const { indexerProvider } = makeIndexer(new Set());
            const ranged = await handler.discoverRange!(
                entries,
                makeDeps(indexerProvider, delegate),
            );
            expect([...ranged.keys()]).toEqual(entries.map((e) => e.index));
        });
    }

    it("delegate: covers every requested index even when the wallet has no delegate key", async () => {
        // An omitted index reads as indeterminate and truncates the scan, so
        // "nothing to discover" must still be answered per index.
        const { indexerProvider, calls } = makeIndexer(new Set());
        const ranged = await DelegateContractHandler.discoverRange!(
            entries,
            makeDeps(indexerProvider, false),
        );
        expect([...ranged.keys()]).toEqual(entries.map((e) => e.index));
        expect([...ranged.values()].every((f) => f.length === 0)).toBe(true);
        expect(calls).toHaveLength(0);
    });
});
