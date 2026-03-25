import { beforeEach, describe, expect, it, vi } from "vitest";
import { RestIndexerProvider } from "../src";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("RestIndexerProvider", () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    describe("getVtxos", () => {
        it("serializes the current getVtxos query parameters", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ vtxos: [] }),
            });

            const provider = new RestIndexerProvider("http://localhost:7070");
            await provider.getVtxos({
                scripts: ["script-a", "script-b"],
                spendableOnly: false,
                pendingOnly: true,
                after: 5234,
                before: 1678,
                pageIndex: 2,
                pageSize: 50,
            });

            expect(mockFetch).toHaveBeenCalledTimes(1);

            const requestUrl = new URL(mockFetch.mock.calls[0][0]);
            expect(requestUrl.origin + requestUrl.pathname).toBe(
                "http://localhost:7070/v1/indexer/vtxos"
            );
            expect(requestUrl.searchParams.getAll("scripts")).toEqual([
                "script-a",
                "script-b",
            ]);
            expect(requestUrl.searchParams.get("spendableOnly")).toBe("false");
            expect(requestUrl.searchParams.get("pendingOnly")).toBe("true");
            expect(requestUrl.searchParams.get("after")).toBe("5234");
            expect(requestUrl.searchParams.get("before")).toBe("1678");
            expect(requestUrl.searchParams.get("page.index")).toBe("2");
            expect(requestUrl.searchParams.get("page.size")).toBe("50");
        });

        it("serializes outpoints and legacy filters alongside the new bounds", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ vtxos: [] }),
            });

            const provider = new RestIndexerProvider("http://localhost:7070");
            await provider.getVtxos({
                outpoints: [
                    { txid: "txid-1", vout: 0 },
                    { txid: "txid-2", vout: 1 },
                ],
                spentOnly: true,
                after: 0,
                before: 0,
            });

            const requestUrl = new URL(mockFetch.mock.calls[0][0]);
            expect(requestUrl.searchParams.getAll("outpoints")).toEqual([
                "txid-1:0",
                "txid-2:1",
            ]);
            expect(requestUrl.searchParams.get("spentOnly")).toBe("true");
            expect(requestUrl.searchParams.get("after")).toBe("0");
            expect(requestUrl.searchParams.get("before")).toBe("0");
        });

        it("rejects requests that mix scripts and outpoints", async () => {
            const provider = new RestIndexerProvider("http://localhost:7070");

            await expect(
                // @ts-expect-error scripts and outpoints are mutually exclusive
                provider.getVtxos({
                    scripts: ["script-a"],
                    outpoints: [{ txid: "txid-1", vout: 0 }],
                })
            ).rejects.toThrow(
                "scripts and outpoints are mutually exclusive options"
            );

            expect(mockFetch).not.toHaveBeenCalled();
        });

        it("rejects requests without scripts or outpoints", async () => {
            const provider = new RestIndexerProvider("http://localhost:7070");

            // @ts-expect-error either scripts or outpoints must be provided
            await expect(provider.getVtxos({})).rejects.toThrow(
                "Either scripts or outpoints must be provided"
            );

            expect(mockFetch).not.toHaveBeenCalled();
        });

        it("rejects mutually exclusive spend filters", async () => {
            const provider = new RestIndexerProvider("http://localhost:7070");

            await expect(
                provider.getVtxos({
                    scripts: ["script-a"],
                    spendableOnly: true,
                    spentOnly: true,
                })
            ).rejects.toThrow(
                "spendableOnly, spentOnly, and recoverableOnly are mutually exclusive options"
            );

            expect(mockFetch).not.toHaveBeenCalled();
        });

        it("rejects invalid before/after bounds", async () => {
            const provider = new RestIndexerProvider("http://localhost:7070");

            await expect(
                provider.getVtxos({
                    scripts: ["script-a"],
                    after: 2000,
                    before: 2000,
                })
            ).rejects.toThrow("before must be smaller than after");

            expect(mockFetch).not.toHaveBeenCalled();
        });
    });
});
