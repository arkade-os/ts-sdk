import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { NETWORK } from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";
import { arkade } from "../src";

const priv = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const key = (fill: number): Uint8Array => schnorr.getPublicKey(priv(fill));
const PREIMAGE = new Uint8Array(32).fill(7);
const H160 = ripemd160(sha256(PREIMAGE));
const LOCKTIME = 1_800_000_000n;

describe("onchain HTLC Program", () => {
    it("compiles without an Arkade server key to the pinned L1 address", () => {
        const script = arkade.compileOnchainHtlc({
            preimageHash: H160,
            claimKey: key(1),
            refundKey: key(3),
            refundLocktime: LOCKTIME,
        });
        expect(script.keys.serverKey).toBeUndefined();
        expect(script.compiled.map((f) => f.name)).toEqual(["claim", "refund"]);
        expect(script.onchainAddress(NETWORK)).toBe(
            "bc1pha7jrk3203ypttdk866vhdjlznzpd92esp0vdlfgw2plmjsxpwwq7wecyt",
        );
        expect(hex.encode(script.pkScript)).toBe(
            "5120bf7d21da2a7c4815adb63eb4cbb65f14c4169559805ec6fd287283fdca060b9c",
        );
    });

    it("round-trips the artifact without moving the address", () => {
        const args = {
            preimageHash: H160,
            claimKey: key(1),
            refundKey: key(3),
            refundLocktime: LOCKTIME,
        };
        const rt = arkade.parseArtifact(
            JSON.parse(arkade.stringifyArtifact(arkade.ONCHAIN_HTLC_PROGRAM)),
        );
        const a = new arkade.ArkadeProgramScript(arkade.ONCHAIN_HTLC_PROGRAM, args, {});
        const b = new arkade.ArkadeProgramScript(rt, args, {});
        expect(hex.encode(b.pkScript)).toBe(hex.encode(a.pkScript));
    });
});
