import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { DelegateContractHandler } from "../../../src/contracts/handlers/delegate";
import { DefaultVtxo } from "../../../src";

const TEST_PUB_KEY_HEX = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const TEST_SERVER_PUB_KEY_HEX = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const TEST_DELEGATE_PUB_KEY_HEX =
    "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
const TEST_PUB_KEY = hex.decode(TEST_PUB_KEY_HEX);
const TEST_SERVER_PUB_KEY = hex.decode(TEST_SERVER_PUB_KEY_HEX);
const TEST_DELEGATE_PUB_KEY = hex.decode(TEST_DELEGATE_PUB_KEY_HEX);

// The delegate handler deserializes through the same shared helpers as
// `default` (`extractPubKeyBytes` / `deserializeCsvTimelock`). These cases pin
// that parity: before the helpers were shared, delegate decoded keys with a
// raw `hex.decode` and fed `Number(params.csvTimelock)` straight into
// `sequenceToTimelock`, so a descriptor-form key threw and an absent timelock
// silently decoded to zero blocks.
describe("DelegateContractHandler param deserialization", () => {
    it("deserializes hex pubkeys to bytes", () => {
        const params = DelegateContractHandler.deserializeParams({
            pubKey: TEST_PUB_KEY_HEX,
            serverPubKey: TEST_SERVER_PUB_KEY_HEX,
            delegatePubKey: TEST_DELEGATE_PUB_KEY_HEX,
            csvTimelock: "144",
        });
        expect(params.pubKey).toEqual(TEST_PUB_KEY);
        expect(params.serverPubKey).toEqual(TEST_SERVER_PUB_KEY);
        expect(params.delegatePubKey).toEqual(TEST_DELEGATE_PUB_KEY);
    });

    it("deserializes descriptor-form pubkeys to bytes, like default", () => {
        const params = DelegateContractHandler.deserializeParams({
            pubKey: `tr(${TEST_PUB_KEY_HEX})`,
            serverPubKey: `tr(${TEST_SERVER_PUB_KEY_HEX})`,
            delegatePubKey: `tr(${TEST_DELEGATE_PUB_KEY_HEX})`,
            csvTimelock: "144",
        });
        expect(params.pubKey).toEqual(TEST_PUB_KEY);
        expect(params.serverPubKey).toEqual(TEST_SERVER_PUB_KEY);
        expect(params.delegatePubKey).toEqual(TEST_DELEGATE_PUB_KEY);
    });

    it("falls back to the default timelock when csvTimelock is absent", () => {
        const params = DelegateContractHandler.deserializeParams({
            pubKey: TEST_PUB_KEY_HEX,
            serverPubKey: TEST_SERVER_PUB_KEY_HEX,
            delegatePubKey: TEST_DELEGATE_PUB_KEY_HEX,
        });
        // Not `{ type: "blocks", value: 0n }`, which is what an unguarded
        // `sequenceToTimelock(NaN)` yields.
        expect(params.csvTimelock).toEqual(DefaultVtxo.Script.DEFAULT_TIMELOCK);
    });

    it("falls back to the default timelock when csvTimelock is empty", () => {
        const params = DelegateContractHandler.deserializeParams({
            pubKey: TEST_PUB_KEY_HEX,
            serverPubKey: TEST_SERVER_PUB_KEY_HEX,
            delegatePubKey: TEST_DELEGATE_PUB_KEY_HEX,
            csvTimelock: "",
        });
        expect(params.csvTimelock).toEqual(DefaultVtxo.Script.DEFAULT_TIMELOCK);
    });

    it("round-trips params through serialize/deserialize", () => {
        const serialized = DelegateContractHandler.serializeParams({
            pubKey: TEST_PUB_KEY,
            serverPubKey: TEST_SERVER_PUB_KEY,
            delegatePubKey: TEST_DELEGATE_PUB_KEY,
            csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
        });
        expect(DelegateContractHandler.deserializeParams(serialized)).toEqual({
            pubKey: TEST_PUB_KEY,
            serverPubKey: TEST_SERVER_PUB_KEY,
            delegatePubKey: TEST_DELEGATE_PUB_KEY,
            csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
        });
    });

    it("builds the same pkScript from descriptor and hex params", () => {
        const fromHex = DelegateContractHandler.createScript({
            pubKey: TEST_PUB_KEY_HEX,
            serverPubKey: TEST_SERVER_PUB_KEY_HEX,
            delegatePubKey: TEST_DELEGATE_PUB_KEY_HEX,
            csvTimelock: "144",
        });
        const fromDescriptor = DelegateContractHandler.createScript({
            pubKey: `tr(${TEST_PUB_KEY_HEX})`,
            serverPubKey: `tr(${TEST_SERVER_PUB_KEY_HEX})`,
            delegatePubKey: `tr(${TEST_DELEGATE_PUB_KEY_HEX})`,
            csvTimelock: "144",
        });
        expect(hex.encode(fromDescriptor.pkScript)).toBe(hex.encode(fromHex.pkScript));
    });
});
