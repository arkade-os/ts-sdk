import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { DefaultContractHandler } from "../../../src/contracts/handlers/default";
import { DefaultVtxo } from "../../../src";

const TEST_PUB_KEY_HEX =
    "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const TEST_SERVER_PUB_KEY_HEX =
    "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const TEST_PUB_KEY = hex.decode(TEST_PUB_KEY_HEX);
const TEST_SERVER_PUB_KEY = hex.decode(TEST_SERVER_PUB_KEY_HEX);

describe("DefaultContractHandler descriptor support", () => {
    it("should deserialize hex pubkey to bytes", () => {
        const params = DefaultContractHandler.deserializeParams({
            pubKey: TEST_PUB_KEY_HEX,
            serverPubKey: TEST_SERVER_PUB_KEY_HEX,
        });
        expect(params.pubKey).toEqual(TEST_PUB_KEY);
        expect(params.serverPubKey).toEqual(TEST_SERVER_PUB_KEY);
    });

    it("should deserialize descriptor pubkey to bytes", () => {
        const params = DefaultContractHandler.deserializeParams({
            pubKey: `tr(${TEST_PUB_KEY_HEX})`,
            serverPubKey: `tr(${TEST_SERVER_PUB_KEY_HEX})`,
        });
        expect(params.pubKey).toEqual(TEST_PUB_KEY);
        expect(params.serverPubKey).toEqual(TEST_SERVER_PUB_KEY);
    });

    it("should serialize bytes to hex", () => {
        const serialized = DefaultContractHandler.serializeParams({
            pubKey: TEST_PUB_KEY,
            serverPubKey: TEST_SERVER_PUB_KEY,
            csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
        });
        expect(serialized.pubKey).toBe(TEST_PUB_KEY_HEX);
        expect(serialized.serverPubKey).toBe(TEST_SERVER_PUB_KEY_HEX);
    });

    it("should create script from descriptor params", () => {
        const serialized = DefaultContractHandler.serializeParams({
            pubKey: TEST_PUB_KEY,
            serverPubKey: TEST_SERVER_PUB_KEY,
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

    it("should round-trip serialize/deserialize", () => {
        const original = {
            pubKey: TEST_PUB_KEY,
            serverPubKey: TEST_SERVER_PUB_KEY,
            csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
        };
        const serialized = DefaultContractHandler.serializeParams(original);
        const deserialized =
            DefaultContractHandler.deserializeParams(serialized);
        expect(deserialized.pubKey).toEqual(original.pubKey);
        expect(deserialized.serverPubKey).toEqual(original.serverPubKey);
    });
});
