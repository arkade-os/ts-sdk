import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { Script, ScriptNum } from "@scure/btc-signer";
import { hash160 } from "@scure/btc-signer/utils.js";
import { ArkadeScript } from "../src/arkade/script";
import { VtxoScript } from "../src/script/base";
import { comparisons, fixture, leafNames, profiles } from "./compiler-vhtlc.fixtures";

function hashlockAccepts(leafHex: string, preimage: Uint8Array): boolean {
    const stack: (Uint8Array | number)[] = [preimage];
    for (const token of Script.decode(hex.decode(leafHex))) {
        if (typeof token !== "string") {
            stack.push(token);
            continue;
        }
        if (token === "SIZE")
            stack.push(
                ScriptNum(undefined, true).encode(BigInt((stack.at(-1) as Uint8Array).length)),
            );
        else if (token === "HASH160") stack.push(hash160(stack.pop() as Uint8Array));
        else if (token === "EQUAL" || token === "EQUALVERIFY") {
            const right = stack.pop();
            const left = stack.pop();
            const equal =
                left instanceof Uint8Array && right instanceof Uint8Array
                    ? hex.encode(left) === hex.encode(right)
                    : left === right;
            if (token === "EQUALVERIFY" && !equal) return false;
            if (token === "EQUAL") stack.push(equal ? 1 : 0);
        } else if (token === "VERIFY") {
            return stack.pop() === 1;
        } else {
            throw new Error(`Unexpected hashlock opcode ${token}`);
        }
    }
    throw new Error("Missing hashlock VERIFY");
}

