import { collectBatchRegistrations } from "../../src/repositories/batchRegistrationRepository";
import { describe, it, expect } from "vitest";
import {
    BatchRegistrationRepository,
    BatchRegistration,
    BatchRegistrationState,
} from "../../src/repositories/batchRegistrationRepository";

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
    inputs: [{ txid: "x", vout: 0 }],
    ...over,
});

export function batchRegistrationRepositoryConformance(
    name: string,
    make: () => Promise<BatchRegistrationRepository>,
): void {
    describe(`BatchRegistrationRepository conformance: ${name}`, () => {
        it("saves, upserts by proofTxId, bumps updatedAt", async () => {
            const r = await make();
            await r.saveRegistration(intent("a", { updatedAt: 1 }));
            await r.saveRegistration(intent("a", { state: "waiting_for_batch", updatedAt: 1 }));
            const got = (await collectBatchRegistrations(r, { proofTxIds: ["a"] }))[0];
            expect(got.state).toBe("waiting_for_batch");
            expect(got.updatedAt).toBeGreaterThan(1);
            expect((await collectBatchRegistrations(r)).length).toBe(1);
        });

        it("rejects reusing an registrationId for a different proofTxId, without losing the original", async () => {
            const r = await make();
            await r.saveRegistration(intent("a", { registrationId: "srv1" }));
            await expect(
                r.saveRegistration(intent("b", { registrationId: "srv1" })),
            ).rejects.toThrow();
            // The original row must survive — no silent delete/replace.
            expect(
                (await collectBatchRegistrations(r, { registrationIds: ["srv1"] })).map(
                    (i) => i.proofTxId,
                ),
            ).toEqual(["a"]);
        });

        it("allows updating the same proofTxId that keeps its registrationId", async () => {
            const r = await make();
            await r.saveRegistration(
                intent("a", { registrationId: "srv1", state: "waiting_for_batch" }),
            );
            await expect(
                r.saveRegistration(
                    intent("a", { registrationId: "srv1", state: "batch_succeeded" }),
                ),
            ).resolves.toBeUndefined();
            expect((await collectBatchRegistrations(r, { proofTxIds: ["a"] }))[0].state).toBe(
                "batch_succeeded",
            );
        });

        it("filters by state, registrationId, containingInputs, searchText, validAt", async () => {
            const r = await make();
            await r.saveRegistration(
                intent("a", {
                    state: "batch_succeeded",
                    registrationId: "srv1",
                    commitmentTransactionId: "ctx",
                    inputs: [{ txid: "p", vout: 1 }],
                    validFrom: 10,
                    validUntil: 20,
                }),
            );
            await r.saveRegistration(intent("b", { state: "waiting_for_batch" }));
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

        it("orders by proofTxId across pages", async () => {
            const r = await make();
            // Written out of order, with same-createdAt ties and a
            // non-insertion-order timestamp to pin the cross-backend contract.
            await r.saveRegistration(intent("d", { createdAt: 2 }));
            await r.saveRegistration(intent("b", { createdAt: 1 }));
            await r.saveRegistration(intent("a", { createdAt: 1 }));
            await r.saveRegistration(intent("c", { createdAt: 2 }));
            // (createdAt, intentTxId): (1,a) (1,b) (2,c) (2,d)
            expect((await collectBatchRegistrations(r)).map((i) => i.proofTxId)).toEqual([
                "a",
                "b",
                "c",
                "d",
            ]);
            const first = await r.getRegistrationsPage(undefined, { limit: 2 });
            const second = await r.getRegistrationsPage(undefined, {
                limit: 2,
                after: first.nextCursor,
            });
            expect(first.items.map((i) => i.proofTxId)).toEqual(["a", "b"]);
            expect(second.items.map((i) => i.proofTxId)).toEqual(["c", "d"]);
        });

        it("pages filtered registrations by stable ID without dropping equal-time rows", async () => {
            const r = await make();
            for (const id of ["b", "B", "a", "c"]) {
                await r.saveRegistration(
                    intent(id, { state: id === "c" ? "cancelled" : "waiting_for_batch" }),
                );
            }
            const filter = { states: ["waiting_for_batch" as const] };
            const first = await r.getRegistrationsPage(filter, { limit: 2 });
            expect(first.items.map((i) => i.proofTxId)).toEqual(["B", "a"]);
            expect(first.nextCursor).toBe("a");
            const second = await r.getRegistrationsPage(filter, {
                after: first.nextCursor,
                limit: 2,
            });
            expect(second.items.map((i) => i.proofTxId)).toEqual(["b"]);
            expect(second.nextCursor).toBeUndefined();
            await expect(r.getRegistrationsPage(undefined, { limit: 501 })).rejects.toThrow(
                RangeError,
            );
        });

        it("pages an intentTxIds lookup and still applies the other filters", async () => {
            const r = await make();
            for (const id of ["b", "a", "c", "d"]) {
                await r.saveRegistration(
                    intent(id, { state: id === "c" ? "cancelled" : "waiting_for_batch" }),
                );
            }
            const filter = {
                proofTxIds: ["d", "c", "a", "missing", "a"],
                states: ["waiting_for_batch" as const],
            };
            const first = await r.getRegistrationsPage(filter, { limit: 1 });
            expect(first.items.map((i) => i.proofTxId)).toEqual(["a"]);
            const second = await r.getRegistrationsPage(filter, {
                limit: 1,
                after: first.nextCursor,
            });
            expect(second.items.map((i) => i.proofTxId)).toEqual(["d"]);
            expect(second.nextCursor).toBeUndefined();
        });

        it("locks exactly the non-terminal registrations, including batch_in_progress", async () => {
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
                await r.saveRegistration(
                    intent(state, { state, inputs: [{ txid: state, vout: 0 }] }),
                );
            }
            const locked = new Set((await r.getLockedVtxoOutpoints()).map((o) => o.txid));
            for (const [state, shouldLock] of cases) {
                expect(locked.has(state)).toBe(shouldLock);
            }
        });

        it("clear empties the store", async () => {
            const r = await make();
            await r.saveRegistration(intent("a"));
            await r.clear();
            expect(await collectBatchRegistrations(r)).toEqual([]);
        });
    });
}
