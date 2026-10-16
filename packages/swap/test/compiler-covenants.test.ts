import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { arkade, timelockToSequence } from "@arkade-os/sdk";
import { bindings, comparisons } from "./compiler-covenants.fixtures";

const variants = ["optimized", "unoptimized"] as const;
const cases = variants.flatMap((variant) =>
    bindings(variant).map((binding) => ({ ...binding, variant })),
);

describe("compiler-generated swap covenants", () => {
    it.each(cases)(
        "preserves constraints and records byte differences: $variant/$name",
        ({ manual, generated, offer, args, variant }) => {
            expect(generated.compiled.map(({ name }) => name)).toEqual(
                manual.compiled.map(({ name }) => name),
            );
            const manualFulfill = manual.compiled[0];
            const generatedFulfill = generated.compiled[0];
            expect(generatedFulfill.arkadeScript).not.toEqual(manualFulfill.arkadeScript);
            expect(generatedFulfill.arkadeScript!.length).toBeGreaterThan(
                manualFulfill.arkadeScript!.length,
            );
            expect(generatedFulfill.leafScript.length).toBe(manualFulfill.leafScript.length);
            expect(generatedFulfill.leafScript).not.toEqual(manualFulfill.leafScript);
            expect(generated.pkScript).not.toEqual(manual.pkScript);
            expect(
                generated.compiled.slice(1).map(({ leafScript }) => hex.encode(leafScript)),
            ).toEqual(manual.compiled.slice(1).map(({ leafScript }) => hex.encode(leafScript)));
            const asm = generatedFulfill.def.arkadeScript!.asm;
            expect(asm.filter((token) => token === "INSPECTOUTPUTSCRIPTPUBKEY")).toHaveLength(2);
            expect(asm).toContain(variant === "optimized" ? "EQUALVERIFY" : "EQUAL");
            expect(asm).toContain("VERIFY");
            expect(asm).toContain("$makerWP");
            expect(asm).toContain("$wantAmount");
            if (offer.wantAsset) {
                expect(args.wantAssetTxid).toEqual(offer.wantAsset.txid.slice().reverse());
                expect(asm).toContain("$wantAssetGroupIndex");
                expect(asm).toContain("INSPECTOUTASSETLOOKUP");
                expect(asm).toContain("VERIFY");
            } else {
                expect(asm).toContain("INSPECTOUTPUTVALUE");
            }
            if (offer.exitDelay) {
                const exit = generated.compiled[2];
                const expected = arkade.resolveAsm(
                    [
                        BigInt(timelockToSequence(offer.exitDelay)),
                        "CHECKSEQUENCEVERIFY",
                        "DROP",
                        offer.makerPublicKey,
                        "CHECKSIG",
                    ],
                    {},
                );
                expect(exit.leafScript).toEqual(expected);
            }
        },
    );

    it("provides every leaf and both covenant forms to the shared report", () => {
        const rows = variants.flatMap((variant) =>
            comparisons(variant).map((row) => ({ ...row, name: `${variant}/${row.name}` })),
        );
        expect(rows).toHaveLength(192);
        expect(new Set(rows.map(({ name }) => name)).size).toBe(rows.length);
        expect(rows.filter(({ name }) => name.endsWith("/fulfill"))).toHaveLength(72);
        expect(
            rows.every(
                ({ manual, generated }) => manual.leafHex.length === generated.leafHex.length,
            ),
        ).toBe(true);
    });
});
