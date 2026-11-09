import { afterEach, describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { ArkNote, Intent, MultisigTapscript, VtxoScript, type IntentCoin } from "../src";
import { contractHandlers } from "../src/contracts/handlers";
import type { Contract } from "../src/contracts/types";
import {
    deserializeUtxo,
    deserializeVtxo,
    serializeUtxo,
    serializeVtxo,
} from "../src/repositories/serialization";
import { deriveContractTapscripts } from "../src/wallet/utils";
import { createMockUtxo, createMockVtxo } from "./repositories/helpers";

const key = (seed: number) => schnorr.getPublicKey(new Uint8Array(32).fill(seed));
const script = new VtxoScript([
    MultisigTapscript.encode({ pubkeys: [key(1), key(2)] }).script,
    MultisigTapscript.encode({ pubkeys: [key(3), key(4)] }).script,
]);
const [leafA, leafB] = script.leaves;

const coin = {
    txid: hex.encode(new Uint8Array(32).fill(5)),
    vout: 0,
    value: 1000,
    tapTree: script.encode(),
    forfeitTapLeafScript: leafA,
    proofTapLeafScript: leafA,
} as unknown as IntentCoin;

const signedLeaf = (input: IntentCoin) =>
    Intent.create("msg", [input]).getInput(1).tapLeafScript?.[0];

describe("proofTapLeafScript", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("signs the leaf a coin carries", () => {
        expect(signedLeaf(coin)?.[1]).toEqual(leafA[1]);
        expect(signedLeaf({ ...coin, proofTapLeafScript: leafB })?.[1]).toEqual(leafB[1]);
    });

    it("signs the leaf a caller set with the deprecated key", () => {
        expect(signedLeaf({ ...coin, intentTapLeafScript: leafB })?.[1]).toEqual(leafB[1]);
    });

    it("stores the leaf under the old key and reads it back under the new one", () => {
        const vtxo = createMockVtxo("a".repeat(64), 0, 1);
        const utxo = createMockUtxo("b".repeat(64), 0, 1);
        for (const [original, stored, read] of [
            [vtxo, serializeVtxo(vtxo), deserializeVtxo(serializeVtxo(vtxo))],
            [utxo, serializeUtxo(utxo), deserializeUtxo(serializeUtxo(utxo))],
        ] as const) {
            expect(stored).toHaveProperty("intentTapLeafScript.cb");
            expect(stored).not.toHaveProperty("proofTapLeafScript");
            expect(read.proofTapLeafScript).toEqual(original.proofTapLeafScript);
            expect(read).not.toHaveProperty("intentTapLeafScript");
        }
    });

    it("stores the leaf a caller set with the deprecated key", () => {
        const vtxo = { ...createMockVtxo("a".repeat(64), 0, 1), intentTapLeafScript: leafB };
        expect(deserializeVtxo(serializeVtxo(vtxo)).proofTapLeafScript[1]).toEqual(leafB[1]);
    });

    it("keeps a working getter on ArkNote, which a spread drops", () => {
        const note = new ArkNote(new Uint8Array(32).fill(1), 1000);
        expect(note.intentTapLeafScript).toBe(note.proofTapLeafScript);
        expect({ ...note }).not.toHaveProperty("intentTapLeafScript");
        expect({ ...note }).toHaveProperty("proofTapLeafScript");
    });

    it("moves a handler's deprecated key to the new one", () => {
        vi.spyOn(contractHandlers, "get").mockReturnValue({
            createScript: () => script,
            deriveTapscripts: () => ({
                forfeitTapLeafScript: leafA,
                intentTapLeafScript: leafB,
                tapTree: script.encode(),
            }),
        } as never);
        const derived = deriveContractTapscripts({ type: "custom", params: {} } as Contract);
        expect(derived.proofTapLeafScript).toBe(leafB);
        expect(derived).not.toHaveProperty("intentTapLeafScript");
    });
});
