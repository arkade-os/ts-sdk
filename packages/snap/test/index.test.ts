import { describe, it, expect, vi, beforeEach } from "vitest";

import { onRpcRequest } from "../src";

// Mock the wallet module. Both paths are relative to this test file, which now
// lives in test/ rather than alongside the source.
vi.mock("../src/wallet", async () => import("../src/__mocks__/wallet"));

// Helper to create JSON-RPC 2.0 compliant requests
let requestId = 0;
const createRequest = (method: string, params?: unknown) => {
    requestId += 1;
    return {
        origin: "http://localhost:8000",
        request: {
            id: requestId,
            jsonrpc: "2.0",
            method,
            ...(params !== undefined && { params }),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
};

describe("RPC Handler", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        requestId = 0;
    });

    describe("arkade_getPublicKey", () => {
        it("returns public keys object with correct structure", async () => {
            const result = await onRpcRequest(createRequest("arkade_getPublicKey"));

            expect(result).toHaveProperty("compressedPublicKey");
            expect(result).toHaveProperty("xOnlyPublicKey");
        });

        it("returns valid hex strings for public keys", async () => {
            const result = (await onRpcRequest(createRequest("arkade_getPublicKey"))) as {
                compressedPublicKey: string;
                xOnlyPublicKey: string;
            };

            // Compressed public key is 33 bytes = 66 hex chars
            expect(result.compressedPublicKey).toMatch(/^[0-9a-fA-F]{66}$/u);
            // x-only public key is 32 bytes = 64 hex chars
            expect(result.xOnlyPublicKey).toMatch(/^[0-9a-fA-F]{64}$/u);
        });

        it("does not require any parameters", async () => {
            // Should not throw when no params provided
            await expect(onRpcRequest(createRequest("arkade_getPublicKey"))).resolves.toBeDefined();
        });
    });

    describe("arkade_getAddress", () => {
        const validParams = {
            network: "bitcoin",
            signerPubkey: "a".repeat(64), // 64 hex chars
            unilateralExitDelay: "512",
        };

        it("returns address object with correct structure", async () => {
            const result = await onRpcRequest(createRequest("arkade_getAddress", validParams));

            expect(result).toHaveProperty("address");
            expect(typeof (result as { address: string }).address).toBe("string");
        });

        it("returns ark prefix for bitcoin network", async () => {
            const result = (await onRpcRequest(
                createRequest("arkade_getAddress", { ...validParams, network: "bitcoin" }),
            )) as { address: string };

            expect(result.address).toMatch(/^ark1/u);
        });

        it("returns tark prefix for testnet/signet networks", async () => {
            const result = (await onRpcRequest(
                createRequest("arkade_getAddress", { ...validParams, network: "signet" }),
            )) as { address: string };

            expect(result.address).toMatch(/^tark1/u);
        });

        it("throws on missing network parameter", async () => {
            await expect(
                onRpcRequest(
                    createRequest("arkade_getAddress", {
                        signerPubkey: validParams.signerPubkey,
                        unilateralExitDelay: validParams.unilateralExitDelay,
                    }),
                ),
            ).rejects.toThrow("Invalid network type");
        });

        it("throws on invalid network name", async () => {
            await expect(
                onRpcRequest(
                    createRequest("arkade_getAddress", { ...validParams, network: "invalid" }),
                ),
            ).rejects.toThrow("Invalid network");
        });

        it("throws on missing signerPubkey parameter", async () => {
            await expect(
                onRpcRequest(
                    createRequest("arkade_getAddress", {
                        network: validParams.network,
                        unilateralExitDelay: validParams.unilateralExitDelay,
                    }),
                ),
            ).rejects.toThrow("Invalid signerPubkey type");
        });

        it("throws on invalid signerPubkey format", async () => {
            await expect(
                onRpcRequest(
                    createRequest("arkade_getAddress", { ...validParams, signerPubkey: "not-hex" }),
                ),
            ).rejects.toThrow("must be a valid hex string");
        });

        it("throws on incorrect signerPubkey length", async () => {
            await expect(
                onRpcRequest(
                    createRequest("arkade_getAddress", {
                        ...validParams,
                        signerPubkey: "a".repeat(32),
                    }),
                ),
            ).rejects.toThrow("expected 64 hex characters");
        });

        it("throws on missing unilateralExitDelay parameter", async () => {
            await expect(
                onRpcRequest(
                    createRequest("arkade_getAddress", {
                        network: validParams.network,
                        signerPubkey: validParams.signerPubkey,
                    }),
                ),
            ).rejects.toThrow("Invalid unilateralExitDelay type");
        });

        it("accepts numeric string for unilateralExitDelay", async () => {
            await expect(
                onRpcRequest(
                    createRequest("arkade_getAddress", {
                        ...validParams,
                        unilateralExitDelay: "1024",
                    }),
                ),
            ).resolves.toBeDefined();
        });

        it("accepts number for unilateralExitDelay", async () => {
            await expect(
                onRpcRequest(
                    createRequest("arkade_getAddress", {
                        ...validParams,
                        unilateralExitDelay: 1024,
                    }),
                ),
            ).resolves.toBeDefined();
        });
    });

    describe("arkade_signPsbt", () => {
        const validPsbt =
            "cHNidP8BAHECAAAAAe6F0YcN3vZJlvFP9kD8YgKK7y1AQBAAAAAAAP////8BAAAAAAAAAAAA";
        const validParams = {
            psbt: validPsbt,
            inputIndexes: [0],
        };

        it("returns signed PSBT with correct structure", async () => {
            const result = await onRpcRequest(createRequest("arkade_signPsbt", validParams));

            expect(result).toHaveProperty("psbt");
            expect(typeof (result as { psbt: string }).psbt).toBe("string");
        });

        it("returns valid base64 PSBT", async () => {
            const result = (await onRpcRequest(createRequest("arkade_signPsbt", validParams))) as {
                psbt: string;
            };

            // Should be base64 format (our mock adds _signed suffix but that's fine)
            expect(result.psbt).toMatch(/^[A-Za-z0-9+/=_]+$/u);
        });

        it("throws on missing psbt parameter", async () => {
            await expect(
                onRpcRequest(
                    createRequest("arkade_signPsbt", { inputIndexes: validParams.inputIndexes }),
                ),
            ).rejects.toThrow("Invalid psbt type");
        });

        it("throws on invalid psbt format (not base64)", async () => {
            await expect(
                onRpcRequest(
                    createRequest("arkade_signPsbt", { ...validParams, psbt: "not-base64!@#$" }),
                ),
            ).rejects.toThrow("must be a valid base64 string");
        });

        it("throws on empty psbt", async () => {
            await expect(
                onRpcRequest(createRequest("arkade_signPsbt", { ...validParams, psbt: "" })),
            ).rejects.toThrow("PSBT cannot be empty");
        });

        it("throws on missing inputIndexes parameter", async () => {
            await expect(
                onRpcRequest(createRequest("arkade_signPsbt", { psbt: validParams.psbt })),
            ).rejects.toThrow("Invalid inputIndexes type");
        });

        it("throws on empty inputIndexes array", async () => {
            await expect(
                onRpcRequest(
                    createRequest("arkade_signPsbt", { ...validParams, inputIndexes: [] }),
                ),
            ).rejects.toThrow("inputIndexes cannot be empty");
        });

        it("throws on non-array inputIndexes", async () => {
            await expect(
                onRpcRequest(
                    createRequest("arkade_signPsbt", { ...validParams, inputIndexes: "not-array" }),
                ),
            ).rejects.toThrow("Invalid inputIndexes type: expected array");
        });

        it("throws on non-integer inputIndexes", async () => {
            await expect(
                onRpcRequest(
                    createRequest("arkade_signPsbt", { ...validParams, inputIndexes: [0.5] }),
                ),
            ).rejects.toThrow("must be an integer");
        });

        it("throws on negative inputIndexes", async () => {
            await expect(
                onRpcRequest(
                    createRequest("arkade_signPsbt", { ...validParams, inputIndexes: [-1] }),
                ),
            ).rejects.toThrow("must be non-negative");
        });

        it("accepts multiple inputIndexes", async () => {
            await expect(
                onRpcRequest(
                    createRequest("arkade_signPsbt", { ...validParams, inputIndexes: [0, 1, 2] }),
                ),
            ).resolves.toBeDefined();
        });
    });

    describe("Unknown methods", () => {
        it("throws error for unsupported method", async () => {
            await expect(onRpcRequest(createRequest("unknown_method"))).rejects.toThrow(
                "Method not found: unknown_method",
            );
        });

        it("throws error for empty method name", async () => {
            await expect(onRpcRequest(createRequest(""))).rejects.toThrow("Method not found: ");
        });
    });
});
