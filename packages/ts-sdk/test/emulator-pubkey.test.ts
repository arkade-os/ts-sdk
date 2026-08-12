import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";

import {
    defaultEmulatorPubkey,
    resolveEmulatorPubkey,
    networks,
    BITCOIN_EMULATOR_PUBKEY,
    MUTINYNET_EMULATOR_PUBKEY,
    REGTEST_EMULATOR_PUBKEY,
    type Network,
} from "../src/networks";

describe("defaultEmulatorPubkey", () => {
    it("returns the pinned key for each network that has a deployed emulator", () => {
        expect(defaultEmulatorPubkey(networks.bitcoin)).toBe(BITCOIN_EMULATOR_PUBKEY);
        expect(defaultEmulatorPubkey(networks.mutinynet)).toBe(MUTINYNET_EMULATOR_PUBKEY);
        expect(defaultEmulatorPubkey(networks.regtest)).toBe(REGTEST_EMULATOR_PUBKEY);
    });

    it("pins the exact values the deployed emulators advertise", () => {
        // Spelled out rather than compared against the constants they came
        // from: this is the assertion that fails if someone edits the constant,
        // which is the whole point of pinning a co-signer key.
        expect(BITCOIN_EMULATOR_PUBKEY).toBe(
            "0239c196415da47b26456a101daaa12ba9e445bfe153197f1e2b750bf40e52092e",
        );
        expect(MUTINYNET_EMULATOR_PUBKEY).toBe(
            "03f823b9b2febc81f4af967e77aed2f541cbd3397c6d8f5a72e32eb7b471af889a",
        );
        expect(REGTEST_EMULATOR_PUBKEY).toBe(
            "02999413c46fa10ada5cbc4bcc79a1d09160c2ba3cfc812705d7a13e5e545fb2a9",
        );
    });

    it("pins them as 33-byte compressed points, not x-only", () => {
        // Compressed is the lossless form and what `/v1/info` puts on the
        // wire: `Arkade.connect` keeps all 33 bytes of the co-signer's
        // signerPubkey (unlike the server key, which it slices), so these
        // substitute for a live fetch byte-for-byte. The parity bit cannot be
        // recovered once dropped, so pinning x-only would not be reversible.
        for (const key of [
            BITCOIN_EMULATOR_PUBKEY,
            MUTINYNET_EMULATOR_PUBKEY,
            REGTEST_EMULATOR_PUBKEY,
        ]) {
            expect(key).toMatch(/^0[23][0-9a-f]{64}$/);
            expect(hex.decode(key)).toHaveLength(33);
        }
    });

    it("gives each pinned network a distinct key", () => {
        const keys = [BITCOIN_EMULATOR_PUBKEY, MUTINYNET_EMULATOR_PUBKEY, REGTEST_EMULATOR_PUBKEY];
        expect(new Set(keys).size).toBe(keys.length);
    });

    it("throws for a network with no deployed emulator rather than guessing a neighbour's", () => {
        // testnet/signet share every other field with mutinynet, so falling
        // back by shape would hand back mutinynet's co-signer.
        expect(() => defaultEmulatorPubkey(networks.testnet)).toThrow(/no emulator pubkey/i);
        expect(() => defaultEmulatorPubkey(networks.signet)).toThrow(/no emulator pubkey/i);
    });

    it("throws for a hand-assembled Network carrying no name", () => {
        const unnamed: Network = { ...networks.bitcoin, name: undefined };
        expect(() => defaultEmulatorPubkey(unnamed)).toThrow(/<unnamed>/);
    });

    it("names the pinned networks in the failure so the message is actionable", () => {
        expect(() => defaultEmulatorPubkey(networks.testnet)).toThrow(
            /bitcoin, mutinynet, regtest/,
        );
    });
});

describe("resolveEmulatorPubkey", () => {
    it("falls through to the pinned key when no override is given", () => {
        expect(resolveEmulatorPubkey(networks.regtest)).toBe(REGTEST_EMULATOR_PUBKEY);
        expect(resolveEmulatorPubkey(networks.regtest, undefined)).toBe(REGTEST_EMULATOR_PUBKEY);
    });

    it("returns the override in place of the pinned key", () => {
        const custom = "02" + "ab".repeat(32);
        expect(resolveEmulatorPubkey(networks.regtest, custom)).toBe(custom);
        expect(resolveEmulatorPubkey(networks.regtest, custom)).not.toBe(REGTEST_EMULATOR_PUBKEY);
    });

    it("lets an override supply a key for a network that has none pinned", () => {
        const custom = "03" + "cd".repeat(32);
        expect(() => defaultEmulatorPubkey(networks.signet)).toThrow();
        expect(resolveEmulatorPubkey(networks.signet, custom)).toBe(custom);
    });

    it("rejects a malformed override instead of passing it through", () => {
        // A typo that reaches a covenant leaf surfaces as an unspendable
        // contract, so it has to fail at the seam instead.
        expect(() => resolveEmulatorPubkey(networks.regtest, "not-hex")).toThrow(/compressed/);
        // x-only: the encoding a caller is most likely to reach for by mistake.
        expect(() => resolveEmulatorPubkey(networks.regtest, "ab".repeat(32))).toThrow(
            /compressed/,
        );
        // Uncompressed (04-prefixed) and wrong-length are both out.
        expect(() => resolveEmulatorPubkey(networks.regtest, "04" + "ab".repeat(64))).toThrow(
            /compressed/,
        );
        expect(() => resolveEmulatorPubkey(networks.regtest, "02" + "ab".repeat(31))).toThrow(
            /compressed/,
        );
        // Uppercase hex is not the lowercase form everything else here uses.
        expect(() =>
            resolveEmulatorPubkey(networks.regtest, ("02" + "ab".repeat(32)).toUpperCase()),
        ).toThrow(/compressed/);
    });

    it("rejects an empty-string override rather than treating it as absent", () => {
        expect(() => resolveEmulatorPubkey(networks.regtest, "")).toThrow(/compressed/);
    });
});
