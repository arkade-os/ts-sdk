import { collectBatchRegistrations } from "../../src/repositories/intentRepository";
import { describe, it, expect } from "vitest";
import {
    BatchRegistrationRepository,
    BatchRegistration,
    BatchRegistrationState,
} from "../../src/repositories/intentRepository";

const intent = (proofTxId: string, over: Partial<BatchRegistration> = {}): BatchRegistration => ({
    proofTxId,
    state: "waiting_to_submit",
    createdAt: 1,
    updatedAt: 1,
    registerProof: "rp",
    registerProofMessage: "rpm",
    deleteProof: "dp",
    deleteProofMessage: "dpm",
    partialForfeits: [],
    proofInputs: [{ txid: "x", vout: 0 }],
    ...over,
});

export function intentRepositoryConformance(
    name: string,
    make: () => Promise<BatchRegistrationRepository>,
): void {
    describe(`BatchRegistrationRepository conformance: ${name}`, () => {
        it("saves, upserts by intentTxId, bumps updatedAt", async () => {
            const r = await make();
            await r.saveBatchRegistration(intent("a", { updatedAt: 1 }));
            await r.saveBatchRegistration(
                intent("a", { state: "waiting_for_batch", updatedAt: 1 }),
            );
            const got = (await collectBatchRegistrations(r, { proofTxIds: ["a"] }))[0];
            expect(got.state).toBe("waiting_for_batch");
            expect(got.updatedAt).toBeGreaterThan(1);
            expect((await collectBatchRegistrations(r)).length).toBe(1);
        });

        it("rejects reusing an intentId for a different intentTxId, without losing the original", async () => {
            const r = await make();
            await r.saveBatchRegistration(intent("a", { registrationId: "srv1" }));
            await expect(
                r.saveBatchRegistration(intent("b", { registrationId: "srv1" })),
            ).rejects.toThrow();
            // The original row must survive — no silent delete/replace.
            expect(
                (await collectBatchRegistrations(r, { registrationIds: ["srv1"] })).map(
                    (i) => i.proofTxId,
                ),
            ).toEqual(["a"]);
        });

        it("allows updating the same intentTxId that keeps its intentId", async () => {
            const r = await make();
            await r.saveBatchRegistration(
                intent("a", { registrationId: "srv1", state: "waiting_for_batch" }),
            );
            await expect(
                r.saveBatchRegistration(
                    intent("a", { registrationId: "srv1", state: "batch_succeeded" }),
                ),
            ).resolves.toBeUndefined();
            expect((await collectBatchRegistrations(r, { proofTxIds: ["a"] }))[0].state).toBe(
                "batch_succeeded",
            );
        });

        it("filters by state, intentId, containingInputs, searchText, validAt", async () => {
            const r = await make();
            await r.saveBatchRegistration(
                intent("a", {
                    state: "batch_succeeded",
                    registrationId: "srv1",
                    commitmentTransactionId: "ctx",
                    proofInputs: [{ txid: "p", vout: 1 }],
                    validFrom: 10,
                    validUntil: 20,
                }),
            );
            await r.saveBatchRegistration(intent("b", { state: "waiting_for_batch" }));
            expect(
                (await collectBatchRegistrations(r, { states: ["batch_succeeded"] })).map(
                    (i) => i.proofTxId,
                ),
            ).toEqual(["a"]);
            expect(
                (await collectBatchRegistrations(r, { registrationIds: ["srv1"] })).map(
                    (i) => i.proofTxId,
                ),
            ).toEqual(["a"]);
            expect(
                (
                    await collectBatchRegistrations(r, {
                        containingInputs: [{ txid: "p", vout: 1 }],
                    })
                ).map((i) => i.proofTxId),
            ).toEqual(["a"]);
            expect(
                (await collectBatchRegistrations(r, { searchText: "ctx" })).map((i) => i.proofTxId),
            ).toEqual(["a"]);
            // "null bounds = open": intent "b" has no validity window, so it
            // is valid at every instant; "a" is bounded [10, 20].
            expect(
                (await collectBatchRegistrations(r, { validAt: 15 })).map((i) => i.proofTxId),
            ).toEqual(["a", "b"]);
            expect(
                (await collectBatchRegistrations(r, { validAt: 25 })).map((i) => i.proofTxId),
            ).toEqual(["b"]);
        });

        it("orders by intentTxId across pages", async () => {
            const r = await make();
            // Written out of order, with same-createdAt ties and a
            // non-insertion-order timestamp to pin the cross-backend contract.
            await r.saveBatchRegistration(intent("d", { createdAt: 2 }));
            await r.saveBatchRegistration(intent("b", { createdAt: 1 }));
            await r.saveBatchRegistration(intent("a", { createdAt: 1 }));
            await r.saveBatchRegistration(intent("c", { createdAt: 2 }));
            // (createdAt, intentTxId): (1,a) (1,b) (2,c) (2,d)
            expect((await collectBatchRegistrations(r)).map((i) => i.proofTxId)).toEqual([
                "a",
                "b",
                "c",
                "d",
            ]);
            const first = await r.getBatchRegistrationsPage(undefined, { limit: 2 });
            const second = await r.getBatchRegistrationsPage(undefined, {
                limit: 2,
                after: first.nextCursor,
            });
            expect(first.items.map((i) => i.proofTxId)).toEqual(["a", "b"]);
            expect(second.items.map((i) => i.proofTxId)).toEqual(["c", "d"]);
        });

        it("pages filtered intents by stable ID without dropping equal-time rows", async () => {
            const r = await make();
            for (const id of ["b", "B", "a", "c"]) {
                await r.saveBatchRegistration(
                    intent(id, { state: id === "c" ? "cancelled" : "waiting_for_batch" }),
                );
            }
            const filter = { states: ["waiting_for_batch" as const] };
            const first = await r.getBatchRegistrationsPage(filter, { limit: 2 });
            expect(first.items.map((i) => i.proofTxId)).toEqual(["B", "a"]);
            expect(first.nextCursor).toBe("a");
            const second = await r.getBatchRegistrationsPage(filter, {
                after: first.nextCursor,
                limit: 2,
            });
            expect(second.items.map((i) => i.proofTxId)).toEqual(["b"]);
            expect(second.nextCursor).toBeUndefined();
            await expect(r.getBatchRegistrationsPage(undefined, { limit: 501 })).rejects.toThrow(
                RangeError,
            );
        });

        it("pages an intentTxIds lookup and still applies the other filters", async () => {
            const r = await make();
            for (const id of ["b", "a", "c", "d"]) {
                await r.saveBatchRegistration(
                    intent(id, { state: id === "c" ? "cancelled" : "waiting_for_batch" }),
                );
            }
            const filter = {
                proofTxIds: ["d", "c", "a", "missing", "a"],
                states: ["waiting_for_batch" as const],
            };
            const first = await r.getBatchRegistrationsPage(filter, { limit: 1 });
            expect(first.items.map((i) => i.proofTxId)).toEqual(["a"]);
            const second = await r.getBatchRegistrationsPage(filter, {
                limit: 1,
                after: first.nextCursor,
            });
            expect(second.items.map((i) => i.proofTxId)).toEqual(["d"]);
            expect(second.nextCursor).toBeUndefined();
        });

        it("locks exactly the non-terminal intents, including batch_in_progress", async () => {
            const r = await make();
            // batch_in_progress locks in TS but NOT in NArk EF storage — the TS
            // balance is offline-first and this set is its only coin lock, so an
            // in-progress batch's inputs must stay hidden. See
            // getLockedVtxoOutpoints docs.
            const cases: [BatchRegistrationState, boolean][] = [
                ["waiting_to_submit", true],
                ["waiting_for_batch", true],
                ["batch_in_progress", true],
                ["batch_failed", false],
                ["batch_succeeded", false],
                ["cancelled", false],
            ];
            for (const [state] of cases) {
                await r.saveBatchRegistration(
                    intent(state, { state, proofInputs: [{ txid: state, vout: 0 }] }),
                );
            }
            const locked = new Set((await r.getLockedVtxoOutpoints()).map((o) => o.txid));
            for (const [state, shouldLock] of cases) {
                expect(locked.has(state)).toBe(shouldLock);
            }
        });

        it("saves and pages through the batch registration methods", async () => {
            const r = await make();
            await r.saveBatchRegistration(intent("a"));
            const page = await r.getBatchRegistrationsPage(undefined, { limit: 10 });
            expect(page.items).toEqual([
                expect.objectContaining({ ...intent("a"), updatedAt: expect.any(Number) }),
            ]);
        });

        it("clear empties the store", async () => {
            const r = await make();
            await r.saveBatchRegistration(intent("a"));
            await r.clear();
            expect(await collectBatchRegistrations(r)).toEqual([]);
        });
    });
}
