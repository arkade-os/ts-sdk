import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { banco, asset } from "../../../src";
import { gcd } from "../../../src/utils/math";

const { BancoSwap } = banco;

// ── Fixtures ──

const makerPkScript = new Uint8Array(34);
makerPkScript[0] = 0x51;
makerPkScript[1] = 0x20;
makerPkScript.fill(0xaa, 2);

const makerPublicKey = new Uint8Array(32).fill(0x01);
const serverPubkey = new Uint8Array(32).fill(0x02);
const introspectorPubkey = hex.decode(
    "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
);

const assetX = asset.AssetId.create(
    "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
    0
);
const assetY = asset.AssetId.create(
    "1111111111111111111111111111111111111111111111111111111111111111",
    1
);

const exitTimelock = { value: 512n, type: "seconds" as const };

const ratioNum = 100n;
const ratioDen = 1n;

function makeSwap(overrides: Partial<banco.BancoSwapParams> = {}): BancoSwap {
    return new BancoSwap(
        {
            wantAmount: 5n,
            want: assetX,
            exitTimelock,
            makerPkScript,
            makerPublicKey,
            ...overrides,
        },
        serverPubkey,
        [introspectorPubkey]
    );
}

function computeConsumed(fillAmount: bigint, num: bigint, den: bigint): bigint {
    return (fillAmount * num) / den;
}

// ── Tests ──

describe("BancoSwap", () => {
    describe("covenantScript dispatch", () => {
        it("uses fulfillScript when no ratio, partialFillScript when ratio set", () => {
            const full = makeSwap();
            const partial = makeSwap({ ratioNum, ratioDen });
            expect(hex.encode(full.covenantScript())).toBe(
                hex.encode(full.fulfillScript())
            );
            expect(hex.encode(partial.covenantScript())).toBe(
                hex.encode(partial.partialFillScript())
            );
        });
    });

    it("rejects same-asset swap (offer == want)", () => {
        expect(() => makeSwap({ offer: "btc", want: "btc" })).toThrow(
            "same-asset swaps are not supported"
        );
        expect(() => makeSwap({ offer: assetX, want: assetX })).toThrow(
            "same-asset swaps are not supported"
        );
    });

    describe("partialFillScript", () => {
        it("offer defaults to btc (backward compatible)", () => {
            const explicit = makeSwap({
                offer: "btc",
                want: assetX,
                ratioNum,
                ratioDen,
            });
            const implicit = makeSwap({ want: assetX, ratioNum, ratioDen });
            expect(hex.encode(explicit.partialFillScript())).toBe(
                hex.encode(implicit.partialFillScript())
            );
        });

        it("all three directions produce different scripts", () => {
            const scripts = [
                makeSwap({ offer: "btc", want: assetX, ratioNum, ratioDen }),
                makeSwap({ offer: assetX, want: "btc", ratioNum, ratioDen }),
                makeSwap({ offer: assetX, want: assetY, ratioNum, ratioDen }),
            ].map((s) => hex.encode(s.partialFillScript()));
            expect(new Set(scripts).size).toBe(3);
        });
    });
});

describe("Ratio arithmetic", () => {
    it("spec worked example: two sequential partial fills", () => {
        const c1 = computeConsumed(2n, 100_000_000n, 5n);
        expect(c1).toBe(40_000_000n);
        expect(100_000_000n - c1).toBe(60_000_000n);

        const c2 = computeConsumed(3n, 100_000_000n, 5n);
        expect(c2).toBe(60_000_000n);
        expect(c2 >= 60_000_000n).toBe(true);
    });

    it("floor rounding: dust accumulates in change", () => {
        let remaining = 100n;
        for (let i = 0; i < 3; i++) remaining -= computeConsumed(1n, 100n, 3n);
        expect(remaining).toBe(1n);
    });

    it("small fill can round consumed to 0", () => {
        expect(computeConsumed(1n, 1n, 1000n)).toBe(0n);
        expect(computeConsumed(100n, 1n, 100n)).toBe(1n);
    });

    it("GCD reduction preserves consumed", () => {
        const g = gcd(10_000_000_000n, 2_000_000_000n);
        const nR = 10_000_000_000n / g;
        const dR = 2_000_000_000n / g;
        expect(nR).toBe(5n);
        for (const fill of [1n, 7n, 999n]) {
            expect(computeConsumed(fill, nR, dR)).toBe(
                computeConsumed(fill, 10_000_000_000n, 2_000_000_000n)
            );
        }
    });
});
