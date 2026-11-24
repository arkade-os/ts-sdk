import type { WeierstrassPoint, WeierstrassPointCons } from "@noble/curves/abstract/weierstrass.js";
import { bn254 } from "@noble/curves/bn254.js";
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { scriptError } from "./errors";

export interface Curve {
    readonly name: string;
    readonly Point: WeierstrassPointCons<bigint>;
    readonly fieldModulus: bigint;
    readonly groupOrder: bigint;
    readonly supportsPairing: boolean;
}

function curve(name: string, Point: WeierstrassPointCons<bigint>, supportsPairing = false): Curve {
    const { p, n } = Point.CURVE();
    return { name, Point, fieldModulus: p, groupOrder: n, supportsPairing };
}

export const curveById: ReadonlyMap<bigint, Curve> = new Map([
    [0n, curve("secp256k1", secp256k1.Point)],
    [1n, curve("secp256r1", p256.Point)],
    [2n, curve("alt_bn128", bn254.G1.Point, true)],
]);

const offCurve = () => scriptError("ErrInvalidStackOperation", "point not on curve");

function isOnCurve<T>(C: WeierstrassPointCons<T>, x: T, y: T): boolean {
    const { Fp } = C;
    const { a, b } = C.CURVE();
    return Fp.eql(Fp.sqr(y), Fp.add(Fp.mul(Fp.add(Fp.sqr(x), a), x), b));
}

// (0, 0) is infinity on every curve; Go special-cases it for P-256, whose IsOnCurve rejects it
function affine<T>(C: WeierstrassPointCons<T>, x: T, y: T): WeierstrassPoint<T> {
    if (C.Fp.is0(x) && C.Fp.is0(y)) return C.ZERO;
    if (!isOnCurve(C, x, y)) throw offCurve();
    return C.fromAffine({ x, y });
}

const coords = (p: WeierstrassPoint<bigint>): [bigint, bigint] => (p.is0() ? [0n, 0n] : [p.x, p.y]);

/** Coordinates and k are already range-checked: 0 <= v < p, 0 <= k < n. */
export function ecAdd(c: Curve, x1: bigint, y1: bigint, x2: bigint, y2: bigint): [bigint, bigint] {
    const p1 = affine(c.Point, x1, y1);
    return coords(p1.add(affine(c.Point, x2, y2)));
}

export const ecMul = (c: Curve, x: bigint, y: bigint, k: bigint): [bigint, bigint] =>
    coords(affine(c.Point, x, y).multiplyUnsafe(k));

/** [g1_x, g1_y, g2_x_c0, g2_x_c1, g2_y_c0, g2_y_c1], in gnark's E2 order. */
export type PairingInput = readonly [bigint, bigint, bigint, bigint, bigint, bigint];

export function bn254PairingCheck(pairs: readonly PairingInput[]): boolean {
    if (pairs.length === 0) {
        throw scriptError("ErrInvalidStackOperation", "pairing check requires at least one pair");
    }
    const terms = pairs.map(([g1x, g1y, xc0, xc1, yc0, yc1]) => {
        const g1 = affine(bn254.G1.Point, g1x, g1y);
        const g2 = affine(bn254.G2.Point, { c0: xc0, c1: xc1 }, { c0: yc0, c1: yc1 });
        // G1 has cofactor 1, G2 does not
        if (!g2.isTorsionFree()) {
            throw scriptError("ErrInvalidStackOperation", "G2 point not in r-subgroup");
        }
        return { g1, g2 };
    });
    // gnark's Miller loop drops infinity pairs, but only after every pair was validated
    const live = terms.filter(({ g1, g2 }) => !g1.is0() && !g2.is0());
    const { Fp12 } = bn254.fields;
    return live.length === 0 || Fp12.eql(bn254.pairingBatch(live), Fp12.ONE);
}

/** BIP-340 lift_x: the even-y secp256k1 point for a 32-byte x, or undefined. */
export function liftX(x: Uint8Array): WeierstrassPoint<bigint> | undefined {
    try {
        return secp256k1.Point.fromBytes(concatBytes(Uint8Array.of(0x02), x));
    } catch {
        return undefined;
    }
}
