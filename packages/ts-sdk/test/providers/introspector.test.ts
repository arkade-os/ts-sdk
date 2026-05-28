import { describe, it, expect, vi, beforeEach } from "vitest";
import { RestIntrospectorProvider } from "../../src/providers/introspector";

describe("RestIntrospectorProvider.submitOnchainTx", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("POSTs the tx to /v1/onchain-tx and returns the signed tx", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify({ signedTx: "SIGNED_B64" }), {
                status: 200,
            }),
        );

        const provider = new RestIntrospectorProvider("http://introspector");
        const result = await provider.submitOnchainTx("RAW_B64");

        expect(result).toEqual({ signedTx: "SIGNED_B64" });
        expect(fetchMock).toHaveBeenCalledWith(
            "http://introspector/v1/onchain-tx",
            expect.objectContaining({
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tx: "RAW_B64" }),
            }),
        );
    });

    it("throws when the response lacks signedTx", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify({}), { status: 200 }),
        );

        const provider = new RestIntrospectorProvider("http://introspector");
        await expect(provider.submitOnchainTx("RAW_B64")).rejects.toThrow(/missing signedTx/);
    });

    it("throws on non-2xx", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));

        const provider = new RestIntrospectorProvider("http://introspector");
        await expect(provider.submitOnchainTx("RAW_B64")).rejects.toThrow(
            /Failed to submit onchain tx to introspector: boom/,
        );
    });
});
