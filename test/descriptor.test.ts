import { describe, it, expect } from "vitest";
import { mnemonicToSeedSync } from "@scure/bip39";
import {
    HDKey,
    networks,
    scriptExpressions,
} from "@bitcoinerlab/descriptors-scure";
import { hex } from "@scure/base";
import {
    isDescriptor,
    normalizeToDescriptor,
    extractPubKey,
    parseHDDescriptor,
} from "../src/identity/descriptor";

const TEST_MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** Generate a real HD descriptor from the test mnemonic. */
function makeDescriptor(opts: {
    isMainnet?: boolean;
    change?: number;
    index?: number;
}): string {
    const { isMainnet = true, change = 0, index = 0 } = opts;
    const network = isMainnet ? networks.bitcoin : networks.testnet;
    const seed = mnemonicToSeedSync(TEST_MNEMONIC);
    const masterNode = HDKey.fromMasterSeed(seed, network.bip32);
    return scriptExpressions.trBIP32({
        masterNode,
        network,
        account: 0,
        change,
        index,
    });
}

/** Get x-only pubkey hex for a derived key. */
function getXOnlyPubKey(isMainnet = true): string {
    const network = isMainnet ? networks.bitcoin : networks.testnet;
    const seed = mnemonicToSeedSync(TEST_MNEMONIC);
    const root = HDKey.fromMasterSeed(seed, network.bip32);
    const account = root.derive(isMainnet ? "m/86'/0'/0'" : "m/86'/1'/0'");
    const child = account.deriveChild(0).deriveChild(0);
    return hex.encode(child.publicKey!.slice(1));
}

describe("isDescriptor", () => {
    it("should return true for simple descriptor", () => {
        const pubkey = getXOnlyPubKey();
        expect(isDescriptor(`tr(${pubkey})`)).toBe(true);
    });
    it("should return true for HD descriptor", () => {
        const desc = makeDescriptor({ index: 5 });
        expect(isDescriptor(desc)).toBe(true);
    });
    it("should return false for hex pubkey", () => {
        expect(isDescriptor(getXOnlyPubKey())).toBe(false);
    });
    it("should return false for empty string", () => {
        expect(isDescriptor("")).toBe(false);
    });
});

describe("normalizeToDescriptor", () => {
    it("should return descriptor unchanged", () => {
        const pubkey = getXOnlyPubKey();
        const desc = `tr(${pubkey})`;
        expect(normalizeToDescriptor(desc)).toBe(desc);
    });
    it("should wrap hex pubkey as tr(pubkey)", () => {
        const pubkey = getXOnlyPubKey();
        expect(normalizeToDescriptor(pubkey)).toBe(`tr(${pubkey})`);
    });
    it("should not double-wrap descriptors", () => {
        const desc = makeDescriptor({ index: 0 });
        expect(normalizeToDescriptor(desc)).toBe(desc);
    });
});

describe("extractPubKey", () => {
    it("should extract pubkey from simple descriptor", () => {
        const pubkey = getXOnlyPubKey();
        expect(extractPubKey(`tr(${pubkey})`)).toBe(pubkey);
    });
    it("should return hex pubkey unchanged", () => {
        const pubkey = getXOnlyPubKey();
        expect(extractPubKey(pubkey)).toBe(pubkey);
    });
    it("should throw for HD descriptor", () => {
        const desc = makeDescriptor({ index: 5 });
        expect(() => extractPubKey(desc)).toThrow(
            "Cannot extract pubkey from HD descriptor"
        );
    });
    it("should handle uppercase hex", () => {
        const pubkey = getXOnlyPubKey().toUpperCase();
        expect(extractPubKey(`tr(${pubkey})`)).toBe(pubkey.toLowerCase());
    });
    it("should throw for invalid descriptor content", () => {
        expect(() => extractPubKey("tr(abc123)")).toThrow();
    });
});

describe("parseHDDescriptor", () => {
    it("should parse valid HD descriptor with mainnet path", () => {
        const desc = makeDescriptor({ index: 5 });
        const result = parseHDDescriptor(desc);
        expect(result).not.toBeNull();
        expect(result!.fingerprint).toBe("73c5da0a");
        expect(result!.basePath).toBe("86'/0'/0'");
        expect(result!.derivationPath).toBe("0/5");
        expect(result!.xpub).toMatch(/^xpub/);
    });
    it("should parse valid HD descriptor with testnet path", () => {
        const desc = makeDescriptor({ isMainnet: false, index: 10 });
        const result = parseHDDescriptor(desc);
        expect(result).not.toBeNull();
        expect(result!.fingerprint).toBe("73c5da0a");
        expect(result!.basePath).toBe("86'/1'/0'");
        expect(result!.derivationPath).toBe("0/10");
        expect(result!.xpub).toMatch(/^tpub/);
    });
    it("should return null for simple descriptor", () => {
        const pubkey = getXOnlyPubKey();
        expect(parseHDDescriptor(`tr(${pubkey})`)).toBeNull();
    });
    it("should return null for invalid format", () => {
        expect(parseHDDescriptor("invalid")).toBeNull();
    });
    it("should return null for raw hex", () => {
        expect(parseHDDescriptor(getXOnlyPubKey())).toBeNull();
    });
    it("should extract correct xpub from mainnet descriptor", () => {
        const desc = makeDescriptor({ index: 0 });
        const result = parseHDDescriptor(desc);
        expect(result).not.toBeNull();
        expect(result!.xpub).toBe(
            "xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ"
        );
    });
});
