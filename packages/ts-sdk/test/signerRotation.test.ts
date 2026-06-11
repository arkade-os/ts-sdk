import { describe, it, expect, vi, afterEach } from "vitest";
import {
    classifyContractSigner,
    classifyAgainstAxis,
    signerAxisFromInfo,
    isCooperativelyMigratable,
    toXOnlySignerHex,
} from "../src/wallet/signerRotation";
import type { ArkInfo, DeprecatedSigner } from "../src/providers/ark";
import { RestArkProvider } from "../src/providers/ark";

const ACTIVE = "aa".repeat(32);
const DEPRECATED_A = "bb".repeat(32);
const DEPRECATED_B = "cc".repeat(32);
const UNKNOWN = "dd".repeat(32);

// Minimal ArkInfo carrying only the fields the classifier reads.
function makeInfo(signerPubkey: string, deprecatedSigners: DeprecatedSigner[] = []): ArkInfo {
    return { signerPubkey, deprecatedSigners } as unknown as ArkInfo;
}

const NOW = 1_700_000_000; // fixed reference Unix time (seconds)

describe("signerRotation - classification", () => {
    it("classifies the active signer as current", () => {
        const info = makeInfo(ACTIVE, [{ pubkey: DEPRECATED_A, cutoffDate: BigInt(NOW + 1000) }]);
        const cls = classifyContractSigner(ACTIVE, info, NOW);
        expect(cls.status).toBe("CURRENT");
        expect(cls.signerPubKey).toBe(ACTIVE);
        expect(cls.cutoffDate).toBeUndefined();
    });

    it("classifies a deprecated signer with a future cutoff as migratable", () => {
        const cutoff = BigInt(NOW + 3600);
        const info = makeInfo(ACTIVE, [{ pubkey: DEPRECATED_A, cutoffDate: cutoff }]);
        const cls = classifyContractSigner(DEPRECATED_A, info, NOW);
        expect(cls.status).toBe("MIGRATABLE");
        expect(cls.cutoffDate).toBe(cutoff);
        expect(cls.secondsUntilCutoff).toBe(3600);
    });

    it("classifies a deprecated signer with no cutoff as dueNow", () => {
        const info = makeInfo(ACTIVE, [{ pubkey: DEPRECATED_A }]);
        const cls = classifyContractSigner(DEPRECATED_A, info, NOW);
        expect(cls.status).toBe("DUE_NOW");
        expect(cls.cutoffDate).toBeUndefined();
        expect(cls.secondsUntilCutoff).toBeUndefined();
    });

    it("classifies a deprecated signer whose cutoff has passed as expired", () => {
        const cutoff = BigInt(NOW - 10);
        const info = makeInfo(ACTIVE, [{ pubkey: DEPRECATED_A, cutoffDate: cutoff }]);
        const cls = classifyContractSigner(DEPRECATED_A, info, NOW);
        expect(cls.status).toBe("EXPIRED");
        expect(cls.secondsUntilCutoff).toBe(-10);
    });

    it("treats the exact cutoff instant as expired (window closed)", () => {
        const cutoff = BigInt(NOW);
        const info = makeInfo(ACTIVE, [{ pubkey: DEPRECATED_A, cutoffDate: cutoff }]);
        const cls = classifyContractSigner(DEPRECATED_A, info, NOW);
        expect(cls.status).toBe("EXPIRED");
        expect(cls.secondsUntilCutoff).toBe(0);
    });

    it("classifies an unadvertised signer as unknownSigner", () => {
        const info = makeInfo(ACTIVE, [{ pubkey: DEPRECATED_A, cutoffDate: BigInt(NOW + 1) }]);
        const cls = classifyContractSigner(UNKNOWN, info, NOW);
        expect(cls.status).toBe("UNKNOWN_SIGNER");
        expect(cls.cutoffDate).toBeUndefined();
    });

    it("normalizes a compressed (33-byte) deprecated signer to x-only for comparison", () => {
        const compressed = "03" + DEPRECATED_A; // 33-byte compressed form
        const info = makeInfo(ACTIVE, [{ pubkey: compressed }]);
        const cls = classifyContractSigner(DEPRECATED_A, info, NOW);
        // The contract stores the x-only key; the axis must still match it.
        expect(cls.status).toBe("DUE_NOW");
        expect(cls.signerPubKey).toBe(DEPRECATED_A);
    });

    it("builds an axis that dedupes/normalizes and supports multiple deprecated signers", () => {
        const info = makeInfo("02" + ACTIVE, [
            { pubkey: DEPRECATED_A, cutoffDate: BigInt(NOW + 100) },
            { pubkey: DEPRECATED_B },
        ]);
        const axis = signerAxisFromInfo(info);
        expect(axis.active).toBe(ACTIVE);
        expect(axis.deprecated.size).toBe(2);
        expect(classifyAgainstAxis(DEPRECATED_A, axis, NOW).status).toBe("MIGRATABLE");
        expect(classifyAgainstAxis(DEPRECATED_B, axis, NOW).status).toBe("DUE_NOW");
    });

    it("exposes a cooperative-migratability predicate", () => {
        expect(isCooperativelyMigratable("MIGRATABLE")).toBe(true);
        expect(isCooperativelyMigratable("DUE_NOW")).toBe(true);
        expect(isCooperativelyMigratable("EXPIRED")).toBe(false);
        expect(isCooperativelyMigratable("UNKNOWN_SIGNER")).toBe(false);
        expect(isCooperativelyMigratable("CURRENT")).toBe(false);
    });

    it("rejects malformed signer key lengths", () => {
        expect(() => toXOnlySignerHex("aabb")).toThrow(/invalid signer pubkey length/);
    });
});

describe("RestArkProvider.getInfo - deprecated signer parsing", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const stubInfo = (body: Record<string, unknown>) => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                statusText: "OK",
                json: () => Promise.resolve(body),
                text: () => Promise.resolve(""),
            }),
        );
    };

    it("preserves a missing cutoffDate as undefined (not coerced to 0n)", async () => {
        stubInfo({
            signerPubkey: ACTIVE,
            deprecatedSigners: [{ pubkey: DEPRECATED_A }],
        });
        const info = await new RestArkProvider("http://localhost:7070").getInfo();
        expect(info.deprecatedSigners).toHaveLength(1);
        expect(info.deprecatedSigners[0].pubkey).toBe(DEPRECATED_A);
        expect(info.deprecatedSigners[0].cutoffDate).toBeUndefined();
    });

    it("parses an explicit cutoffDate (including 0) as a bigint", async () => {
        stubInfo({
            signerPubkey: ACTIVE,
            deprecatedSigners: [
                { pubkey: DEPRECATED_A, cutoffDate: 1_700_000_000 },
                { pubkey: DEPRECATED_B, cutoffDate: 0 },
            ],
        });
        const info = await new RestArkProvider("http://localhost:7070").getInfo();
        expect(info.deprecatedSigners[0].cutoffDate).toBe(1_700_000_000n);
        // An explicit 0 must survive as 0n, distinct from a missing field.
        expect(info.deprecatedSigners[1].cutoffDate).toBe(0n);
    });

    it("defaults deprecatedSigners to an empty array when absent", async () => {
        stubInfo({ signerPubkey: ACTIVE });
        const info = await new RestArkProvider("http://localhost:7070").getInfo();
        expect(info.deprecatedSigners).toEqual([]);
    });
});
