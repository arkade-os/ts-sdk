import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE, equalBytes } from "@noble/curves/utils.js";
import { BigNum } from "../bignum";
import {
    bn254PairingCheck,
    type Curve,
    curveById,
    ecAdd,
    ecMul,
    liftX,
    type PairingInput,
} from "../ec";
import type { Engine } from "../engine";
import { scriptError } from "../errors";
import type { FamilyHandlers } from "../opcodes";

const INT64_MAX = (1n << 63n) - 1n;
const MAX_EC_PAIRING_COUNT = 16n;

const invalid = (message: string) => scriptError("ErrInvalidStackOperation", message);

// both popCurveID and pair_count test the magnitude (big.Int.IsInt64), never useBig
function popCurve(vm: Engine): Curve {
    const n = vm.dstack.popBigNum();
    if (n.sign() < 0) throw invalid("negative curve id");
    if (n.value > INT64_MAX) throw invalid("curve id out of range");
    const curve = curveById.get(n.value);
    if (!curve) throw invalid(`unsupported curve id ${n.value}`);
    return curve;
}

function popBelow(vm: Engine, bound: bigint, what: string, tooBig: string): bigint {
    const n = vm.dstack.popBigNum();
    if (n.sign() < 0) throw invalid(`negative ${what}`);
    if (n.value >= bound) throw invalid(tooBig);
    return n.value;
}

const popField = (vm: Engine, c: Curve, what: string) =>
    popBelow(vm, c.fieldModulus, what, `${what} not less than field modulus`);

function pushPoint(vm: Engine, [x, y]: [bigint, bigint]): void {
    vm.dstack.pushBigNum(new BigNum(x, true));
    vm.dstack.pushBigNum(new BigNum(y, true));
}

export const ecopsHandlers: FamilyHandlers<"ecops"> = {
    OP_ECADD: (_op, _data, vm) => {
        const c = popCurve(vm);
        const y2 = popField(vm, c, "y2");
        const x2 = popField(vm, c, "x2");
        const y1 = popField(vm, c, "y1");
        const x1 = popField(vm, c, "x1");
        pushPoint(vm, ecAdd(c, x1, y1, x2, y2));
    },
    OP_ECMUL: (_op, _data, vm) => {
        const c = popCurve(vm);
        const k = popBelow(vm, c.groupOrder, "scalar", "scalar not less than group order");
        const y = popField(vm, c, "y");
        const x = popField(vm, c, "x");
        pushPoint(vm, ecMul(c, x, y, k));
    },
    // per pair, bottom to top: g1_x g1_y g2_x_c1 g2_x_c0 g2_y_c1 g2_y_c0 (c1 before c0)
    OP_ECPAIRING: (_op, _data, vm) => {
        const c = popCurve(vm);
        if (!c.supportsPairing) throw invalid(`curve ${c.name} does not support pairing`);
        const count = vm.dstack.popBigNum();
        if (count.sign() < 0) throw invalid("negative pair_count");
        if (count.value > INT64_MAX) throw invalid("pair_count out of range");
        if (count.value < 1n) throw invalid("pair_count must be at least 1");
        if (count.value > MAX_EC_PAIRING_COUNT) {
            throw invalid(`pair_count ${count.value} exceeds max ${MAX_EC_PAIRING_COUNT}`);
        }
        const pairs: PairingInput[] = [];
        for (let i = 0n; i < count.value; i++) {
            const yc0 = popField(vm, c, "g2_y_c0");
            const yc1 = popField(vm, c, "g2_y_c1");
            const xc0 = popField(vm, c, "g2_x_c0");
            const xc1 = popField(vm, c, "g2_x_c1");
            const g1y = popField(vm, c, "g1_y");
            const g1x = popField(vm, c, "g1_x");
            pairs.unshift([g1x, g1y, xc0, xc1, yc0, yc1]);
        }
        vm.dstack.pushBool(bn254PairingCheck(pairs));
    },
    // unlike ECADD/ECMUL: a 32-byte big-endian k and compressed points compared byte-for-byte
    OP_ECMULSCALARVERIFY: (_op, _data, vm) => {
        const Q = vm.dstack.popByteArray();
        const P = vm.dstack.popByteArray();
        const k = vm.dstack.popByteArray();
        if (k.length !== 32) throw invalid("OP_ECMULSCALARVERIFY requires 32-byte scalar");
        if (P.length !== 33) throw invalid("OP_ECMULSCALARVERIFY requires 33-byte compressed P");
        let point: ReturnType<typeof secp256k1.Point.fromBytes>;
        try {
            point = secp256k1.Point.fromBytes(P);
        } catch {
            throw invalid("invalid point P");
        }
        const scalar = bytesToNumberBE(k);
        if (scalar >= secp256k1.Point.CURVE().n)
            throw invalid("scalar k is outside of curve order");
        const kP = point.multiplyUnsafe(scalar);
        // infinity would serialise as 02||0^32 and pass the byte compare
        if (kP.is0()) throw invalid("k*P is the point at infinity");
        if (!equalBytes(Q, kP.toBytes(true))) throw invalid("Q != k*P");
    },
    OP_TWEAKVERIFY: (_op, _data, vm) => {
        const Q = vm.dstack.popByteArray();
        const k = vm.dstack.popByteArray();
        const P = vm.dstack.popByteArray();
        if (P.length !== 32) throw invalid("OP_TWEAKVERIFY requires 32-byte X-only key");
        if (k.length !== 32) throw invalid("OP_TWEAKVERIFY requires 32-byte scalar");
        const scalar = bytesToNumberBE(k);
        if (scalar >= secp256k1.Point.CURVE().n)
            throw invalid("scalar k is outside of curve order");
        const point = liftX(P);
        if (!point) throw invalid("invalid X-only key P");
        const tweaked = point.add(secp256k1.Point.BASE.multiplyUnsafe(scalar));
        if (tweaked.is0()) throw invalid("P + k*G is the point at infinity");
        if (!equalBytes(Q, tweaked.toBytes(true))) throw invalid("Q != P + k*G");
    },
};
