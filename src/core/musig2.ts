import { Buff } from "@cmdcode/buff";
import { hash340 } from "@cmdcode/crypto-tools/hash";
import { mod_bytes, mod_n, pt } from "@cmdcode/crypto-tools/math";
import { convert_32b } from "@cmdcode/crypto-tools/keys";
import { CONST, PointData } from "@cmdcode/crypto-tools";
import { NonceContext, util } from "@cmdcode/musig2";

export function combineNonces(pub_nonces: Uint8Array[]): Buff {
    const rounds = 2;
    const members = pub_nonces.map((e) => Buff.parse(e, 32, 64));
    const points = [];
    for (let j = 0; j < rounds; j++) {
        let group_R = null;
        for (const nonces of members) {
            const nonce = nonces[j];
            const n_pt = pt.lift_x(nonce);
            group_R = pt.add(group_R, n_pt);
        }
        if (group_R === null) {
            group_R = CONST._G;
        }
        points.push(group_R);
    }
    return util.parse_points(points);
}

// override get_nonce_ctx to build a context from the combined nonce
export function getNonceCtx(
    combinedNonce: Uint8Array,
    combinedKey: Uint8Array,
    message: Uint8Array
): NonceContext {
    const nonceCoeff = get_nonce_coeff(combinedNonce, combinedKey, message);
    const Rpoint = compute_R(combinedNonce, nonceCoeff);
    const int_nonce = pt.to_bytes(Rpoint);
    const nonce_state = get_pt_state(Rpoint);
    const group_rx = pt.to_bytes(nonce_state.point).slice(1);
    const challenge = get_challenge(group_rx, combinedKey, message);
    return {
        group_nonce: Buff.bytes(combinedNonce),
        nonce_coeff: nonceCoeff,
        int_nonce,
        nonce_state,
        group_rx,
        challenge,
        message: Buff.bytes(message),
        pub_nonces: [],
    };
}

function get_nonce_coeff(
    group_nonce: Uint8Array,
    group_key: Uint8Array,
    message: Uint8Array
) {
    const gpx = convert_32b(group_key);
    const preimg = Buff.bytes([group_nonce, gpx, message]);
    const bytes = hash340("MuSig/noncecoef", preimg);
    const coeff = mod_n(bytes.big);
    return Buff.bytes(coeff, 32);
}

function compute_R(group_nonce: Uint8Array, nonce_coeff: Uint8Array) {
    const nonces = Buff.parse(group_nonce, 33, 66);
    const ncoeff = Buff.bytes(nonce_coeff);
    let R = null;
    for (let j = 0; j < nonces.length; j++) {
        const c = mod_n(ncoeff.big ** BigInt(j));
        const NC = pt.lift_x(nonces[j]);
        pt.assert_valid(NC);
        const Rj = pt.mul(NC, c);
        R = pt.add(R, Rj);
    }
    pt.assert_valid(R);
    return R;
}

function get_challenge(
    group_rx: Uint8Array,
    group_pub: Uint8Array,
    message: Uint8Array
) {
    const grx = convert_32b(group_rx);
    const gpx = convert_32b(group_pub);
    const preimg = Buff.join([grx, gpx, message]);
    return hash340("BIP0340/challenge", preimg);
}

function get_pt_state(int_pt: PointData, tweaks: Uint8Array[] = []) {
    const ints = tweaks.map((e) => mod_bytes(e).big);
    const pos = BigInt(1);
    const neg = CONST._N - pos;
    let point = int_pt,
        parity = pos,
        state = pos,
        tweak = 0n;
    for (const t of ints) {
        parity = !pt.is_even(point) ? neg : pos;
        point = pt.add(pt.mul(point, parity), pt.mul(CONST._G, t))!;
        pt.assert_valid(point);
        state = mod_n(parity * state);
        tweak = mod_n(t + parity * tweak);
    }
    parity = !pt.is_even(point) ? neg : pos;
    return {
        point,
        parity,
        state,
        tweak,
    };
}
