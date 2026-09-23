import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { buildDelegateeArkadeScript } from "../src/script/delegatee";

const delegatePubKey = hex.decode(
    "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
);

// These byte strings are pinned by delegatee/internal/core/application/covenant_test.go.
const goldenPrefix =
    "db02000494dc690474797065f86908726567697374657288166f6e636861696e5f6f75747075745f696e6465786573f869025b5d8817636f7369676e6572735f7075626c69635f6b6579732e30f869423032373962653636376566396463626261633535613036323935636538373062303730323962666364623264636532386439353966323831356231366638313739388817636f7369676e6572735f7075626c69635f6b6579732e31f8916975";

describe("delegatee covenant script", () => {
    it("matches the delegatee zero-fee golden byte-for-byte", () => {
        const script = buildDelegateeArkadeScript({
            delegatePubKey,
            renewalWindow: 1024,
            maxFee: 0,
        });
        expect(hex.encode(script)).toBe(`${goldenPrefix}cd8c5700f7`);
    });

    it("matches the delegatee max-fee golden byte-for-byte", () => {
        const script = buildDelegateeArkadeScript({
            delegatePubKey,
            renewalWindow: 1024,
            maxFee: 150,
        });
        expect(hex.encode(script)).toBe(`${goldenPrefix}cd8ccf02960093cdc9a269cd8c5500f7`);
    });
});
