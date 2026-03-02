import { describe, it, expect } from "vitest";
import { DefaultContractHandler } from "../../../src/contracts/handlers/default";
import { DefaultVtxo } from "../../../src";

const TEST_PUB_KEY_HEX =
    "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const TEST_SERVER_PUB_KEY_HEX =
    "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

describe("DefaultContractHandler descriptor support", () => {
    it("should normalize hex pubkey to descriptor on deserialize", () => {
        const params = DefaultContractHandler.deserializeParams({
            pubKey: TEST_PUB_KEY_HEX,
            serverPubKey: TEST_SERVER_PUB_KEY_HEX,
        });
        expect(params.pubKey).toBe(`tr(${TEST_PUB_KEY_HEX})`);
        expect(params.serverPubKey).toBe(`tr(${TEST_SERVER_PUB_KEY_HEX})`);
    });

    it("should keep descriptors unchanged on deserialize", () => {
        const params = DefaultContractHandler.deserializeParams({
            pubKey: `tr(${TEST_PUB_KEY_HEX})`,
            serverPubKey: `tr(${TEST_SERVER_PUB_KEY_HEX})`,
        });
        expect(params.pubKey).toBe(`tr(${TEST_PUB_KEY_HEX})`);
        expect(params.serverPubKey).toBe(`tr(${TEST_SERVER_PUB_KEY_HEX})`);
    });

    it("should store descriptors directly on serialize", () => {
        const serialized = DefaultContractHandler.serializeParams({
            pubKey: `tr(${TEST_PUB_KEY_HEX})`,
            serverPubKey: `tr(${TEST_SERVER_PUB_KEY_HEX})`,
            csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
        });
        expect(serialized.pubKey).toBe(`tr(${TEST_PUB_KEY_HEX})`);
        expect(serialized.serverPubKey).toBe(`tr(${TEST_SERVER_PUB_KEY_HEX})`);
    });

    it("should create script from descriptor params", () => {
        const serialized = DefaultContractHandler.serializeParams({
            pubKey: `tr(${TEST_PUB_KEY_HEX})`,
            serverPubKey: `tr(${TEST_SERVER_PUB_KEY_HEX})`,
            csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
        });
        const script = DefaultContractHandler.createScript(serialized);
        expect(script).toBeDefined();
        expect(script.pkScript).toBeDefined();
    });

    it("should create script from legacy hex params", () => {
        const script = DefaultContractHandler.createScript({
            pubKey: TEST_PUB_KEY_HEX,
            serverPubKey: TEST_SERVER_PUB_KEY_HEX,
        });
        expect(script).toBeDefined();
        expect(script.pkScript).toBeDefined();
    });

    it("should produce identical pkScript from descriptor and hex params", () => {
        const hexScript = DefaultContractHandler.createScript({
            pubKey: TEST_PUB_KEY_HEX,
            serverPubKey: TEST_SERVER_PUB_KEY_HEX,
        });
        const descScript = DefaultContractHandler.createScript({
            pubKey: `tr(${TEST_PUB_KEY_HEX})`,
            serverPubKey: `tr(${TEST_SERVER_PUB_KEY_HEX})`,
        });
        expect(hexScript.pkScript).toEqual(descScript.pkScript);
    });

    it("should round-trip serialize/deserialize with descriptors", () => {
        const original = {
            pubKey: `tr(${TEST_PUB_KEY_HEX})`,
            serverPubKey: `tr(${TEST_SERVER_PUB_KEY_HEX})`,
            csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
        };
        const serialized = DefaultContractHandler.serializeParams(original);
        const deserialized =
            DefaultContractHandler.deserializeParams(serialized);
        expect(deserialized.pubKey).toBe(original.pubKey);
        expect(deserialized.serverPubKey).toBe(original.serverPubKey);
    });

    it("should upgrade legacy hex to descriptor on deserialize", () => {
        const deserialized = DefaultContractHandler.deserializeParams({
            pubKey: TEST_PUB_KEY_HEX,
            serverPubKey: TEST_SERVER_PUB_KEY_HEX,
            csvTimelock: "65536",
        });
        expect(deserialized.pubKey).toBe(`tr(${TEST_PUB_KEY_HEX})`);
    });
});
