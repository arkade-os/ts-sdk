import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { mnemonicToSeedSync } from "@scure/bip39";
import {
    HDKey,
    networks,
    scriptExpressions,
} from "@bitcoinerlab/descriptors-scure";
import { deriveDescriptorLeafPubKey } from "../src/identity/descriptor";
import { HDDescriptorProvider } from "../src/wallet/hdDescriptorProvider";
import { makeHdProviderForTest } from "./helpers/hdProvider";

const TEST_MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** Build a materialized (concrete-index) tr([fp/86'/0'/0']xpub/.../0/<i>) descriptor. */
function makeHDDescriptor(index: number, isMainnet = true): string {
    const network = isMainnet ? networks.bitcoin : networks.testnet;
    const seed = mnemonicToSeedSync(TEST_MNEMONIC);
    const masterNode = HDKey.fromMasterSeed(seed, network.bip32);
    return scriptExpressions.trBIP32({
        masterNode,
        network,
        account: 0,
        change: 0,
        index,
    });
}

describe("deriveDescriptorLeafPubKey", () => {
    it("extracts the x-only pubkey from a static tr(pubkey) descriptor", () => {
        const pk = hex.encode(new Uint8Array(32).fill(2));
        const out = deriveDescriptorLeafPubKey(`tr(${pk})`);
        expect(hex.encode(out)).toBe(pk);
    });

    it("throws for a non-rangeable / unparseable descriptor", () => {
        expect(() => deriveDescriptorLeafPubKey("tr(not-a-key)")).toThrow();
    });

    it("returns a 32-byte pubkey for a materialized HD descriptor at a non-zero index", () => {
        const desc = makeHDDescriptor(3);
        const pubkey = deriveDescriptorLeafPubKey(desc);
        expect(pubkey).toBeInstanceOf(Uint8Array);
        expect(pubkey.length).toBe(32);
    });

    it("returns different pubkeys for different HD indices", () => {
        const pubkey1 = deriveDescriptorLeafPubKey(makeHDDescriptor(1));
        const pubkey2 = deriveDescriptorLeafPubKey(makeHDDescriptor(2));
        expect(hex.encode(pubkey1)).not.toBe(hex.encode(pubkey2));
    });
});

describe("HDDescriptorProvider scan support", () => {
    it("materializeDescriptorAt is pure (no watermark mutation)", async () => {
        const p = await makeHdProviderForTest();
        const d0 = await p.materializeDescriptorAt(0);
        const d5 = await p.materializeDescriptorAt(5);
        expect(d0).not.toEqual(d5);
        expect(await p.getCurrentSigningDescriptor()).toBeUndefined();
    });

    it("advanceLastIndexUsed is monotonic (never rewinds)", async () => {
        const p = await makeHdProviderForTest();
        await p.advanceLastIndexUsed(10);
        expect(await p.getCurrentSigningDescriptor()).toBe(
            await p.materializeDescriptorAt(10)
        );
        await p.advanceLastIndexUsed(7);
        expect(await p.getCurrentSigningDescriptor()).toBe(
            await p.materializeDescriptorAt(10)
        );
    });
});

import { isDiscoverable } from "../src/contracts/types";

describe("isDiscoverable", () => {
    it("true only when discoverAt is a function", () => {
        expect(isDiscoverable({ type: "x" } as any)).toBe(false);
        expect(
            isDiscoverable({ type: "x", discoverAt: async () => [] } as any)
        ).toBe(true);
    });
});
