/**
 * Minimal X.509 for the AWS Nitro attestation chain: every certificate in it uses an ECDSA P-384
 * key and an ecdsa-with-SHA384 signature, so anything else is refused rather than parsed. The
 * fields read come from the same bytes the signatures cover.
 */

import { p384 } from "@noble/curves/nist.js";
import { hex } from "@scure/base";
import { equalBytes } from "@scure/btc-signer/utils.js";

export interface Certificate {
    der: Uint8Array;
    issuer: Uint8Array;
    subject: Uint8Array;
    notBefore: number;
    notAfter: number;
    /** SEC1 uncompressed P-384 point. */
    publicKey: Uint8Array;
    ca: boolean;
    pathLen?: number;
    /** Absent when the certificate has no key usage extension. */
    keyCertSign?: boolean;
    tbs: Uint8Array;
    signature: Uint8Array;
}

const OID = {
    ecdsaWithSha384: "2a8648ce3d040303",
    ecPublicKey: "2a8648ce3d0201",
    secp384r1: "2b81040022",
    basicConstraints: "551d13",
    keyUsage: "551d0f",
};
export function parseCertificate(der: Uint8Array): Certificate {
    const cert = readTlv(der, 0);
    if (cert.tag !== 0x30 || cert.end !== der.length) throw new Error("X.509: not a certificate");
    const [tbs, sigAlg, sigValue] = expectChildren(cert, 3);
    expectAlgorithm(sigAlg, OID.ecdsaWithSha384);

    const fields = children(tbs);
    const [, tbsSigAlg, issuer, validity, subject, spki, ...optional] =
        fields[0]?.tag === 0xa0 ? fields.slice(1) : fields; // skip the explicit version
    if (!spki) throw new Error("X.509: truncated tbsCertificate");
    expectAlgorithm(tbsSigAlg, OID.ecdsaWithSha384);
    const [notBefore, notAfter] = expectChildren(validity, 2).map(decodeTime);

    const [keyAlg, keyBits] = expectChildren(spki, 2);
    const [keyType, curve] = expectChildren(keyAlg, 2);
    if (oid(keyType) !== OID.ecPublicKey || oid(curve) !== OID.secp384r1) {
        throw new Error("X.509: key is not ECDSA P-384");
    }

    const out: Certificate = {
        der,
        issuer: issuer.bytes,
        subject: subject.bytes,
        notBefore,
        notAfter,
        publicKey: bitString(keyBits),
        ca: false,
        tbs: tbs.bytes,
        signature: bitString(sigValue),
    };
    for (const field of optional) {
        if (field.tag === 0xa3) readExtensions(field, out);
    }
    return out;
}

function readExtensions(wrapper: Tlv, out: Certificate): void {
    const [list] = expectChildren(wrapper, 1);
    for (const ext of children(list)) {
        const parts = children(ext);
        const id = oid(parts[0]);
        const critical = parts.length === 3 && parts[1].tag === 0x01 && parts[1].value[0] !== 0;
        const value = parts[parts.length - 1];
        if (value.tag !== 0x04) throw new Error("X.509: malformed extension");
        const inner = readTlv(value.value, 0);
        if (id === OID.basicConstraints) {
            for (const item of children(inner)) {
                if (item.tag === 0x01) out.ca = item.value[0] !== 0;
                if (item.tag === 0x02) out.pathLen = integer(item);
            }
        } else if (id === OID.keyUsage) {
            const bits = inner.value;
            out.keyCertSign = bits.length > 1 && (bits[1] & 0x04) !== 0;
        } else if (critical) {
            // Critical means "refuse me unless you understand me"; only the two above are.
            throw new Error(`X.509: unknown critical extension ${id}`);
        }
    }
}

/**
 * Verify `leaf` up to one of `roots`. `bundle` lists the intermediates root-first, as the NSM's
 * `cabundle` does; a leading copy of the trusted root is skipped. Validity is checked at `nowMs`
 * for every certificate. Returns the parsed leaf.
 */
export function verifyChain(
    leafDer: Uint8Array,
    bundle: Uint8Array[],
    roots: readonly Uint8Array[],
    nowMs: number,
): Certificate {
    const trusted = roots.map(parseCertificate);
    const intermediates = bundle
        .filter((der, i) => i > 0 || !trusted.some((root) => equalBytes(root.der, der)))
        .map(parseCertificate);
    const leaf = parseCertificate(leafDer);
    const firstIssuer = (intermediates[0] ?? leaf).issuer;
    const anchors = trusted.filter((root) => equalBytes(root.subject, firstIssuer));
    if (anchors.length === 0) throw new Error("X.509: chain does not reach a trusted root");

    // Roots can share a name (an old and a new one across a rotation), so try each.
    let failure: unknown;
    for (const anchor of anchors) {
        try {
            verifyPath([anchor, ...intermediates, leaf], nowMs);
            return leaf;
        } catch (err) {
            failure = err;
        }
    }
    throw failure;
}

