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
    isMainnetDescriptor,
    isWildcardTemplate,
    materializeAtIndex,
    templateOf,
    descriptorIsOurs,
} from "../src/identity/descriptor";
import { SeedIdentity } from "../src/identity/seedIdentity";

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
    it("should return false for unclosed descriptor", () => {
        expect(isDescriptor("tr(deadbeef")).toBe(false);
    });
    it("should return false for empty body", () => {
        expect(isDescriptor("tr()")).toBe(false);
    });
    it("should return false for non-tr descriptors", () => {
        expect(isDescriptor("wpkh(xyz)")).toBe(false);
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
    it("should throw on empty string", () => {
        expect(() => normalizeToDescriptor("")).toThrow(
            "expected a non-empty string"
        );
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

describe("isMainnetDescriptor", () => {
    it("returns false for tpub-prefixed descriptors", () => {
        // tpub is shared across testnet/signet/regtest/mutinynet — we
        // can only tell mainnet vs not, never which non-mainnet.
        expect(isMainnetDescriptor(makeDescriptor({ isMainnet: false }))).toBe(
            false
        );
    });

    it("returns true for xpub-prefixed descriptors", () => {
        expect(isMainnetDescriptor(makeDescriptor({}))).toBe(true);
    });
});

describe("isWildcardTemplate", () => {
    it("returns true for descriptors ending with /*)", () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const template = SeedIdentity.fromSeed(seed, {
            isMainnet: true,
        }).getAccountDescriptor();
        expect(isWildcardTemplate(template)).toBe(true);
    });

    it("returns false for concrete descriptors", () => {
        expect(isWildcardTemplate(makeDescriptor({}))).toBe(false);
    });

    it("returns false for descriptors with bare *", () => {
        // Defensive: only the exact "/*)" suffix counts.
        expect(isWildcardTemplate("tr(*)")).toBe(false);
    });
});

describe("materializeAtIndex", () => {
    const seed = mnemonicToSeedSync(TEST_MNEMONIC);
    const TEMPLATE = SeedIdentity.fromSeed(seed, {
        isMainnet: true,
    }).getAccountDescriptor();

    it("substitutes the wildcard with the given index", () => {
        const at0 = materializeAtIndex(TEMPLATE, 0);
        expect(at0.endsWith("/0)")).toBe(true);
        expect(isWildcardTemplate(at0)).toBe(false);

        const at7 = materializeAtIndex(TEMPLATE, 7);
        expect(at7.endsWith("/7)")).toBe(true);
    });

    it("rejects non-template descriptors", () => {
        // Library raises "index passed for non-ranged descriptor".
        expect(() => materializeAtIndex(makeDescriptor({}), 1)).toThrow(
            /non-ranged/
        );
    });

    it("rejects out-of-range indices", () => {
        expect(() => materializeAtIndex(TEMPLATE, -1)).toThrow(/\[0, 2\^31\)/);
        expect(() => materializeAtIndex(TEMPLATE, 0x80000000)).toThrow(
            /\[0, 2\^31\)/
        );
        expect(() => materializeAtIndex(TEMPLATE, 1.5)).toThrow(/\[0, 2\^31\)/);
    });
});

describe("templateOf", () => {
    it("returns templates as-is", () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const template = SeedIdentity.fromSeed(seed, {
            isMainnet: true,
        }).getAccountDescriptor();
        expect(templateOf(template)).toBe(template);
    });

    it("derives the template by chopping a trailing numeric index", () => {
        const concrete = makeDescriptor({ index: 42 });
        const expected = concrete.replace(/\/42\)$/, "/*)");
        expect(templateOf(concrete)).toBe(expected);
    });

    it("rejects descriptors without a numeric trailing index", () => {
        expect(() => templateOf("tr([fp/0']xpub.../0/abc)")).toThrow();
    });

    it("rejects descriptors with leading-zero indices", () => {
        // "01" parses as 1 but the round-trip through String(1) is "1",
        // so we reject ambiguous index encodings.
        expect(() => templateOf("tr([fp/0']xpub.../0/01)")).toThrow();
    });
});

describe("descriptorIsOurs", () => {
    const seed = mnemonicToSeedSync(TEST_MNEMONIC);
    const us = SeedIdentity.fromSeed(seed, { isMainnet: true });
    const otherSeed = mnemonicToSeedSync(
        "legal winner thank year wave sausage worth useful legal winner thank yellow"
    );
    const other = SeedIdentity.fromSeed(otherSeed, { isMainnet: true });

    it("matches descriptors at any index from the same xpub", () => {
        // SeedIdentity.isOurs delegates to descriptorIsOurs; using it as
        // the entry point keeps us from having to expose the private
        // accountXpub field just to test the helper.
        const template = us.getAccountDescriptor();
        for (const index of [0, 1, 7, 1024]) {
            expect(us.isOurs(materializeAtIndex(template, index))).toBe(true);
        }
        expect(us.isOurs(template)).toBe(true);
    });

    it("rejects descriptors derived from a different seed", () => {
        expect(us.isOurs(other.descriptor)).toBe(false);
        expect(us.isOurs(other.getAccountDescriptor())).toBe(false);
    });

    it("matches a bare tr(pubkey) descriptor against a fallback x-only pubkey", () => {
        const pubkey = hex.decode(getXOnlyPubKey());
        expect(
            descriptorIsOurs(`tr(${getXOnlyPubKey()})`, undefined, pubkey)
        ).toBe(true);
    });

    it("returns false for non-descriptor strings", () => {
        const pubkey = hex.decode(getXOnlyPubKey());
        expect(descriptorIsOurs("not a descriptor", undefined, pubkey)).toBe(
            false
        );
    });
});
