import { describe, expect, it, vi, afterEach } from "vitest";
import { EsploraProvider } from "../src/providers/onchain";

const PARENT = "aa".repeat(40);
const CHILD = "bb".repeat(40);

function mockFetch(status: number, body: unknown) {
    const spy = vi.fn(async () => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    }));
    vi.stubGlobal("fetch", spy);
    return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe("broadcasting a 1P1C package", () => {
    /**
     * Captured from a real mainnet failure. `/txs/package` proxies Bitcoin
     * Core's `submitpackage`, which reports per-transaction results in the body
     * — so a package whose transactions were all rejected still answers 200.
     *
     * Checking only the HTTP status therefore reads "transaction failed" as
     * success. Downstream, the exit executor took that as a broadcast, emitted
     * a broadcast event, and settled into `waitConfirmed` polling for a
     * transaction that was never accepted: a permanent spinner where the node
     * had given a precise reason.
     */
    const REJECTED = {
        package_msg: "transaction failed",
        "tx-results": {
            "736db81c94ac2a2fe60c64a2030e930be1a1ebe1660506430a1e4b7aa4f177ca": {
                txid: "4bd17634ce487df3bb2c47df7ada651f4ee7cbe8df6fb98529ff75bc8ec57d6b",
                error: "bad-txns-inputs-missingorspent",
            },
            be2000793183a0ed026e092e5df45289317ed004fb10514ab6eb2d98700c037c: {
                txid: "926751c5710257dd2617530c6e891cc07975715787c2e77c067e621d0e9754c4",
                error: "bad-txns-inputs-missingorspent",
            },
        },
        "replaced-transactions": [],
    };

    it("throws when a 200 body reports the package failed", async () => {
        mockFetch(200, REJECTED);
        const p = new EsploraProvider("https://example.invalid/api");
        await expect(p.broadcastTransaction(PARENT, CHILD)).rejects.toThrow(/transaction failed/i);
    });

    // The reason is the whole value of the failure: "already spent" means the
    // branch is dead and no retry helps, while a fee error means top up and
    // retry. Losing it leaves the caller unable to tell those apart.
    it("surfaces the node's per-transaction reason", async () => {
        mockFetch(200, REJECTED);
        const p = new EsploraProvider("https://example.invalid/api");
        await expect(p.broadcastTransaction(PARENT, CHILD)).rejects.toThrow(
            /bad-txns-inputs-missingorspent/,
        );
    });

    it("names the transaction that failed, not just the package", async () => {
        mockFetch(200, REJECTED);
        const p = new EsploraProvider("https://example.invalid/api");
        await expect(p.broadcastTransaction(PARENT, CHILD)).rejects.toThrow(/4bd17634/);
    });

    it("still accepts a successful submit", async () => {
        mockFetch(200, { package_msg: "success", "tx-results": {}, "replaced-transactions": [] });
        const p = new EsploraProvider("https://example.invalid/api");
        await expect(p.broadcastTransaction(PARENT, CHILD)).resolves.toBeDefined();
    });

    // Not every Esplora proxies Core's shape. An unrecognised 200 body must
    // stay a success, or this hardening breaks working deployments.
    it("accepts a 200 whose body carries no package verdict", async () => {
        mockFetch(200, { txid: "cc".repeat(32) });
        const p = new EsploraProvider("https://example.invalid/api");
        await expect(p.broadcastTransaction(PARENT, CHILD)).resolves.toBeDefined();
    });

    it("still throws on a non-2xx response", async () => {
        mockFetch(400, "sendrawtransaction RPC error");
        const p = new EsploraProvider("https://example.invalid/api");
        await expect(p.broadcastTransaction(PARENT, CHILD)).rejects.toThrow(/Failed to broadcast/);
    });
});
