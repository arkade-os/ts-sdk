/**
 * Cross-implementation conformance for the `ClaimPacket` TLV body.
 *
 * covclaimd's Go is the authority — it is what reads the packet off the arkd
 * stream and claims — so the two vectors below were PRINTED BY IT, from
 * `preimage.ClaimPacket.Serialize` and `DeserializeClaim` at covclaimd@56cfd78,
 * and are pasted verbatim rather than reassembled here. Together with the
 * sealing vector in `claimPacket.test.ts`, which covclaimd's `preimage.Decrypt`
 * opens, this is what `TODO(claim-packet-vectors)` asked for.
 *
 * The gap this closes: one format, three implementations — Go here, this
 * package encoding, the solver decoding — and no compiler between them. A
 * desync in exactly that seam shipped a claim_packet no solver could stamp.
 */
import { describe, expect, it } from "vitest";
import { base64, hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";

import {
    appendArkadeScript,
    claimPacketShape,
    sealClaimPacket,
    SEALED_CIPHERTEXT_LENGTH,
} from "../src/claimPacket";

const ARKADE_SCRIPT = "5120aabb";
const COVCLAIMD_PUBKEY = "02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";

/** covclaimd `Serialize()`'s own ordering: 0x01, 0x02, 0x03. */
const GO_ORDER =
    "01005d000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142" +
    "434445464748494a4b4c4d4e4f505152535455565758595a5b5c0200045120aabb0300" +
    "2102f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";

/** What OUR path produces — client seals 0x01+0x03, solver appends 0x02 — and
 * which `DeserializeClaim` accepted as equivalent to {@link GO_ORDER}. */
const APPEND_ORDER =
    "01005d000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142" +
    "434445464748494a4b4c4d4e4f505152535455565758595a5b5c03002102f9308a0192" +
    "58c31049344f85f89d5229b531c845836f99b08601f113bce036f90200045120aabb";

/** {@link APPEND_ORDER} before the stamp: the body a client puts on the wire. */
const CLIENT_PART = APPEND_ORDER.slice(0, -"0200045120aabb".length);

const shapeOf = (hexBody: string) => claimPacketShape(base64.encode(hex.decode(hexBody)));

describe("claim packet TLV, against covclaimd's own bytes", () => {
    it("appends 0x02 to exactly the body covclaimd deserialized", () => {
        const stamped = appendArkadeScript(hex.decode(CLIENT_PART), hex.decode(ARKADE_SCRIPT));
        expect(hex.encode(stamped)).toBe(APPEND_ORDER);
    });

    it("reads both orderings alike, as the Go's switch loop does", () => {
        for (const body of [APPEND_ORDER, GO_ORDER]) {
            const shape = shapeOf(body);
            expect(shape.kind).toBe("packet");
            if (shape.kind !== "packet") return;
            expect(shape.needsArkadeScript).toBe(false);
            expect(hex.encode(shape.covclaimdPubkey!)).toBe(COVCLAIMD_PUBKEY);
        }
    });

    it("flags the client's own packet as still needing the script", () => {
        // covclaimd REJECTS this body outright — `DeserializeClaim` returns
        // "missing arkade_script TLV (0x02)", confirmed by running it. The
        // stamp is not an optimisation; an unstamped packet never claims.
        const shape = shapeOf(CLIENT_PART);
        expect(shape.kind).toBe("packet");
        if (shape.kind !== "packet") return;
        expect(shape.needsArkadeScript).toBe(true);
        expect(hex.encode(shape.covclaimdPubkey!)).toBe(COVCLAIMD_PUBKEY);
    });

    it("reads a bare sealed ciphertext as the legacy shape", () => {
        expect(claimPacketShape(base64.encode(new Uint8Array(93))).kind).toBe("ciphertext");
    });

    it("keeps the legacy shape when a TLV body is malformed", () => {
        expect(shapeOf("0300020102").kind).toBe("ciphertext"); // 0x03 at the wrong width
        expect(shapeOf("01ffff00").kind).toBe("ciphertext"); // length overruns the buffer
        expect(claimPacketShape("not base64 at all!!").kind).toBe("ciphertext");
    });

    it("seals to the length the shape discriminator keys on", async () => {
        const sealed = await sealClaimPacket({
            preimage: new Uint8Array(32).fill(7),
            covclaimdPubkey: secp256k1.getPublicKey(new Uint8Array(32).fill(0x22), true),
        });
        expect(base64.decode(sealed.ciphertext)).toHaveLength(SEALED_CIPHERTEXT_LENGTH);
        const shape = claimPacketShape(sealed.packet);
        expect(shape.kind).toBe("packet");
        if (shape.kind !== "packet") return;
        expect(shape.needsArkadeScript).toBe(true);
    });
});
