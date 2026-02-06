import { describe, it, expect } from "vitest";
import { DefaultContractHandler } from "../../../src/contracts/handlers/default";

describe("DefaultContractHandler descriptor support", () => {
    // Valid 32-byte x-only public keys (on the secp256k1 curve)
    // These are actual valid public keys that will work with taproot scripts
    const testPubKey =
        "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const testServerPubKey =
        "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

    describe("deserializeParams", () => {
        it("should normalize hex pubkey to descriptor", () => {
            const params = {
                pubKey: testPubKey,
                serverPubKey: testServerPubKey,
                csvTimelock: "144",
            };

            const result = DefaultContractHandler.deserializeParams(params);

            expect(result.pubKey).toBe(`tr(${testPubKey})`);
            expect(result.serverPubKey).toBe(`tr(${testServerPubKey})`);
        });

        it("should keep descriptor format unchanged", () => {
            const params = {
                pubKey: `tr(${testPubKey})`,
                serverPubKey: `tr(${testServerPubKey})`,
                csvTimelock: "144",
            };

            const result = DefaultContractHandler.deserializeParams(params);

            expect(result.pubKey).toBe(`tr(${testPubKey})`);
            expect(result.serverPubKey).toBe(`tr(${testServerPubKey})`);
        });

        it("should handle missing csvTimelock with default", () => {
            const params = {
                pubKey: testPubKey,
                serverPubKey: testServerPubKey,
            };

            const result = DefaultContractHandler.deserializeParams(
                params as Record<string, string>
            );

            expect(result.csvTimelock).toBeDefined();
        });
    });

    describe("serializeParams", () => {
        it("should store descriptors directly", () => {
            const params = {
                pubKey: `tr(${testPubKey})`,
                serverPubKey: `tr(${testServerPubKey})`,
                csvTimelock: { value: 144n, type: "blocks" as const },
            };

            const result = DefaultContractHandler.serializeParams(params);

            expect(result.pubKey).toBe(`tr(${testPubKey})`);
            expect(result.serverPubKey).toBe(`tr(${testServerPubKey})`);
        });
    });

    describe("createScript", () => {
        it("should create script from descriptor params", () => {
            const params = {
                pubKey: `tr(${testPubKey})`,
                serverPubKey: `tr(${testServerPubKey})`,
                csvTimelock: "144",
            };

            const script = DefaultContractHandler.createScript(params);

            expect(script).toBeDefined();
            expect(script.pkScript).toBeDefined();
        });

        it("should create script from legacy hex params", () => {
            const params = {
                pubKey: testPubKey,
                serverPubKey: testServerPubKey,
                csvTimelock: "144",
            };

            const script = DefaultContractHandler.createScript(params);

            expect(script).toBeDefined();
            expect(script.pkScript).toBeDefined();
        });

        it("should create identical scripts from descriptor and legacy params", () => {
            const descriptorParams = {
                pubKey: `tr(${testPubKey})`,
                serverPubKey: `tr(${testServerPubKey})`,
                csvTimelock: "144",
            };

            const legacyParams = {
                pubKey: testPubKey,
                serverPubKey: testServerPubKey,
                csvTimelock: "144",
            };

            const scriptFromDescriptor =
                DefaultContractHandler.createScript(descriptorParams);
            const scriptFromLegacy =
                DefaultContractHandler.createScript(legacyParams);

            // Both should produce the same script
            expect(scriptFromDescriptor.pkScript).toEqual(
                scriptFromLegacy.pkScript
            );
        });
    });

    describe("backwards compatibility", () => {
        it("should round-trip serialize/deserialize with descriptors", () => {
            const original = {
                pubKey: `tr(${testPubKey})`,
                serverPubKey: `tr(${testServerPubKey})`,
                csvTimelock: { value: 144n, type: "blocks" as const },
            };

            const serialized = DefaultContractHandler.serializeParams(original);
            const deserialized =
                DefaultContractHandler.deserializeParams(serialized);

            expect(deserialized.pubKey).toBe(original.pubKey);
            expect(deserialized.serverPubKey).toBe(original.serverPubKey);
        });

        it("should upgrade legacy hex to descriptor on deserialize", () => {
            // Simulate old data stored as hex
            const legacyParams = {
                pubKey: testPubKey,
                serverPubKey: testServerPubKey,
                csvTimelock: "144",
            };

            const deserialized =
                DefaultContractHandler.deserializeParams(legacyParams);

            // Should now be descriptors
            expect(deserialized.pubKey).toBe(`tr(${testPubKey})`);
            expect(deserialized.serverPubKey).toBe(`tr(${testServerPubKey})`);
        });
    });
});