describe("VHTLC compiler comparison candidates", () => {
    for (const profile of profiles) {
        for (const denomination of ["btc", "asset"] as const) {
            for (const legacy of [false, true]) {
                it(`preserves V1 signature leaves and the ${profile.name}/${denomination}/${legacy ? "legacy" : "full"} path inventory`, () => {
                    const data = fixture("v1", denomination, profile, legacy);
                    const expected = leafNames.filter(
                        (name) => !legacy || name !== "nonInteractiveRefundWithoutReceiver",
                    );
                    expect(data.rows.map((row) => row.context.path)).toEqual(expected);
                    expect(data.manual.scripts).toHaveLength(legacy ? 8 : 9);
                    for (const row of data.rows.filter((row) => row.kind === "tapscript")) {
                        expect(row.generated.leafHex).toBe(row.manual.leafHex);
                    }
                    const candidateTree = new VtxoScript(
                        data.rows.map((row) => hex.decode(row.generated.leafHex)),
                    );
                    expect(candidateTree.scripts).toHaveLength(legacy ? 8 : 9);
                    expect(hex.encode(candidateTree.pkScript)).not.toBe(
                        hex.encode(data.manual.pkScript),
                    );
                    for (const path of [
                        "nonInteractiveClaim",
                        "nonInteractiveRefund",
                        "nonInteractiveRefundWithoutReceiver",
                    ]) {
                        const row = data.rows.find((entry) => entry.context.path === path);
                        if (!row) continue;
                        expect(row.generated.covenantHex).not.toBe(row.manual.covenantHex);
                        expect(row.generated.leafHex).not.toBe(row.manual.leafHex);
                    }
                });
            }
        }
    }

    it("keeps input/output asset presence, exact output count, sats and witness-version checks", () => {
        for (const version of ["v1", "v2"] as const) {
            const data = fixture(version, "asset", profiles[0]);
            const claim = data.rows.find((row) => row.context.path === "nonInteractiveClaim")!;
            const operations = ArkadeScript.decode(hex.decode(claim.generated.covenantHex!));
            const lookupOutput = operations.indexOf("INSPECTOUTASSETLOOKUP");
            const lookupInput = operations.indexOf("INSPECTINASSETLOOKUP");
            expect(operations[lookupOutput + 1]).toBe("VERIFY");
            expect(operations[lookupInput + 1]).toBe("VERIFY");
            expect(operations).toContain("INSPECTOUTASSETCOUNT");
            expect(operations.filter((op) => op === "INSPECTOUTPUTSCRIPTPUBKEY")).toHaveLength(2);
            expect(operations).toContain("INSPECTINPUTVALUE");
            expect(operations).toContain("INSPECTOUTPUTVALUE");
            expect(operations.filter((op) => op === "GREATERTHANOREQUAL")).toHaveLength(2);
            const pushedBytes = operations
                .filter((op): op is Uint8Array => op instanceof Uint8Array)
                .map((op) => hex.encode(op));
            expect(pushedBytes).toContain(claim.context.inputAsset!.wireTxidHex);
            expect(pushedBytes).not.toContain(claim.context.inputAsset!.txidHex);
            const refund = data.rows.find((row) => row.context.path === "nonInteractiveRefund")!;
            const timeout = data.rows.find(
                (row) => row.context.path === "nonInteractiveRefundWithoutReceiver",
            )!;
            expect(timeout.generated.covenantHex).toBe(refund.generated.covenantHex);
            expect(timeout.manual.covenantHex).toBe(refund.manual.covenantHex);
        }
    });

    it("enforces the mandatory 32-byte hashlock guard in typed V2 candidates", () => {
        const data = fixture("v2", "btc", profiles[0]);
        const declaredClaim = data.signatureArtifact.value.functions.find(
            (group) => group.name === "claim",
        )!;
        expect(declaredClaim.leaves[0].witness![0].type).toBe("bytes32");
        for (const path of ["claim", "unilateralClaim", "nonInteractiveClaim"]) {
            const row = data.rows.find((entry) => entry.context.path === path)!;
            expect(Script.decode(hex.decode(row.manual.leafHex)).slice(0, 3)).toEqual([
                "SIZE",
                new Uint8Array([32]),
                "EQUALVERIFY",
            ]);
            expect(Script.decode(hex.decode(row.generated.leafHex)).slice(0, 3)).toEqual([
                "SIZE",
                new Uint8Array([32]),
                "EQUALVERIFY",
            ]);
            expect(hashlockAccepts(row.manual.leafHex, data.preimage)).toBe(true);
            expect(hashlockAccepts(row.generated.leafHex, data.preimage)).toBe(true);
        }
    });

    for (const length of [31, 33]) {
        it(`rejects a real hash-matching ${length}-byte preimage in both V2 implementations`, () => {
            for (const denomination of ["btc", "asset"] as const) {
                const v1 = fixture("v1", denomination, profiles[0], false, length);
                const v2 = fixture("v2", denomination, profiles[0], false, length);
                expect(hex.encode(hash160(v2.preimage))).toBe(hex.encode(v2.options.preimageHash));
                for (const path of ["claim", "unilateralClaim", "nonInteractiveClaim"]) {
                    const old = v1.rows.find((entry) => entry.context.path === path)!;
                    const current = v2.rows.find((entry) => entry.context.path === path)!;
                    expect(hashlockAccepts(old.manual.leafHex, v1.preimage)).toBe(true);
                    expect(hashlockAccepts(old.generated.leafHex, v1.preimage)).toBe(true);
                    expect(hashlockAccepts(current.manual.leafHex, v2.preimage)).toBe(false);
                    expect(hashlockAccepts(current.generated.leafHex, v2.preimage)).toBe(false);
                }
            }
        });
    }

    it("exports full variant rows with separate manual/generated signing material", () => {
        const rows = comparisons();
        expect(rows).toHaveLength(296);
        expect(new Set(rows.map((row) => row.name)).size).toBe(rows.length);
        for (const row of rows) {
            expect(Object.keys(row.manual.keySecrets).length).toBe(row.kind === "covenant" ? 5 : 4);
            expect(Object.keys(row.generated.keySecrets).length).toBe(
                row.kind === "covenant" ? 5 : 4,
            );
        }
    });
});
