import { afterEach, describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    ArkNote,
    CSVMultisigTapscript,
    MultisigTapscript,
    Proof,
    VtxoScript,
    type ProofInput,
} from "../src";
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
const multisig = MultisigTapscript.encode({ pubkeys: [key(1), key(2)] }).script;
// Timelocked, so the proof input's sequence shows which leaf it was built from.
const csvMultisig = CSVMultisigTapscript.encode({
    timelock: { type: "blocks", value: 144n },
    pubkeys: [key(3)],
}).script;
const script = new VtxoScript([multisig, csvMultisig]);
const leafA = script.findLeaf(hex.encode(multisig));
const leafB = script.findLeaf(hex.encode(csvMultisig));

const coin = {
    txid: hex.encode(new Uint8Array(32).fill(5)),
    vout: 0,
    value: 1000,
    tapTree: script.encode(),
    forfeitTapLeafScript: leafA,
    proofTapLeafScript: leafA,
} as unknown as ProofInput;

const proofInput = (input: ProofInput) => Proof.create("msg", [input]).getInput(1);

describe("proofTapLeafScript", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("builds the proof input from the leaf a coin carries", () => {
        expect(proofInput(coin).tapLeafScript?.[0][1]).toEqual(leafA[1]);
        const input = proofInput({ ...coin, proofTapLeafScript: leafB });
        expect(input.tapLeafScript?.[0][1]).toEqual(leafB[1]);
        expect(input.sequence).toBe(144);
    });

    it("builds the proof input from the leaf a caller set with the deprecated key", () => {
        const input = proofInput({ ...coin, intentTapLeafScript: leafB });
        expect(input.tapLeafScript?.[0][1]).toEqual(leafB[1]);
        expect(input.sequence).toBe(144);
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
