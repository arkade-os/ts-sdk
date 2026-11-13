/**
 * Conformance for the `ClaimPacket` TLV body that the Executor's `noninteractiveclaim`
 * template decodes: `0x01` ciphertext, `0x02` arkade script, `0x03` encryption key.
 * The vectors are fixed bytes, not reassembled here, so a framing change fails loudly.
 */
import { describe, expect, it } from "vitest";
import { base64, hex } from "@scure/base";

import { appendArkadeScript, claimPacketShape } from "../src/claimPacket";

const ARKADE_SCRIPT = "5120aabb";
const ENCRYPTION_PUBKEY = "02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";

/** Ordering 0x01, 0x02, 0x03. */
const GO_ORDER =
    "01005d000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142" +
    "434445464748494a4b4c4d4e4f505152535455565758595a5b5c0200045120aabb0300" +
    "2102f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";

/** What our path produces (client seals 0x01+0x03, solver appends 0x02); read back
 * like {@link GO_ORDER}. */
const APPEND_ORDER =
    "01005d000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142" +
    "434445464748494a4b4c4d4e4f505152535455565758595a5b5c03002102f9308a0192" +
    "58c31049344f85f89d5229b531c845836f99b08601f113bce036f90200045120aabb";

/** {@link APPEND_ORDER} before the stamp: the body a client puts on the wire. */
const CLIENT_PART = APPEND_ORDER.slice(0, -"0200045120aabb".length);

const shapeOf = (hexBody: string) => claimPacketShape(base64.encode(hex.decode(hexBody)));

describe("claim packet TLV", () => {
    it("appends 0x02 to the client's body", () => {
        const stamped = appendArkadeScript(hex.decode(CLIENT_PART), hex.decode(ARKADE_SCRIPT));
        expect(hex.encode(stamped)).toBe(APPEND_ORDER);
    });

    it("reads both orderings alike", () => {
        for (const body of [APPEND_ORDER, GO_ORDER]) {
            const shape = shapeOf(body);
            expect(shape.kind).toBe("packet");
            if (shape.kind !== "packet") return;
            expect(shape.needsArkadeScript).toBe(false);
            expect(hex.encode(shape.encryptionPubkey!)).toBe(ENCRYPTION_PUBKEY);
        }
    });

    it("flags the client's own packet as still needing the script", () => {
        // An unstamped packet never claims: the stamp is required.
        const shape = shapeOf(CLIENT_PART);
        expect(shape.kind).toBe("packet");
        if (shape.kind !== "packet") return;
        expect(shape.needsArkadeScript).toBe(true);
        expect(hex.encode(shape.encryptionPubkey!)).toBe(ENCRYPTION_PUBKEY);
    });

    it("reads a body carrying min_amount (0x04) as a packet, stamped or not", () => {
        const withMinAmount = CLIENT_PART + "040008000000000000c350";
        const stamped = hex.encode(
            appendArkadeScript(hex.decode(withMinAmount), hex.decode(ARKADE_SCRIPT)),
        );
        for (const [body, needsArkadeScript] of [
            [withMinAmount, true],
            [stamped, false],
        ] as const) {
            const shape = shapeOf(body);
            expect(shape.kind).toBe("packet");
            if (shape.kind !== "packet") return;
            expect(shape.needsArkadeScript).toBe(needsArkadeScript);
            expect(hex.encode(shape.encryptionPubkey)).toBe(ENCRYPTION_PUBKEY);
        }
    });

    it("reads a bare 93-byte ciphertext as none", () => {
        expect(claimPacketShape(base64.encode(new Uint8Array(93))).kind).toBe("none");
    });

    it("reads a body without 0x03, or a malformed one, as none", () => {
        const withoutKey = Uint8Array.from([0x01, 0x00, 0x5d, ...new Uint8Array(93)]);
        expect(claimPacketShape(base64.encode(withoutKey)).kind).toBe("none");
        expect(shapeOf("0300020102").kind).toBe("none"); // 0x03 at the wrong width
        expect(shapeOf("01ffff00").kind).toBe("none"); // length overruns the buffer
        expect(claimPacketShape("not base64 at all!!").kind).toBe("none");
    });
});
