import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemorySwapRepository } from "../src/repositories/inMemory/swap-repository";
import { IndexedDbSwapRepository } from "../src/repositories/IndexedDb/swap-repository";
import { BoltzReverseSwap, BoltzSubmarineSwap } from "../src/types";

const createReverseSwap = (id: string, status: BoltzReverseSwap["status"]): BoltzReverseSwap => ({
    id,
    type: "reverse",
    createdAt: Date.now() / 1000,
    preimage: "0".repeat(64),
    status,
    request: {
        claimPublicKey: "0".repeat(66),
        invoiceAmount: 10000,
        preimageHash: "0".repeat(64),
    },
    response: {
        id,
        invoice: "lnbc100n1p0",
        onchainAmount: 10000,
        lockupAddress: "ark1test",
        refundPublicKey: "0".repeat(66),
        timeoutBlockHeights: {
            refund: 100,
            unilateralClaim: 200,
            unilateralRefund: 300,
            unilateralRefundWithoutReceiver: 400,
        },
    },
});

const createSubmarineSwap = (
    id: string,
    status: BoltzSubmarineSwap["status"],
): BoltzSubmarineSwap => ({
    id,
    type: "submarine",
    createdAt: Date.now() / 1000,
    status,
    request: {
        invoice: "lnbc100n1p0",
        refundPublicKey: "0".repeat(66),
    },
    response: {
        id,
        address: "ark1test",
        expectedAmount: 10000,
        claimPublicKey: "0".repeat(66),
        acceptZeroConf: false,
        timeoutBlockHeights: {
            refund: 100,
            unilateralClaim: 200,
            unilateralRefund: 300,
            unilateralRefundWithoutReceiver: 400,
        },
    },
});

