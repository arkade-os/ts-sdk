import { describe, expect, it } from "vitest";
import {
    sign,
    aggregateKeys,
    generateNonces,
    aggregateNonces,
    partialSigVerify,
    PartialSig,
} from "../src/musig2";
import testData from "./fixtures/musig2.json";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";

describe("musig2", () => {
    describe("aggregateKeys", () => {
        it("should correctly aggregate public keys", () => {
            const { pubkeys, expectedAggregatedKey, tweak, expectedFinalKey } =
                testData.keyAggregation;
            const publicKeys = pubkeys.map((key) => hex.decode(key));
            const { preTweakedKey, finalKey } = aggregateKeys(publicKeys, true, {
                taprootTweak: hex.decode(tweak),
            });
            expect(hex.encode(preTweakedKey.slice(1))).toBe(expectedAggregatedKey);
            expect(hex.encode(finalKey.slice(1))).toBe(expectedFinalKey);
            // fixture keys are unsorted: sorting must copy, not reorder the input
            expect(publicKeys.map((key) => hex.encode(key))).toEqual(pubkeys);
        });
    });

    describe("sign", () => {
        it("should correctly generate signature", () => {
            const { inputs, result } = testData.signing;
            const { secNonce, secretKey, publicKeys, message, options, aggNonce } = inputs;

            const signature = sign(
                hex.decode(secNonce),
                hex.decode(secretKey),
                hex.decode(aggNonce),
                publicKeys.map((key) => hex.decode(key)),
                hex.decode(message),
                {
                    sortKeys: true,
                    taprootTweak: hex.decode(options.taprootTweak),
                },
            );

            expect(hex.encode(signature.encode())).toBe(result);
        });
    });

    describe("partialSigVerify", () => {
        const taprootTweak = hex.decode(testData.signing.inputs.options.taprootTweak);
        const message = hex.decode(testData.signing.inputs.message);
        const options = { sortKeys: true, taprootTweak };

        // Two-of-two session, both signers' shares produced against the same
        // aggregated nonce — the shape tree signing uses. `order` fixes the
        // caller's key order relative to the sorted order the session uses, so
        // the nonce permutation is exercised deterministically.
        function session(order: "sorted" | "reversed" = "reversed", opts = options) {
            const signers = [1, 2]
                .map(() => {
                    const secretKey = secp256k1.utils.randomSecretKey();
                    const publicKey = secp256k1.getPublicKey(secretKey, true);
                    return { secretKey, publicKey, ...generateNonces(publicKey) };
                })
                .sort((a, b) => {
                    const cmp = hex.encode(a.publicKey) < hex.encode(b.publicKey) ? -1 : 1;
                    return order === "sorted" ? cmp : -cmp;
                });
            const combinedNonce = aggregateNonces(signers.map((s) => s.pubNonce));
            const publicKeys = signers.map((s) => s.publicKey);
            const pubNonces = signers.map((s) => s.pubNonce);
            const shares = signers.map((s) =>
                sign(s.secNonce, s.secretKey, combinedNonce, publicKeys, message, opts),
            );
            return { signers, combinedNonce, publicKeys, pubNonces, shares };
        }

        const verify = (
            s: ReturnType<typeof session>,
            share: PartialSig,
            index: number,
            pubNonces = s.pubNonces,
        ) =>
            partialSigVerify(
                share,
                s.signers[index].publicKey,
                pubNonces,
                s.combinedNonce,
                s.publicKeys,
                message,
                options,
            );

        it.each(["sorted", "reversed"] as const)("accepts every valid share (%s keys)", (order) => {
            const s = session(order);

            expect(verify(s, s.shares[0], 0)).toBe(true);
            expect(verify(s, s.shares[1], 1)).toBe(true);
        });

        it("rejects a tampered share", () => {
            const s = session();
            const tampered = s.shares[0].encode();
            tampered[31] ^= 0x01;

            expect(verify(s, PartialSig.decode(tampered), 0)).toBe(false);
        });

        it("rejects a share checked against the wrong nonce", () => {
            const s = session();
            const foreignNonce = generateNonces(s.signers[0].publicKey).pubNonce;

            expect(verify(s, s.shares[0], 0, [foreignNonce, s.pubNonces[1]])).toBe(false);
        });

        it("rejects a share attributed to the other signer", () => {
            const s = session();

            expect(verify(s, s.shares[0], 1)).toBe(false);
        });

        it("throws when the signer is not part of the session", () => {
            const s = session();
            const outsider = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true);

            expect(() =>
                partialSigVerify(
                    s.shares[0],
                    outsider,
                    s.pubNonces,
                    s.combinedNonce,
                    s.publicKeys,
                    message,
                    options,
                ),
            ).toThrow(/not part of the session/);
        });

        it.each([true, false])(
            "sign and verify leave the caller's arrays untouched (sortKeys: %s)",
            (sortKeys) => {
                const opts = { sortKeys, taprootTweak };
                const s = session("reversed", opts);
                const keys = s.publicKeys.map((k) => hex.encode(k));
                const nonces = s.pubNonces.map((n) => hex.encode(n));

                // session() already ran sign() twice over this array; the
                // reversed construction order must have survived it.
                expect(keys).toEqual([...keys].sort().reverse());

                expect(
                    partialSigVerify(
                        s.shares[0],
                        s.signers[0].publicKey,
                        s.pubNonces,
                        s.combinedNonce,
                        s.publicKeys,
                        message,
                        opts,
                    ),
                ).toBe(true);

                expect(s.publicKeys.map((k) => hex.encode(k))).toEqual(keys);
                expect(s.pubNonces.map((n) => hex.encode(n))).toEqual(nonces);
            },
        );

        it("throws on a nonce/key count mismatch", () => {
            const s = session();

            expect(() =>
                partialSigVerify(
                    s.shares[0],
                    s.signers[0].publicKey,
                    [s.pubNonces[0]],
                    s.combinedNonce,
                    s.publicKeys,
                    message,
                    options,
                ),
            ).toThrow(/same length/);
        });
    });
});
