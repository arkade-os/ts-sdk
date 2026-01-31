import { describe, it, expect } from "vitest";
import {
    isDescriptor,
    normalizeToDescriptor,
    extractPubKey,
    parseHDDescriptor,
} from "../src/identity/descriptor";

describe("isDescriptor", () => {
    it("should return true for simple descriptor", () => {
        expect(isDescriptor("tr(abc123def456)")).toBe(true);
    });

    it("should return true for HD descriptor", () => {
        expect(
            isDescriptor("tr([12345678/86'/0'/0']xpubABCDEF123456/0/5)")
        ).toBe(true);
    });

    it("should return false for hex pubkey", () => {
        expect(isDescriptor("abc123def456")).toBe(false);
    });

    it("should return false for empty string", () => {
        expect(isDescriptor("")).toBe(false);
    });
});

describe("normalizeToDescriptor", () => {
    it("should return descriptor unchanged", () => {
        const desc = "tr(abc123)";
        expect(normalizeToDescriptor(desc)).toBe(desc);
    });

    it("should wrap hex pubkey as tr(pubkey)", () => {
        expect(normalizeToDescriptor("abc123")).toBe("tr(abc123)");
    });

    it("should wrap 64-char hex pubkey", () => {
        const pubkey = "a".repeat(64);
        expect(normalizeToDescriptor(pubkey)).toBe(`tr(${pubkey})`);
    });

    it("should not double-wrap descriptors", () => {
        const desc = "tr(abc123)";
        expect(normalizeToDescriptor(desc)).toBe(desc);
    });
});

describe("extractPubKey", () => {
    it("should extract pubkey from simple descriptor", () => {
        const pubkey = "a".repeat(64);
        expect(extractPubKey(`tr(${pubkey})`)).toBe(pubkey);
    });

    it("should return hex pubkey unchanged", () => {
        const pubkey = "a".repeat(64);
        expect(extractPubKey(pubkey)).toBe(pubkey);
    });

    it("should throw for HD descriptor", () => {
        expect(() =>
            extractPubKey("tr([12345678/86'/0'/0']xpubABCDEF/0/5)")
        ).toThrow("Cannot extract pubkey from HD descriptor");
    });

    it("should handle uppercase hex", () => {
        const pubkey = "A".repeat(64);
        expect(extractPubKey(`tr(${pubkey})`)).toBe(pubkey);
    });

    it("should throw for short pubkey in descriptor", () => {
        expect(() => extractPubKey("tr(abc123)")).toThrow(
            "Cannot extract pubkey from HD descriptor"
        );
    });
});

describe("parseHDDescriptor", () => {
    it("should parse valid HD descriptor with mainnet path", () => {
        const desc = "tr([12345678/86'/0'/0']xpubDCtest123/0/5)";
        const result = parseHDDescriptor(desc);

        expect(result).not.toBeNull();
        expect(result!.fingerprint).toBe("12345678");
        expect(result!.basePath).toBe("86'/0'/0'");
        expect(result!.xpub).toBe("xpubDCtest123");
        expect(result!.derivationPath).toBe("0/5");
    });

    it("should parse valid HD descriptor with testnet path", () => {
        const desc = "tr([abcdef12/86'/1'/0']tpubDCtest456/0/10)";
        const result = parseHDDescriptor(desc);

        expect(result).not.toBeNull();
        expect(result!.fingerprint).toBe("abcdef12");
        expect(result!.basePath).toBe("86'/1'/0'");
        expect(result!.xpub).toBe("tpubDCtest456");
        expect(result!.derivationPath).toBe("0/10");
    });

    it("should return null for simple descriptor", () => {
        const pubkey = "a".repeat(64);
        expect(parseHDDescriptor(`tr(${pubkey})`)).toBeNull();
    });

    it("should return null for invalid format", () => {
        expect(parseHDDescriptor("invalid")).toBeNull();
    });

    it("should return null for raw hex", () => {
        expect(parseHDDescriptor("a".repeat(64))).toBeNull();
    });

    it("should handle real-world xpub format", () => {
        const desc =
            "tr([73c5da0a/86'/0'/0']xpub6CUGRUonZSQ4TWtTMmzXdrXDtyPWm/0/0)";
        const result = parseHDDescriptor(desc);

        expect(result).not.toBeNull();
        expect(result!.fingerprint).toBe("73c5da0a");
        expect(result!.xpub).toBe("xpub6CUGRUonZSQ4TWtTMmzXdrXDtyPWm");
    });
});