/** Check `path` (root first, leaf last) link by link, every certificate valid at `nowMs`. */
function verifyPath(path: Certificate[], nowMs: number): void {
    for (const cert of path) {
        if (nowMs < cert.notBefore || nowMs > cert.notAfter) {
            throw new Error("X.509: certificate not valid at the current time");
        }
    }
    for (let j = 0; j + 1 < path.length; j++) {
        const issuer = path[j];
        const child = path[j + 1];
        if (!equalBytes(issuer.subject, child.issuer)) throw new Error("X.509: broken chain");
        if (!issuer.ca || issuer.keyCertSign === false) {
            throw new Error("X.509: issuer is not a certificate authority");
        }
        if (issuer.pathLen !== undefined && issuer.pathLen < path.length - 2 - j) {
            throw new Error("X.509: path length constraint exceeded");
        }
        if (!verifyP384(child.signature, child.tbs, issuer.publicKey, "der")) {
            throw new Error("X.509: invalid certificate signature");
        }
    }
}

/** ECDSA P-384 over SHA-384(msg). Nitro signatures aren't low-S normalized. */
export function verifyP384(
    signature: Uint8Array,
    msg: Uint8Array,
    publicKey: Uint8Array,
    format: "der" | "compact",
): boolean {
    try {
        return p384.verify(signature, msg, publicKey, { format, lowS: false });
    } catch {
        return false;
    }
}

// --- DER ---

interface Tlv {
    tag: number;
    /** Whole element, header included. */
    bytes: Uint8Array;
    value: Uint8Array;
    end: number;
}

function readTlv(buf: Uint8Array, offset: number): Tlv {
    if (offset + 2 > buf.length) throw new Error("DER: truncated");
    const tag = buf[offset];
    if ((tag & 0x1f) === 0x1f) throw new Error("DER: multi-byte tags are not supported");
    let len = buf[offset + 1];
    let start = offset + 2;
    if (len & 0x80) {
        const size = len & 0x7f;
        if (size === 0 || size > 4) throw new Error("DER: unsupported length");

        if (start + size > buf.length) throw new Error("DER: truncated");
        len = 0;
        for (let i = 0; i < size; i++) len = len * 256 + buf[start + i];
        start += size;
    }
    const end = start + len;
    if (end > buf.length) throw new Error("DER: truncated");
    return { tag, bytes: buf.subarray(offset, end), value: buf.subarray(start, end), end };
}

function children(parent: Tlv): Tlv[] {
    const out: Tlv[] = [];
    for (let offset = 0; offset < parent.value.length; ) {
        const child = readTlv(parent.value, offset);
        out.push(child);
        offset = child.end;
    }
    return out;
}

function expectChildren(parent: Tlv | undefined, n: number): Tlv[] {
    const out = parent ? children(parent) : [];
    if (out.length < n) throw new Error("DER: missing fields");
    return out;
}

function expectAlgorithm(alg: Tlv | undefined, expected: string): void {
    const [id, ...params] = expectChildren(alg, 1);
    if (oid(id) !== expected || params.length > 0) {
        throw new Error("X.509: signature algorithm is not ecdsa-with-SHA384");
    }
}

function oid(t: Tlv | undefined): string {
    if (t?.tag !== 0x06) throw new Error("DER: expected an OID");
    return hex.encode(t.value);
}

function integer(t: Tlv): number {
    if (t.value.length === 0 || t.value.length > 4) throw new Error("DER: unsupported integer");
    return t.value.reduce((n, byte) => n * 256 + byte, 0);
}

function bitString(t: Tlv): Uint8Array {
    if (t.tag !== 0x03 || t.value[0] !== 0)
        throw new Error("DER: expected a whole-byte BIT STRING");
    return t.value.subarray(1);
}

function decodeTime(t: Tlv): number {
    const s = new TextDecoder().decode(t.value);
    const m =
        t.tag === 0x17
            ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)
            : t.tag === 0x18
              ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)
              : null;
    if (!m) throw new Error("DER: unsupported time");
    let year = Number(m[1]);
    if (t.tag === 0x17) year += year >= 50 ? 1900 : 2000;
    const [month, day, hour, min, sec] = m.slice(2).map(Number);
    return Date.UTC(year, month - 1, day, hour, min, sec);
}