describe("SwapRepository implementations", () => {
    describe("InMemorySwapRepository", () => {
        let repo: InMemorySwapRepository;

        beforeEach(() => {
            repo = new InMemorySwapRepository();
        });

        afterEach(async () => {
            await repo.clear();
        });

        it("saves and retrieves swaps", async () => {
            const reverse = createReverseSwap("reverse-1", "swap.created");
            const submarine = createSubmarineSwap("submarine-1", "invoice.set");

            await repo.saveSwap(reverse);
            await repo.saveSwap(submarine);

            const reverseSwaps = await repo.getAllSwaps({
                type: "reverse",
            });
            const submarineSwaps = await repo.getAllSwaps({
                type: "submarine",
            });

            expect(reverseSwaps).toHaveLength(1);
            expect(reverseSwaps[0].id).toBe(reverse.id);
            expect(submarineSwaps).toHaveLength(1);
            expect(submarineSwaps[0].id).toBe(submarine.id);
        });

        it("filters swaps by id, status, and type", async () => {
            const reverseA = createReverseSwap("reverse-a", "swap.created");
            const reverseB = createReverseSwap("reverse-b", "swap.expired");
            const submarineA = createSubmarineSwap("submarine-a", "invoice.set");
            const submarineB = createSubmarineSwap("submarine-b", "transaction.mempool");

            await repo.saveSwap(reverseA);
            await repo.saveSwap(reverseB);
            await repo.saveSwap(submarineA);
            await repo.saveSwap(submarineB);

            const byId = await repo.getAllSwaps({
                id: "reverse-b",
                type: "reverse",
            });
            expect(byId).toHaveLength(1);
            expect(byId[0].id).toBe("reverse-b");

            const byStatus = await repo.getAllSwaps({
                status: "invoice.set",
                type: "submarine",
            });
            expect(byStatus).toHaveLength(1);
            expect(byStatus[0].id).toBe("submarine-a");
        });

        it("deletes swaps", async () => {
            const reverse = createReverseSwap("reverse-1", "swap.created");
            const submarine = createSubmarineSwap("submarine-1", "invoice.set");
            await repo.saveSwap(reverse);
            await repo.saveSwap(submarine);

            await repo.deleteSwap(reverse.id);
            await repo.deleteSwap(submarine.id);

            expect(await repo.getAllSwaps()).toHaveLength(0);
        });

        it("clears all swaps", async () => {
            await repo.saveSwap(createReverseSwap("reverse-1", "swap.created"));
            await repo.saveSwap(createSubmarineSwap("submarine-1", "invoice.set"));

            await repo.clear();

            expect(await repo.getAllSwaps()).toHaveLength(0);
        });

        it("orders swaps by createdAt when requested", async () => {
            const oldest = createReverseSwap("reverse-old", "swap.created");
            const newest = createSubmarineSwap("submarine-new", "invoice.set");
            oldest.createdAt = 10;
            newest.createdAt = 30;
            const middle = createReverseSwap("reverse-mid", "swap.created");
            middle.createdAt = 20;

            await repo.saveSwap(middle);
            await repo.saveSwap(oldest);
            await repo.saveSwap(newest);

            const swaps = await repo.getAllSwaps({
                orderBy: "createdAt",
                orderDirection: "desc",
            });

            expect(swaps.map((swap) => swap.id)).toEqual([
                "submarine-new",
                "reverse-mid",
                "reverse-old",
            ]);
        });
    });

    describe("IndexedDbSwapRepository", () => {
        let repo: IndexedDbSwapRepository;

        beforeEach(() => {
            const dbName = `swap-repo-test-${Date.now()}-${Math.random()}`;
            repo = new IndexedDbSwapRepository(dbName);
        });

        afterEach(async () => {
            await repo.clear();
            await repo[Symbol.asyncDispose]();
        });

        it("saves and retrieves swaps", async () => {
            const reverse = createReverseSwap("reverse-1", "swap.created");
            const submarine = createSubmarineSwap("submarine-1", "invoice.set");

            await repo.saveSwap(reverse);
            await repo.saveSwap(submarine);

            const reverseSwaps = await repo.getAllSwaps({
                type: "reverse",
            });
            const submarineSwaps = await repo.getAllSwaps({
                type: "submarine",
            });

            expect(reverseSwaps).toHaveLength(1);
            expect(reverseSwaps[0].id).toBe(reverse.id);
            expect(submarineSwaps).toHaveLength(1);
            expect(submarineSwaps[0].id).toBe(submarine.id);
        });

        it("filters swaps by id, status, and type", async () => {
            const reverseA = createReverseSwap("reverse-a", "swap.created");
            const reverseB = createReverseSwap("reverse-b", "swap.expired");
            const submarineA = createSubmarineSwap("submarine-a", "invoice.set");
            const submarineB = createSubmarineSwap("submarine-b", "transaction.mempool");

            await repo.saveSwap(reverseA);
            await repo.saveSwap(reverseB);
            await repo.saveSwap(submarineA);
            await repo.saveSwap(submarineB);

            const byId = await repo.getAllSwaps({
                id: "reverse-b",
                type: "reverse",
            });
            expect(byId).toHaveLength(1);
            expect(byId[0].id).toBe("reverse-b");

            const byStatus = await repo.getAllSwaps({
                status: "invoice.set",
                type: "submarine",
            });
            expect(byStatus).toHaveLength(1);
            expect(byStatus[0].id).toBe("submarine-a");
        });

        it("deletes swaps", async () => {
            const reverse = createReverseSwap("reverse-1", "swap.created");
            const submarine = createSubmarineSwap("submarine-1", "invoice.set");
            await repo.saveSwap(reverse);
            await repo.saveSwap(submarine);

            await repo.deleteSwap(reverse.id);
            await repo.deleteSwap(submarine.id);

            expect(await repo.getAllSwaps()).toHaveLength(0);
        });

        it("clears all swaps", async () => {
            await repo.saveSwap(createReverseSwap("reverse-1", "swap.created"));
            await repo.saveSwap(createSubmarineSwap("submarine-1", "invoice.set"));

            await repo.clear();

            expect(await repo.getAllSwaps()).toHaveLength(0);
        });

        it("orders swaps by createdAt when requested", async () => {
            const oldest = createReverseSwap("reverse-old", "swap.created");
            const newest = createSubmarineSwap("submarine-new", "invoice.set");
            oldest.createdAt = 10;
            newest.createdAt = 30;
            const middle = createReverseSwap("reverse-mid", "swap.created");
            middle.createdAt = 20;

            await repo.saveSwap(middle);
            await repo.saveSwap(oldest);
            await repo.saveSwap(newest);

            const swaps = await repo.getAllSwaps({
                orderBy: "createdAt",
                orderDirection: "desc",
            });

            expect(swaps.map((swap) => swap.id)).toEqual([
                "submarine-new",
                "reverse-mid",
                "reverse-old",
            ]);
        });
    });

    /** The connection contract of the shared managed-connection helper, seen
     * through this repository: a connection that goes away is forgotten and
     * reopened instead of bricking the store until reload. */
    describe("IndexedDbSwapRepository whose connection went away", () => {
        const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

        it("reopens after an external delete", async () => {
            const dbName = `swap-reopen-${Math.random()}`;
            const repo = new IndexedDbSwapRepository(dbName);
            await repo.saveSwap(createReverseSwap("reverse-1", "swap.created"));

            await new Promise<void>((resolve, reject) => {
                const del = indexedDB.deleteDatabase(dbName);
                del.onsuccess = () => resolve();
                del.onerror = () => reject(del.error);
            });
            await flush();

            // recreated and empty, the point being that it opens one at all
            await repo.saveSwap(createReverseSwap("reverse-2", "swap.created"));
            expect((await repo.getAllSwaps()).map((s) => s.id)).toEqual(["reverse-2"]);
            await repo[Symbol.asyncDispose]();
        });

        it("fails honestly, and repeatably, when another tab upgraded past it", async () => {
            const dbName = `swap-newer-${Math.random()}`;
            const repo = new IndexedDbSwapRepository(dbName);
            await repo.saveSwap(createReverseSwap("reverse-1", "swap.created"));

            const newer = await new Promise<IDBDatabase>((resolve, reject) => {
                const open = indexedDB.open(dbName, 99);
                open.onsuccess = () => resolve(open.result);
                open.onerror = () => reject(open.error);
            });
            await flush();
            try {
                for (const attempt of [1, 2]) {
                    await expect(
                        repo.saveSwap(createReverseSwap(`reverse-${attempt}`, "swap.created")),
                        `attempt ${attempt}`,
                    ).rejects.toMatchObject({ name: "VersionError" });
                }
            } finally {
                newer.close();
            }
        });
    });
});
