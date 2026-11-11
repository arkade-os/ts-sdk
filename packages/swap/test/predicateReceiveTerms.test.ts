import { describe, expect, it } from "vitest";
import { base64, hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
    appendArkadeScript,
    claimPacketShape,
    EXECUTOR_PREDICATE_RECEIVE_TEMPLATE_ID,
    EXECUTOR_RECEIVE_TEMPLATE_ID,
    sealClaimPacket,
} from "../src/claimPacket";
import { ciphertextOf, openClaimPacket, sealClaimPacketDeterministic } from "./helpers/claimPacket";
import vector from "./fixtures/executorReceivePredicate.json";
import amountVector from "./fixtures/executorReceiveAmountPredicate.json";

const PREIMAGE = new Uint8Array(32).fill(7);
const RECEIVER = new Uint8Array(32).fill(8);
const SECRET_KEY = new Uint8Array(32).fill(9);
const PUBLIC_KEY = secp256k1.getPublicKey(SECRET_KEY, true);
const input = (predicate: Uint8Array) => ({
    preimage: PREIMAGE,
    encryptionPubkey: PUBLIC_KEY,
    receive: { receiverProgram: RECEIVER, minimumAmount: 1_234n, predicate },
});

describe("sealed receive predicates", () => {
    it.each([vector, amountVector])("matches the shared Go vector for $predicate", async (v) => {
        const sealed = await sealClaimPacketDeterministic(
            {
                preimage: hex.decode(v.preimage),
                encryptionPubkey: secp256k1.getPublicKey(hex.decode(v.recipientSecretKey), true),
                receive: {
                    receiverProgram: hex.decode(v.receiverProgram),
                    minimumAmount: BigInt(v.minimumAmount),
                    predicate: hex.decode(v.predicate),
                },
            },
            hex.decode(v.ephemeralKey),
            hex.decode(v.nonce),
        );
        expect(sealed.packet).toBe(v.packet);
        expect(EXECUTOR_PREDICATE_RECEIVE_TEMPLATE_ID).toBe(v.templateId);
    });

    it("authenticates the program hash alongside the fixed receive terms", async () => {
        const predicate = Uint8Array.of(0x51);
        const sealed = await sealClaimPacket(input(predicate));
        const plaintext = await openClaimPacket(
            sealed.packet,
            SECRET_KEY,
            EXECUTOR_PREDICATE_RECEIVE_TEMPLATE_ID,
        );
        expect(EXECUTOR_PREDICATE_RECEIVE_TEMPLATE_ID).toMatch(/^[0-9a-f]{64}$/);
        expect(hex.encode(plaintext)).toBe(
            hex.encode(PREIMAGE) + hex.encode(RECEIVER) + hex.encode(sha256(predicate)) + "d204",
        );
        await expect(
            openClaimPacket(sealed.packet, SECRET_KEY, EXECUTOR_RECEIVE_TEMPLATE_ID),
        ).rejects.toThrow();
        await expect(openClaimPacket(sealed.packet, SECRET_KEY)).rejects.toThrow();
    });

    it("carries the exact program in TLV5 and preserves it when the solver stamps TLV2", async () => {
        const predicate = Uint8Array.of(0x51, 0x51, 0x87);
        const sealed = await sealClaimPacket(input(predicate));
        const raw = base64.decode(sealed.packet);
        const ciphertext = ciphertextOf(sealed.packet);
        const afterCiphertext = 3 + ciphertext.length;
        expect(raw.subarray(afterCiphertext, afterCiphertext + 36)).toEqual(
            Uint8Array.from([3, 0, 33, ...PUBLIC_KEY]),
        );
        expect(raw.subarray(afterCiphertext + 36)).toEqual(
            Uint8Array.from([5, 0, 3, ...predicate]),
        );
        const stamped = appendArkadeScript(raw, Uint8Array.of(0x51));
        expect(stamped.subarray(0, raw.length)).toEqual(raw);
        expect(claimPacketShape(base64.encode(stamped))).toMatchObject({
            kind: "packet",
            body: stamped,
            needsArkadeScript: false,
        });
    });

    it("rejects empty and oversized programs before elliptic-curve sealing", async () => {
        for (const size of [0, 521]) {
            await expect(
                sealClaimPacketDeterministic(
                    input(new Uint8Array(size)),
                    new Uint8Array(32),
                    new Uint8Array(12),
                ),
            ).rejects.toThrow(/predicate.*1.*520/);
        }
    });

    it("accepts the maximum transport size and leaves opcode validation to the engine", async () => {
        const predicate = new Uint8Array(520).fill(0x51);
        const sealed = await sealClaimPacket(input(predicate));
        const raw = base64.decode(sealed.packet);
        expect(raw.subarray(raw.length - 523)).toEqual(Uint8Array.from([5, 2, 8, ...predicate]));
    });

    it("never replaces an explicitly false condition with OP_TRUE", async () => {
        const sealed = await sealClaimPacket(input(Uint8Array.of(0)));
        expect(base64.decode(sealed.packet).slice(-4)).toEqual(Uint8Array.of(5, 0, 1, 0));
        const plaintext = await openClaimPacket(
            sealed.packet,
            SECRET_KEY,
            EXECUTOR_PREDICATE_RECEIVE_TEMPLATE_ID,
        );
        expect(plaintext.subarray(64, 96)).toEqual(sha256(Uint8Array.of(0)));
    });

    it("uses an explicitly compatible custom template without changing the predicate layout", async () => {
        const predicate = Uint8Array.of(0x51);
        const templateId = "custom-predicate-template";
        const sealed = await sealClaimPacket({ ...input(predicate), templateId });
        const plaintext = await openClaimPacket(sealed.packet, SECRET_KEY, templateId);
        expect(plaintext.subarray(64, 96)).toEqual(sha256(predicate));
        expect(hex.encode(plaintext.subarray(96))).toBe("d204");
        await expect(
            openClaimPacket(sealed.packet, SECRET_KEY, EXECUTOR_PREDICATE_RECEIVE_TEMPLATE_ID),
        ).rejects.toThrow();
    });
});
