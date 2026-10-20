import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexerUtxosUnsupportedError, RestIndexerProvider } from "../src";
import { MockEventSource } from "./mocks/eventSource";
import { jsonResponse } from "./helpers/response";

const { mockFetch } = vi.hoisted(() => ({
    mockFetch: vi.fn(),
}));

vi.mock("../src/utils/fetch", () => ({
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

describe("RestIndexerProvider", () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    describe("getVtxos", () => {
        it("serializes the current getVtxos query parameters", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ vtxos: [] }));

            const provider = new RestIndexerProvider("http://localhost:7070");
            await provider.getVtxos({
                scripts: ["script-a", "script-b"],
                spendableOnly: false,
                pendingOnly: true,
                after: 1678,
                before: 5234,
                pageIndex: 2,
                pageSize: 50,
            });

            expect(mockFetch).toHaveBeenCalledTimes(1);

            const requestUrl = new URL(mockFetch.mock.calls[0][0]);
            expect(requestUrl.origin + requestUrl.pathname).toBe(
                "http://localhost:7070/v1/indexer/vtxos",
            );
            expect(requestUrl.searchParams.getAll("scripts")).toEqual(["script-a", "script-b"]);
            expect(requestUrl.searchParams.get("spendableOnly")).toBe("false");
            expect(requestUrl.searchParams.get("pendingOnly")).toBe("true");
            expect(requestUrl.searchParams.get("after")).toBe("1678");
            expect(requestUrl.searchParams.get("before")).toBe("5234");
            expect(requestUrl.searchParams.get("page.index")).toBe("2");
            expect(requestUrl.searchParams.get("page.size")).toBe("50");
        });

        it("serializes the renewableOnly filter", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ vtxos: [] }));

            const provider = new RestIndexerProvider("http://localhost:7070");
            await provider.getVtxos({ scripts: ["script-a"], renewableOnly: true });

            const requestUrl = new URL(mockFetch.mock.calls[0][0]);
            expect(requestUrl.searchParams.get("renewableOnly")).toBe("true");
        });

        it("serializes outpoints and legacy filters alongside the new bounds", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ vtxos: [] }));

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
            expect(requestUrl.searchParams.getAll("outpoints")).toEqual(["txid-1:0", "txid-2:1"]);
            expect(requestUrl.searchParams.get("spentOnly")).toBe("true");
            expect(requestUrl.searchParams.get("after")).toBe("0");
            expect(requestUrl.searchParams.get("before")).toBe("0");
        });

        const wireVtxo = (txid: string) => ({
            outpoint: { txid, vout: 0 },
            createdAt: "1700000000",
            expiresAt: "1700003600",
            amount: "1000",
            script: "51200a",
            isPreconfirmed: false,
            isSwept: false,
            isUnrolled: false,
            isSpent: false,
            spentBy: null,
            commitmentTxids: [],
        });

        it("serves two identical concurrent reads from one request", async () => {
            let resolveFetch: (v: unknown) => void = () => {};
            mockFetch.mockReturnValueOnce(
                new Promise((resolve) => {
                    resolveFetch = resolve;
                }),
            );

            const provider = new RestIndexerProvider("http://localhost:7070");
            const first = provider.getVtxos({ scripts: ["script-a"] });
            const second = provider.getVtxos({ scripts: ["script-a"] });

            resolveFetch({
                ok: true,
                json: () => Promise.resolve({ vtxos: [wireVtxo("aa"), wireVtxo("bb")] }),
            });
            const [a, b] = await Promise.all([first, second]);

            expect(mockFetch).toHaveBeenCalledTimes(1);
            expect(a.vtxos.map((v) => v.txid)).toEqual(["aa", "bb"]);
            expect(b.vtxos.map((v) => v.txid)).toEqual(["aa", "bb"]);
        });

        it("gives each of those two callers an independently mutable result", async () => {
            let resolveFetch: (v: unknown) => void = () => {};
            mockFetch.mockReturnValueOnce(
                new Promise((resolve) => {
                    resolveFetch = resolve;
                }),
            );

            const provider = new RestIndexerProvider("http://localhost:7070");
            const first = provider.getVtxos({ scripts: ["script-a"] });
            const second = provider.getVtxos({ scripts: ["script-a"] });
            resolveFetch({
                ok: true,
                json: () => Promise.resolve({ vtxos: [wireVtxo("aa"), wireVtxo("bb")] }),
            });
            const [a, b] = await Promise.all([first, second]);

            // Two kinds of isolation, and the second is the one a shared
            // response would break: the array, then the coins inside it.
            a.vtxos.reverse();
            a.vtxos.find((v) => v.txid === "aa")!.value = 999;

            expect(b.vtxos.map((v) => v.txid)).toEqual(["aa", "bb"]);
            expect(b.vtxos.find((v) => v.txid === "aa")!.value).toBe(1000);
        });

        it("re-requests once the shared read has settled", async () => {
            const page = () => ({ ok: true, json: () => Promise.resolve({ vtxos: [] }) });
            mockFetch.mockResolvedValueOnce(page()).mockResolvedValueOnce(page());

            const provider = new RestIndexerProvider("http://localhost:7070");
            await provider.getVtxos({ scripts: ["script-a"] });
            await provider.getVtxos({ scripts: ["script-a"] });

            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        it("rejects requests that mix scripts and outpoints", async () => {
            const provider = new RestIndexerProvider("http://localhost:7070");

            await expect(
                provider.getVtxos({
                    scripts: ["script-a"],
                    // @ts-expect-error scripts and outpoints are mutually exclusive
                    outpoints: [{ txid: "txid-1", vout: 0 }],
                }),
            ).rejects.toThrow("scripts and outpoints are mutually exclusive options");

            expect(mockFetch).not.toHaveBeenCalled();
        });

        it("rejects requests without scripts or outpoints", async () => {
            const provider = new RestIndexerProvider("http://localhost:7070");

            // @ts-expect-error either scripts or outpoints must be provided
            await expect(provider.getVtxos({})).rejects.toThrow(
                "Either scripts or outpoints must be provided",
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
                }),
            ).rejects.toThrow(
                "spendableOnly, spentOnly, recoverableOnly, pendingOnly, and renewableOnly are mutually exclusive options",
            );

            expect(mockFetch).not.toHaveBeenCalled();
        });

        it("treats renewableOnly and pendingOnly as part of the exclusive filter set", async () => {
            const provider = new RestIndexerProvider("http://localhost:7070");

            await expect(
                provider.getVtxos({
                    scripts: ["script-a"],
                    renewableOnly: true,
                    spendableOnly: true,
                }),
            ).rejects.toThrow("mutually exclusive");
            await expect(
                provider.getVtxos({
                    scripts: ["script-a"],
                    pendingOnly: true,
                    recoverableOnly: true,
                }),
            ).rejects.toThrow("mutually exclusive");

            expect(mockFetch).not.toHaveBeenCalled();
        });

        it("pages an unpaged query to exhaustion", async () => {
            // The server answers with a page of its own choosing, so returning
            // its first one verbatim hands the caller a silent prefix.
            const vtxo = (txid: string) => ({
                outpoint: { txid, vout: 0 },
                amount: "1000",
                script: "51200000",
                createdAt: "1700000000",
                expiresAt: null,
                commitmentTxids: [],
                isPreconfirmed: false,
                isSwept: false,
                isUnrolled: false,
                isSpent: false,
                spentBy: "",
            });
            const fullPage = Array.from({ length: 500 }, (_, i) => vtxo(`page0-${i}`));
            // The server clamps page.index=0 to page 1 and echoes the 1-based
            // page in `current`; `next` points at the following page until the
            // last one, where it pins at `total`.
            mockFetch
                .mockResolvedValueOnce(
                    jsonResponse({
                        vtxos: fullPage,
                        page: { current: 1, next: 2, total: 2 },
                    }),
                )
                .mockResolvedValueOnce(
                    jsonResponse({
                        vtxos: [vtxo("page1-0")],
                        page: { current: 2, next: 2, total: 2 },
                    }),
                );

            const provider = new RestIndexerProvider("http://localhost:7070");
            const result = await provider.getVtxos({ scripts: ["script-a"] });

            expect(mockFetch).toHaveBeenCalledTimes(2);
            expect(result.vtxos).toHaveLength(501);
            expect(result.vtxos[500].txid).toBe("page1-0");
            // Nothing is left to ask for, so there is no cursor to hand back.
            expect(result.page).toBeUndefined();

            const pages = mockFetch.mock.calls.map((call: unknown[]) =>
                new URL(call[0] as string).searchParams.get("page.index"),
            );
            expect(pages).toEqual(["0", "2"]);
        });

        it("stops on a terminal page of exactly DEFAULT_VTXO_PAGE_SIZE vtxos", async () => {
            // A full page is not proof of another one: when the server says
            // this is the last page (current >= total), the loop must stop
            // rather than fire a request that comes back empty.
            const vtxo = (txid: string) => ({
                outpoint: { txid, vout: 0 },
                amount: "1000",
                script: "51200000",
                createdAt: "1700000000",
                expiresAt: null,
                commitmentTxids: [],
                isPreconfirmed: false,
                isSwept: false,
                isUnrolled: false,
                isSpent: false,
                spentBy: "",
            });
            const fullPage = Array.from({ length: 500 }, (_, i) => vtxo(`only-${i}`));
            mockFetch.mockResolvedValueOnce(
                jsonResponse({
                    vtxos: fullPage,
                    // The server clamps page.index=0 to page 1 and echoes
                    // the 1-based page: current 1 of 1, next pinned at 1.
                    page: { current: 1, next: 1, total: 1 },
                }),
            );

            const provider = new RestIndexerProvider("http://localhost:7070");
            const result = await provider.getVtxos({ scripts: ["script-a"] });

            expect(mockFetch).toHaveBeenCalledTimes(1);
            expect(result.vtxos).toHaveLength(500);
            expect(result.page).toBeUndefined();
        });

        it("leaves a caller-named page alone, cursor included", async () => {
            mockFetch.mockResolvedValueOnce(
                jsonResponse({ vtxos: [], page: { current: 2, next: 3, total: 9 } }),
            );

            const provider = new RestIndexerProvider("http://localhost:7070");
            const result = await provider.getVtxos({ scripts: ["script-a"], pageIndex: 2 });

            expect(mockFetch).toHaveBeenCalledTimes(1);
            expect(result.page).toEqual({ current: 2, next: 3, total: 9 });
        });

        it("propagates a server error on a later page of an unpaged query", async () => {
            const vtxo = (txid: string) => ({
                outpoint: { txid, vout: 0 },
                amount: "1000",
                script: "51200000",
                createdAt: "1700000000",
                expiresAt: null,
                commitmentTxids: [],
                isPreconfirmed: false,
                isSwept: false,
                isUnrolled: false,
                isSpent: false,
                spentBy: "",
            });
            const fullPage = Array.from({ length: 500 }, (_, i) => vtxo(`page0-${i}`));
            mockFetch
                .mockResolvedValueOnce(
                    jsonResponse({
                        vtxos: fullPage,
                        page: { current: 0, next: 1, total: 2 },
                    }),
                )
                .mockResolvedValueOnce({
                    ok: false,
                    statusText: "Internal Server Error",
                });

            const provider = new RestIndexerProvider("http://localhost:7070");

            // A partial result must never surface as if it were complete.
            await expect(provider.getVtxos({ scripts: ["script-a"] })).rejects.toThrow(
                "Failed to fetch vtxos: Internal Server Error",
            );
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        it("rejects invalid before/after bounds", async () => {
            const provider = new RestIndexerProvider("http://localhost:7070");

            await expect(
                provider.getVtxos({
                    scripts: ["script-a"],
                    after: 2000,
                    before: 2000,
                }),
            ).rejects.toThrow("before must be greater than after");

            expect(mockFetch).not.toHaveBeenCalled();
        });
    });

    describe("getUtxos", () => {
        const spender = "cc".repeat(32);
        const wireUtxo = (spend: Record<string, unknown>) => ({
            outpoint: { txid: "aa".repeat(32), vout: 1 },
            broadcastedAt: "1700000000",
            amount: "50000",
            script: "5120" + "bb".repeat(32),
            spend: { txid: spender, ...spend },
        });

        it("queries by outpoint and reads the spend, confirmed or not", async () => {
            mockFetch.mockResolvedValueOnce(
                jsonResponse({
                    utxos: [
                        wireUtxo({ confirmedAtTime: "1700000600", confirmedAtHeight: "210" }),
                        { ...wireUtxo({}), outpoint: { txid: "dd".repeat(32), vout: 0 } },
                    ],
                    page: null,
                }),
            );

            const provider = new RestIndexerProvider("http://localhost:7070");
            const { utxos } = await provider.getUtxos({
                outpoints: [
                    { txid: "aa".repeat(32), vout: 1 },
                    { txid: "dd".repeat(32), vout: 0 },
                ],
            });

            const url = new URL(mockFetch.mock.calls[0][0]);
            expect(url.pathname).toBe("/v1/indexer/utxos");
            expect(url.searchParams.getAll("outpoints")).toEqual([
                `${"aa".repeat(32)}:1`,
                `${"dd".repeat(32)}:0`,
            ]);
            expect(utxos).toEqual([
                {
                    txid: "aa".repeat(32),
                    vout: 1,
                    value: 50_000,
                    script: "5120" + "bb".repeat(32),
                    spentBy: spender,
                    spendConfirmation: { height: 210, time: 1_700_000_600 },
                },
                {
                    txid: "dd".repeat(32),
                    vout: 0,
                    value: 50_000,
                    script: "5120" + "bb".repeat(32),
                    spentBy: spender,
                },
            ]);
        });

        it("needs exactly one of scripts and outpoints", async () => {
            const provider = new RestIndexerProvider("http://localhost:7070");
            await expect(provider.getUtxos({ scripts: [] })).rejects.toThrow(/either/);
            await expect(
                provider.getUtxos({
                    scripts: ["s"],
                    outpoints: [{ txid: "aa".repeat(32), vout: 0 }],
                } as never),
            ).rejects.toThrow(/either/);
            expect(mockFetch).not.toHaveBeenCalled();
        });

        it("reports a server without the route, then stops asking", async () => {
            mockFetch.mockResolvedValueOnce(
                jsonResponse({ code: 5, message: "Not Found", details: [] }, { status: 404 }),
            );
            const provider = new RestIndexerProvider("http://localhost:7070");
            const query = { outpoints: [{ txid: "aa".repeat(32), vout: 0 }] };

            await expect(provider.getUtxos(query)).rejects.toBeInstanceOf(
                IndexerUtxosUnsupportedError,
            );
            await expect(provider.getUtxos(query)).rejects.toBeInstanceOf(
                IndexerUtxosUnsupportedError,
            );
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it.each([
            { utxos: [{ outpoint: {} }] },
            { utxos: [wireUtxo({ confirmedAtHeight: "x" })] },
            { utxos: [{ ...wireUtxo({}), amount: "xyz" }] },
        ])("rejects a malformed answer %#", async (body) => {
            mockFetch.mockResolvedValueOnce(jsonResponse(body));
            const provider = new RestIndexerProvider("http://localhost:7070");
            await expect(
                provider.getUtxos({ outpoints: [{ txid: "aa".repeat(32), vout: 0 }] }),
            ).rejects.toThrow("Invalid utxos data received");
        });
    });

    describe("getSubscription", () => {
        beforeEach(() => {
            MockEventSource.reset();
            vi.stubGlobal("EventSource", MockEventSource);
        });

        it("aborts a pending subscription even when EventSource.close emits nothing", async () => {
            const provider = new RestIndexerProvider("http://localhost:7070");
            const ac = new AbortController();
            const subscription = provider.getSubscription("sub-id", ac.signal);

            const pending = subscription.next();
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(MockEventSource.instances).toHaveLength(1);
            expect(MockEventSource.instances[0].closed).toBe(false);

            ac.abort();

            expect(MockEventSource.instances[0].closed).toBe(true);
            await expect(pending).resolves.toMatchObject({ done: true });
            expect(MockEventSource.instances[0].listenerCount("message")).toBe(0);
            expect(MockEventSource.instances[0].listenerCount("error")).toBe(0);
        });

        it("return closes a pending subscription even when EventSource.close emits nothing", async () => {
            const provider = new RestIndexerProvider("http://localhost:7070");
            const ac = new AbortController();
            const subscription = provider.getSubscription("sub-id", ac.signal);

            const pending = subscription.next();
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(MockEventSource.instances).toHaveLength(1);

            const returned = subscription.return?.();

            expect(MockEventSource.instances[0].closed).toBe(true);
            await expect(pending).resolves.toMatchObject({ done: true });
            await expect(returned).resolves.toMatchObject({ done: true });
            expect(MockEventSource.instances[0].listenerCount("message")).toBe(0);
            expect(MockEventSource.instances[0].listenerCount("error")).toBe(0);
        });
    });
});
