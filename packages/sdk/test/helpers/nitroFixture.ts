/**
 * Synthetic AWS Nitro attestation documents: a P-384 root → intermediate → leaf chain built with
 * a tiny DER writer, a COSE_Sign1 by the leaf, and the runtime's 79-byte `user_data`. Tests pass
 * `rootDer` as the trusted root in place of AWS's.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { p384 } from "@noble/curves/nist.js";
import { hex } from "@scure/base";
import { encodeCbor } from "../../src/enclave/cbor";

// --- DER writer ---

function tlv(tag: number, ...contents: Uint8Array[]): Uint8Array {
    const body = concat(...contents);
    const len =
        body.length < 0x80
            ? [body.length]
            : body.length < 0x100
              ? [0x81, body.length]
              : [0x82, body.length >> 8, body.length & 0xff];
    return concat(Uint8Array.of(tag, ...len), body);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

const seq = (...items: Uint8Array[]) => tlv(0x30, ...items);
const oid = (hexValue: string) => tlv(0x06, hex.decode(hexValue));
const bool = (value: boolean) => tlv(0x01, Uint8Array.of(value ? 0xff : 0));
const int = (value: number) => tlv(0x02, Uint8Array.of(value));
const octets = (value: Uint8Array) => tlv(0x04, value);
const bits = (value: Uint8Array, unused = 0) => tlv(0x03, Uint8Array.of(unused), value);
const name = (cn: string) =>
    seq(tlv(0x31, seq(oid("550403"), tlv(0x0c, new TextEncoder().encode(cn)))));

function utcTime(ms: number): Uint8Array {
    const iso = new Date(ms).toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
    const s = iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10) + iso.slice(11, 13);
    return tlv(0x17, new TextEncoder().encode(`${s}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`));
}

const ECDSA_SHA384 = seq(oid("2a8648ce3d040303"));

export interface CertOptions {
    subject: string;
    issuer: string;
    publicKey: Uint8Array;
    issuerKey: Uint8Array;
    ca: boolean;
    pathLen?: number;
    notBefore?: number;
    notAfter?: number;
    /** Adds a critical extension the verifier doesn't know. */
    unknownCritical?: boolean;
}

export const DAY = 24 * 60 * 60 * 1000;

export function makeCert(o: CertOptions): Uint8Array {
    const now = Date.now();
    const basic = seq(
        ...(o.ca ? [bool(true)] : []),
        ...(o.pathLen !== undefined ? [int(o.pathLen)] : []),
    );
    const extensions = [
        seq(oid("551d13"), bool(true), octets(basic)),
        // keyCertSign | cRLSign for CAs, digitalSignature for the leaf
        seq(oid("551d0f"), bool(true), octets(bits(Uint8Array.of(o.ca ? 0x06 : 0x80), 1))),
        ...(o.unknownCritical ? [seq(oid("2a0304"), bool(true), octets(seq()))] : []),
    ];
    const tbs = seq(
        tlv(0xa0, int(2)),
        int(1),
        ECDSA_SHA384,
        name(o.issuer),
        seq(utcTime(o.notBefore ?? now - DAY), utcTime(o.notAfter ?? now + DAY)),
        name(o.subject),
        seq(seq(oid("2a8648ce3d0201"), oid("2b81040022")), bits(o.publicKey)),
        tlv(0xa3, seq(...extensions)),
    );
    const signature = p384.sign(tbs, o.issuerKey, { format: "der" });
    return seq(tbs, ECDSA_SHA384, bits(signature));
}

export function p384Keys() {
    const secretKey = p384.utils.randomSecretKey();
    return { secretKey, publicKey: p384.getPublicKey(secretKey, false) };
}

export interface NitroFixture {
    doc: Uint8Array;
    rootDer: Uint8Array;
    /** Ed25519 key pair the runtime would sign responses with. */
    signingSecret: Uint8Array;
    signingKey: Uint8Array;
    nonce: Uint8Array;
    pcr0: string;
}

export interface NitroChain {
    rootDer: Uint8Array;
    interDer: Uint8Array;
    leafDer: Uint8Array;
    interSecret: Uint8Array;
    leafSecret: Uint8Array;
}

/** root → intermediate → leaf, as the NSM's cabundle and certificate carry it. */
export function makeNitroChain(): NitroChain {
    const root = p384Keys();
    const inter = p384Keys();
    const leaf = p384Keys();
    const rootDer = makeCert({
        subject: "root",
        issuer: "root",
        publicKey: root.publicKey,
        issuerKey: root.secretKey,
        ca: true,
    });
    const interDer = makeCert({
        subject: "intermediate",
        issuer: "root",
        publicKey: inter.publicKey,
        issuerKey: root.secretKey,
        ca: true,
        pathLen: 0,
    });
    const leafDer = makeCert({
        subject: "leaf",
        issuer: "intermediate",
        publicKey: leaf.publicKey,
        issuerKey: inter.secretKey,
        ca: false,
    });
    return { rootDer, interDer, leafDer, interSecret: inter.secretKey, leafSecret: leaf.secretKey };
}

export interface FixtureOptions {
    /** Reuse a chain, so a test knows the root to trust before the document exists. */
    chain?: NitroChain;
    nonce?: Uint8Array;
    pcr0?: Uint8Array;
    userData?: Uint8Array;
    /** Sign the COSE envelope with a key other than the leaf's. */
    wrongCoseKey?: boolean;
}

export function makeNitroFixture(opts: FixtureOptions = {}): NitroFixture {
    const { rootDer, interDer, leafDer, interSecret, leafSecret } = opts.chain ?? makeNitroChain();

    const signingSecret = ed25519.utils.randomSecretKey();
    const signingKey = ed25519.getPublicKey(signingSecret);
    const nonce = opts.nonce ?? Uint8Array.from({ length: 20 }, (_, i) => i + 1);
    const pcr0 = opts.pcr0 ?? new Uint8Array(48).fill(0xab);
    const userData =
        opts.userData ??
        concat(
            new TextEncoder().encode("sha256:"),
            new Uint8Array(32).fill(7),
            new TextEncoder().encode("ed25519:"),
            signingKey,
        );

    const payload = encodeCbor(
        new Map<string, any>([
            ["module_id", "i-test-enc"],
            ["digest", "SHA384"],
            ["timestamp", Date.now()],
            [
                "pcrs",
                new Map([
                    [0, pcr0],
                    [1, new Uint8Array(48)],
                ]),
            ],
            ["certificate", leafDer],
            ["cabundle", [rootDer, interDer]],
            ["public_key", null],
            ["user_data", userData],
            ["nonce", nonce],
        ]),
    );
    const protectedHeader = encodeCbor(new Map([[1, -35]]));
    const sigStructure = encodeCbor(["Signature1", protectedHeader, new Uint8Array(0), payload]);
    const coseKey = opts.wrongCoseKey ? interSecret : leafSecret;
    const signature = p384.sign(sigStructure, coseKey, { format: "compact" });
    const doc = encodeCbor([protectedHeader, new Map(), payload, signature]);
    return { doc, rootDer, signingSecret, signingKey, nonce, pcr0: hex.encode(pcr0) };
}
