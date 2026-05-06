import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    contractPollProcessor,
    CONTRACT_POLL_TASK_TYPE,
} from "../../../../src/worker/expo/processors/contractPollProcessor";

describe("contractPollProcessor", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("saves paginated VTXOs for each contract", async () => {
        const now = Date.now();
        const contractA = {
            id: "contract-a",
            state: "active",
            address: "addr-a",
            script: "script-a",
        };
        const contractB = {
            id: "contract-b",
            state: "active",
            address: "addr-b",
            script: "script-b",
        };

        const firstPageVtxos = Array.from({ length: 100 }, (_, i) => ({
            txid: `tx-${i}`,
            vout: i,
            script: "script-a",
        }));
        const secondPageVtxos = [
            { txid: "tx-100", vout: 100, script: "script-a" },
        ];

        const contractRepository = {
            getContracts: vi.fn().mockResolvedValue([contractA, contractB]),
        };
        const walletRepository = {
            saveVtxos: vi.fn().mockResolvedValue(undefined),
        };
        const indexerProvider = {
            getVtxos: vi
                .fn()
                .mockResolvedValueOnce({
                    vtxos: firstPageVtxos,
                    page: { pageIndex: 0, pageSize: 100 },
                })
                .mockResolvedValueOnce({
                    vtxos: secondPageVtxos,
                    page: { pageIndex: 1, pageSize: 100 },
                })
                .mockResolvedValueOnce({
                    vtxos: [],
                    page: undefined,
                }),
        };
        const extendVtxo = vi.fn((vtxo: any, _contract?: any) => ({
            ...vtxo,
            extended: true,
        }));

        const result = await contractPollProcessor.execute(
            {
                id: "task-1",
                type: CONTRACT_POLL_TASK_TYPE,
                data: {},
                createdAt: now,
            },
            {
                contractRepository,
                walletRepository,
                indexerProvider,
                extendVtxo,
                arkProvider: {} as any,
            } as any
        );

        expect(indexerProvider.getVtxos).toHaveBeenCalledTimes(3);
        expect(indexerProvider.getVtxos).toHaveBeenNthCalledWith(1, {
            scripts: ["script-a"],
            pageIndex: 0,
            pageSize: 100,
        });
        expect(indexerProvider.getVtxos).toHaveBeenNthCalledWith(2, {
            scripts: ["script-a"],
            pageIndex: 1,
            pageSize: 100,
        });
        expect(indexerProvider.getVtxos).toHaveBeenNthCalledWith(3, {
            scripts: ["script-b"],
            pageIndex: 0,
            pageSize: 100,
        });

        expect(walletRepository.saveVtxos).toHaveBeenCalledTimes(2);
        expect(walletRepository.saveVtxos).toHaveBeenNthCalledWith(
            1,
            "addr-a",
            expect.arrayContaining([
                expect.objectContaining({ txid: "tx-0", extended: true }),
                expect.objectContaining({ txid: "tx-100", extended: true }),
            ])
        );
        expect(walletRepository.saveVtxos).toHaveBeenNthCalledWith(
            2,
            "addr-b",
            []
        );

        expect(extendVtxo).toHaveBeenCalledTimes(101);
        // Verify each call passes the owning contract as the second argument
        for (const call of extendVtxo.mock.calls) {
            expect(call[1]).toMatchObject({ id: "contract-a" });
        }
        expect(result).toEqual({
            taskItemId: "task-1",
            type: CONTRACT_POLL_TASK_TYPE,
            status: "success",
            data: {
                contractsProcessed: 2,
                vtxosSaved: 101,
            },
        });
    });
});
