import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectrumWS } from "ws-electrumx-client";
import { ElectrumOnchainProvider, EsploraProvider } from "../../src";
import { networks } from "../../src/networks";

const { mockFetch } = vi.hoisted(() => ({
    mockFetch: vi.fn(),
}));

vi.mock("../../src/utils/fetch", () => ({
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

describe("verification chain sources", () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    it("fetches and trims Esplora raw transaction hex", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            text: () => Promise.resolve("02000000\n"),
        });
        const provider = new EsploraProvider("https://chain.example/api");

        await expect(provider.getTxHex("11".repeat(32))).resolves.toBe("02000000");
        expect(mockFetch).toHaveBeenCalledWith(
            `https://chain.example/api/tx/${"11".repeat(32)}/hex`,
        );
    });

    it("surfaces the Esplora response body when raw transaction lookup fails", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            text: () => Promise.resolve("transaction not found"),
        });
        const provider = new EsploraProvider("https://chain.example/api");

        await expect(provider.getTxHex("11".repeat(32))).rejects.toThrow(
            "Failed to get transaction hex: transaction not found",
        );
    });

    it("fetches Electrum raw transaction hex without verbose mode", async () => {
        const request = vi.fn().mockResolvedValue("02000000");
        const ws = {
            request,
            batchRequest: vi.fn(),
            subscribe: vi.fn(),
            unsubscribe: vi.fn(),
            close: vi.fn(),
        } as unknown as ElectrumWS;
        const provider = new ElectrumOnchainProvider(ws, networks.regtest);
        const txid = "22".repeat(32);

        await expect(provider.getTxHex(txid)).resolves.toBe("02000000");
        expect(request).toHaveBeenCalledWith("blockchain.transaction.get", txid, false);
    });
});
