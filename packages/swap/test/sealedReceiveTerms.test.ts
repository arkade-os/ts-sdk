import { describe, expect, it } from "vitest";
import { base64, hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { claimPacketShape, sealClaimPacket } from "../src/claimPacket";
import { openClaimPacket } from "./helpers/claimPacket";
import { sealClaimPacketDeterministic } from "./helpers/claimPacket";
import vector from "./fixtures/executorReceiveTerms.json";

const TEMPLATE = "290b7a4364950677c1bab1ae25f9f757da864a71e54eb2ad74b3c43133e57e17";
const PREIMAGE = new Uint8Array(32).fill(7);
const RECEIVER = new Uint8Array(32).fill(8);
const SECRET_KEY = new Uint8Array(32).fill(9);
const PUBLIC_KEY = secp256k1.getPublicKey(SECRET_KEY, true);
const input = (minimumAmount = 1_234n, receiverProgram: Uint8Array = RECEIVER) => ({
    preimage: PREIMAGE,
    encryptionPubkey: PUBLIC_KEY,
    receive: { receiverProgram, minimumAmount },
});
const tlv = (tag: number, value: Uint8Array) =>
    Uint8Array.from([tag, value.length >> 8, value.length & 0xff, ...value]);

describe("sealed receive terms", () => {
    it("matches the fixed vector opened by the executor's Go template", async () => {
        const sealed = await sealClaimPacketDeterministic(
            input(10_000n, hex.decode(vector.receiverProgram)),
            hex.decode(vector.ephemeralKey),
            hex.decode(vector.nonce),
        );
        expect(sealed.packet).toBe(vector.packet);
    });
    it("binds the preimage, receiver and minimal ScriptNum amount to the receive template", async () => {
        const sealed = await sealClaimPacket(input());
        const plaintext = await openClaimPacket(sealed.packet, SECRET_KEY, TEMPLATE);
        expect(hex.encode(plaintext)).toBe(hex.encode(PREIMAGE) + hex.encode(RECEIVER) + "d204");
        await expect(openClaimPacket(sealed.packet, SECRET_KEY)).rejects.toThrow();
        expect(claimPacketShape(sealed.packet).kind).toBe("packet");
    });

    it("rejects invalid receiver and amount constraints before sealing", async () => {
        for (const amount of [0n, -1n, 2_100_000_000_000_001n]) {
            await expect(sealClaimPacket(input(amount))).rejects.toThrow(/amount/);
        }
        await expect(sealClaimPacket(input(1n, RECEIVER.subarray(1)))).rejects.toThrow(/receiver/);
    });
});

describe("variable-length claim ciphertext", () => {
    it("recognizes complete packets carrying larger sealed terms", () => {
        for (const length of [93, 94, 127, 65_535]) {
            const body = Uint8Array.from([
                ...tlv(1, new Uint8Array(length)),
                ...tlv(3, PUBLIC_KEY),
            ]);
            const shape = claimPacketShape(base64.encode(body));
            expect(shape.kind, `${length} bytes`).toBe("packet");
            if (shape.kind === "packet") {
                expect(shape.body).toEqual(body);
                expect(shape.needsArkadeScript).toBe(true);
            }
        }
    });

    it("refuses ciphertext too short to hold a preimage", () => {
        for (const length of [0, 60, 92]) {
            const body = Uint8Array.from([
                ...tlv(1, new Uint8Array(length)),
                ...tlv(3, PUBLIC_KEY),
            ]);
            expect(claimPacketShape(base64.encode(body)).kind).toBe("none");
        }
    });
});
