import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { EsploraProvider } from "../src";
import { FetchError } from "../src/utils/fetch";

async function withExplorer(
    handler: RequestListener,
    check: (baseUrl: string, paths: string[]) => Promise<void>,
): Promise<void> {
    const paths: string[] = [];
    const server = createServer((req, res) => {
        paths.push(req.url!);
        handler(req, res);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    try {
        const { port } = server.address() as AddressInfo;
        await check(`http://127.0.0.1:${port}/custom/testnet/api`, paths);
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
        });
    }
}

it("uses the fastest recommendation when the Esplora endpoint is missing", async () => {
    await withExplorer(
        (req, res) => {
            if (req.url === "/custom/testnet/api/v1/fees/recommended") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ fastestFee: 4, halfHourFee: 2, minimumFee: 1 }));
            } else {
                res.writeHead(404);
                res.end("Not Found");
            }
        },
        async (baseUrl, paths) => {
            expect(await new EsploraProvider(baseUrl).getFeeRate()).toBe(4);
            expect(paths).toEqual([
                "/custom/testnet/api/fee-estimates",
                "/custom/testnet/api/v1/fees/recommended",
            ]);
        },
    );
});

it("releases the missing endpoint's response stream when falling back", async () => {
    let closed = false;
    await withExplorer(
        (req, res) => {
            if (req.url?.endsWith("/fee-estimates")) {
                res.on("close", () => {
                    closed = true;
                });
                res.writeHead(404);
                // Leave the body open so completion or buffering cannot release
                // the connection on the provider's behalf.
                res.write("Not Found");
            } else {
                res.end(JSON.stringify({ fastestFee: 4 }));
            }
        },
        async (baseUrl) => {
            expect(await new EsploraProvider(baseUrl).getFeeRate()).toBe(4);
            await expect.poll(() => closed, { timeout: 2000 }).toBe(true);
        },
    );
});

it.each([200, 203])(
    "preserves the Esplora estimate on HTTP %i without probing mempool",
    async (status) => {
        await withExplorer(
            (req, res) => {
                res.writeHead(status, { "content-type": "application/json" });
                res.end(
                    req.url?.endsWith("/fee-estimates")
                        ? JSON.stringify({ "1": 0.5 })
                        : JSON.stringify({ fastestFee: 4 }),
                );
            },
            async (baseUrl, paths) => {
                expect(await new EsploraProvider(baseUrl).getFeeRate()).toBe(0.5);
                expect(paths).toEqual(["/custom/testnet/api/fee-estimates"]);
            },
        );
    },
);

it("returns no estimate when neither endpoint exists", async () => {
    let fallbackClosed = false;
    await withExplorer(
        (req, res) => {
            res.writeHead(404);
            if (req.url?.endsWith("/fee-estimates")) {
                res.end();
            } else {
                res.on("close", () => {
                    fallbackClosed = true;
                });
                res.write("Not Found");
            }
        },
        async (baseUrl, paths) => {
            expect(await new EsploraProvider(baseUrl).getFeeRate()).toBeUndefined();
            expect(paths).toHaveLength(2);
            await expect.poll(() => fallbackClosed, { timeout: 2000 }).toBe(true);
        },
    );
});

describe.each([
    { endpoint: "Esplora", key: "1", requests: 1 },
    { endpoint: "mempool", key: "fastestFee", requests: 2 },
])("$endpoint fee response", ({ key, requests }) => {
    // Exercise both response formats through real HTTP, including the initial
    // 404 on the mempool path. No fetch or provider methods are mocked.
    async function withFeeResponse(
        handler: RequestListener,
        check: (provider: EsploraProvider) => Promise<void>,
    ): Promise<void> {
        await withExplorer(
            (req, res) => {
                if (requests === 2 && req.url?.endsWith("/fee-estimates")) {
                    res.writeHead(404);
                    res.end();
                } else {
                    handler(req, res);
                }
            },
            async (baseUrl, paths) => {
                await check(new EsploraProvider(baseUrl));
                expect(paths).toHaveLength(requests);
            },
        );
    }

    it.each([401, 429, 503])(
        "propagates HTTP %i instead of reporting no estimate",
        async (status) => {
            let closed = false;
            await withFeeResponse(
                (_req, res) => {
                    res.on("close", () => {
                        closed = true;
                    });
                    res.writeHead(status);
                    res.write("Explorer error");
                },
                async (provider) => {
                    await expect(provider.getFeeRate()).rejects.toThrow("Failed to fetch fee rate");
                    await expect.poll(() => closed, { timeout: 2000 }).toBe(true);
                },
            );
        },
    );

    it("propagates a disconnected transport instead of reporting no estimate", async () => {
        await withFeeResponse(
            (req) => req.socket.destroy(),
            async (provider) => {
                await expect(provider.getFeeRate()).rejects.toBeInstanceOf(FetchError);
            },
        );
    });

    it.each(["missing", "null"])("returns no estimate for a %s field", async (kind) => {
        await withFeeResponse(
            (_req, res) => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify(kind === "missing" ? {} : { [key]: null }));
            },
            async (provider) => {
                await expect(provider.getFeeRate()).resolves.toBeUndefined();
            },
        );
    });

    it("accepts valid JSON without a content-type header", async () => {
        await withFeeResponse(
            (_req, res) => res.end(JSON.stringify({ [key]: 2.75 })),
            async (provider) => {
                await expect(provider.getFeeRate()).resolves.toBe(2.75);
            },
        );
    });

    it("rejects an HTML application page returned with HTTP 200", async () => {
        let closed = false;
        await withFeeResponse(
            (_req, res) => {
                res.on("close", () => {
                    closed = true;
                });
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                res.write("<!doctype html><html>Explorer</html>");
            },
            async (provider) => {
                await expect(provider.getFeeRate()).rejects.toThrow(/Invalid fee estimate.*HTML/);
                await expect.poll(() => closed, { timeout: 2000 }).toBe(true);
            },
        );
    });

    it.each(["{broken", "null", "[]", "42", '"unexpected"'])(
        "rejects invalid payload %s",
        async (body) => {
            await withFeeResponse(
                (_req, res) => {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(body);
                },
                async (provider) => {
                    await expect(provider.getFeeRate()).rejects.toThrow();
                },
            );
        },
    );

    it.each(['"4"', "0", "-1", "1e309", "true"])("rejects unusable fee %s", async (value) => {
        await withFeeResponse(
            (_req, res) => {
                res.writeHead(200, { "content-type": "application/json" });
                // Raw JSON preserves the overflow case instead of serializing
                // Infinity to null, which means an unavailable estimate.
                res.end(`{"${key}":${value}}`);
            },
            async (provider) => {
                await expect(provider.getFeeRate()).rejects.toThrow("Invalid fee estimate");
            },
        );
    });
});
