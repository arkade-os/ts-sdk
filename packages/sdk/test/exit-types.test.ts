import { describe, expect, it } from "vitest";
import {
    deserializeExitPackage,
    ExitPackage,
    serializeExitPackage,
} from "../src/wallet/exit/types";

const validPkg: ExitPackage = {
    version: 1,
    network: "regtest",
    createdAt: 1720000000,
    validUntil: 1725000000,
    feeRate: 2,
    sweepAddress: "bcrt1pexample",
    totals: { txCount: 4, totalFeeSats: 1488, fundingRequiredSats: 1730, recoveredSats: 49700 },
    vtxos: [
        {
            outpoint: "aa".repeat(32) + ":0",
            value: 50000,
            sweepFee: 300,
            path: "default:exit",
            delay: { type: "blocks", value: 144 },
        },
        { outpoint: "bb".repeat(32) + ":1", skipped: "uneconomic: value 400 <= sweep fee + dust" },
    ],
    steps: [
        { kind: "broadcast", txid: "cc".repeat(32), hex: "02000000" },
        {
            kind: "package",
            parentTxid: "dd".repeat(32),
            parentHex: "02000000",
            childTxid: "ee".repeat(32),
            childHex: "03000000",
            forVtxos: ["aa".repeat(32) + ":0"],
        },
        {
            kind: "sweep",
            vtxo: "aa".repeat(32) + ":0",
            txid: "ff".repeat(32),
            hex: "02000000",
            dependsOnTxid: "aa".repeat(32),
            delay: { type: "blocks", value: 144 },
        },
    ],
};

describe("exit package codec", () => {
    it("round-trips a valid package", () => {
        const json = serializeExitPackage(validPkg);
        expect(deserializeExitPackage(json)).toEqual(validPkg);
    });

    it("rejects unknown version", () => {
        const json = JSON.stringify({ ...validPkg, version: 2 });
        expect(() => deserializeExitPackage(json)).toThrow(/unsupported exit package version/i);
    });

    it("rejects malformed JSON", () => {
        expect(() => deserializeExitPackage("{nope")).toThrow();
    });

    it("rejects step with unknown kind", () => {
        const bad = { ...validPkg, steps: [{ kind: "explode", txid: "00", hex: "00" }] };
        expect(() => deserializeExitPackage(JSON.stringify(bad))).toThrow(/invalid step/i);
    });

    it("rejects sweep step without delay", () => {
        const bad = {
            ...validPkg,
            steps: [{ kind: "sweep", vtxo: "a:0", txid: "00", hex: "00", dependsOnTxid: "00" }],
        };
        expect(() => deserializeExitPackage(JSON.stringify(bad))).toThrow(/invalid step/i);
    });

    it("rejects malformed totals", () => {
        const bad = { ...validPkg, totals: { txCount: 4 } };
        expect(() => deserializeExitPackage(JSON.stringify(bad))).toThrow(/malformed totals/i);
    });
});
