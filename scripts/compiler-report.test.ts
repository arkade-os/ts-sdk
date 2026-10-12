import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { ArkadeScript } from "../packages/sdk/src/arkade/script";
import { comparisons as vhtlc } from "../packages/sdk/test/compiler-vhtlc.fixtures";
import { comparisons as swaps } from "../packages/swap/test/compiler-covenants.fixtures";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = resolve(root, "contracts/compiler-comparison");
const write = process.env.ARKADE_COMPILER_WRITE === "1";
const manifest = JSON.parse(readFileSync(resolve(output, "manifest.json"), "utf8"));

function metrics(value: string | undefined) {
    if (value === undefined) return undefined;
    const bytes = hex.decode(value);
    const tokens = ArkadeScript.decode(bytes);
    const opcodes: Record<string, number> = {};
    for (const token of tokens) {
        if (typeof token === "string") opcodes[token] = (opcodes[token] ?? 0) + 1;
    }
    return {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        opcodes,
        dataPushBytes: tokens.reduce<number>(
            (sum, token) => sum + (token instanceof Uint8Array ? token.length : 0),
            0,
        ),
    };
}

function record(name: string, value: unknown) {
    const path = resolve(output, name);
    if (write) {
        mkdirSync(output, { recursive: true });
        writeFileSync(path, `${JSON.stringify(value, null, 4)}\n`);
    } else {
        expect(JSON.parse(readFileSync(path, "utf8")), name).toEqual(value);
    }
}

describe("compiler covenant comparison snapshots", () => {
    it("records every optimized and unoptimized leaf, opcode and size delta", () => {
        const comparisons = (["optimized", "unoptimized"] as const).flatMap((optimization) =>
            [...swaps(optimization), ...vhtlc(optimization)].map((row) => ({
                ...row,
                name: `${row.name}/${optimization}`,
                optimization,
            })),
        );
        expect(comparisons.length).toBeGreaterThan(0);
        expect(new Set(comparisons.map((row) => row.name)).size).toBe(comparisons.length);
        const rows = comparisons.map((row) => {
            const manual = {
                leaf: metrics(row.manual.leafHex)!,
                covenant: metrics(row.manual.covenantHex),
            };
            const generated = {
                leaf: metrics(row.generated.leafHex)!,
                covenant: metrics(row.generated.covenantHex),
            };
            expect(manual.leaf.bytes).toBeGreaterThan(0);
            expect(generated.leaf.bytes).toBeGreaterThan(0);
            expect(Boolean(manual.covenant)).toBe(Boolean(generated.covenant));
            return {
                name: row.name,
                source: row.source,
                artifact: row.artifact,
                optimization: row.optimization,
                manual,
                generated,
                equalLeaf: row.manual.leafHex === row.generated.leafHex,
                equalCovenant: row.manual.covenantHex === row.generated.covenantHex,
                deltaLeafBytes: generated.leaf.bytes - manual.leaf.bytes,
                deltaCovenantBytes:
                    (generated.covenant?.bytes ?? 0) - (manual.covenant?.bytes ?? 0),
            };
        });
        const groups = [...new Set(rows.map((row) => row.source))].map((source) => {
            const selected = rows.filter((row) => row.source === source);
            const covenant = selected.filter((row) => row.manual.covenant !== undefined);
            const deltas = covenant.map((row) => row.deltaCovenantBytes);
            return {
                source,
                comparisons: selected.length,
                equalLeaves: selected.filter((row) => row.equalLeaf).length,
                equalCovenants: covenant.filter((row) => row.equalCovenant).length,
                covenantDeltaBytes: deltas.length
                    ? { min: Math.min(...deltas), max: Math.max(...deltas) }
                    : undefined,
                hasV2LengthGuardGap: source.includes("v2-candidate"),
            };
        });
        record("vectors.json", {
            engine: manifest.engineRevision,
            compiler: manifest.compiler,
            comparisons,
        });
        record("sizes.json", {
            compiler: manifest.compiler,
            manualBaseline: manifest.manualBaseline,
            measurement:
                "Script bytes and opcode counts, not complete transaction weight or semantic equivalence",
            groups,
            rows,
        });
        console.table(
            groups.map((group) => ({
                source: group.source,
                leaves: group.comparisons,
                identical: group.equalLeaves,
                covenantDelta: group.covenantDeltaBytes
                    ? `${group.covenantDeltaBytes.min}..${group.covenantDeltaBytes.max}`
                    : "none",
                v2GuardGap: group.hasV2LengthGuardGap,
            })),
        );
    });
});
