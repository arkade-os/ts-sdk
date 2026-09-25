import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { EventSource } from "eventsource";
import { expect, it } from "vitest";
import { ContractWatcher, InMemoryWalletRepository, RestIndexerProvider } from "../src";
import type { Contract } from "../src/contracts/types";

it.each([false, true])(
    "cancels an in-flight subscription on stop (stale ID recovery: %s)",
    async (staleId) => {
        let posts = 0;
        let held: ServerResponse | undefined;
        let closed = false;
        const streams = new Set<ServerResponse>();
        const server = createServer(async (req, res) => {
            for await (const _chunk of req) {
                // Consume the request so only the response remains pending.
            }
            if (req.url?.endsWith("/subscribe")) {
                posts++;
                if (staleId && posts === 2) {
                    res.writeHead(400);
                    res.end("subscription sub-1 not found");
                } else if (posts === (staleId ? 3 : 2)) {
                    held = res;
                    res.on("close", () => (closed = true));
                } else {
                    res.end(JSON.stringify({ subscriptionId: `sub-${posts}` }));
                }
            } else if (req.url?.includes("/subscription/")) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.write(": connected\n\n");
                streams.add(res);
                res.on("close", () => streams.delete(res));
            } else {
                res.end(JSON.stringify({ vtxos: [] }));
            }
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const { port } = server.address() as AddressInfo;
        const watcher = new ContractWatcher({
            indexerProvider: new RestIndexerProvider(`http://127.0.0.1:${port}`, {
                eventSource: (url) => new EventSource(url),
            }),
            walletRepository: new InMemoryWalletRepository(),
        });
        const contract: Contract = {
            type: "default",
            params: {},
            script: "aa",
            address: "ark1qfixture",
            state: "active",
            watch: "watched",
            createdAt: 0,
        };
        let update: Promise<void> | undefined;
        try {
            await watcher.addContract(contract);
            await watcher.startWatching(() => {});
            let settled = false;
            update = watcher.updateContract(contract).then(() => {
                settled = true;
            });
            await expect.poll(() => held).toBeDefined();
            await watcher.stopWatching();
            await expect.poll(() => closed && settled).toBe(true);
            await watcher.startWatching(() => {});
            expect(watcher.getConnectionState()).toBe("connected");
        } finally {
            held?.end(JSON.stringify({ subscriptionId: "old-subscription" }));
            await update;
            await watcher.stopWatching();
            for (const stream of streams) stream.end();
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            });
        }
    },
);
