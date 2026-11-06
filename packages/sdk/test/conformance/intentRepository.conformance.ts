import { collectIntents } from "../../src/repositories/intentRepository";
import { describe, it, expect } from "vitest";
import {
    IntentRepository,
    ArkIntent,
    ArkIntentState,
} from "../../src/repositories/intentRepository";

const intent = (proofTxId: string, over: Partial<ArkIntent> = {}): ArkIntent => ({
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
    make: () => Promise<IntentRepository>,
): void {
    describe(`IntentRepository conformance: ${name}`, () => {
        it("saves, upserts by intentTxId, bumps updatedAt", async () => {
            const r = await make();
            await r.saveIntent(intent("a", { updatedAt: 1 }));
            await r.saveIntent(intent("a", { state: "waiting_for_batch", updatedAt: 1 }));
            const got = (await collectIntents(r, { proofTxIds: ["a"] }))[0];
            expect(got.state).toBe("waiting_for_batch");
            expect(got.updatedAt).toBeGreaterThan(1);
            expect((await collectIntents(r)).length).toBe(1);
        });

        it("rejects reusing an intentId for a different intentTxId, without losing the original", async () => {
            const r = await make();
            await r.saveIntent(intent("a", { registrationId: "srv1" }));
            await expect(r.saveIntent(intent("b", { registrationId: "srv1" }))).rejects.toThrow();
            // The original row must survive — no silent delete/replace.
            expect(
                (await collectIntents(r, { registrationIds: ["srv1"] })).map((i) => i.proofTxId),
            ).toEqual(["a"]);
        });

        it("allows updating the same intentTxId that keeps its intentId", async () => {
            const r = await make();
            await r.saveIntent(intent("a", { registrationId: "srv1", state: "waiting_for_batch" }));
            await expect(
                r.saveIntent(intent("a", { registrationId: "srv1", state: "batch_succeeded" })),
            ).resolves.toBeUndefined();
            expect((await collectIntents(r, { proofTxIds: ["a"] }))[0].state).toBe(
                "batch_succeeded",
            );
        });

        it("filters by state, intentId, containingInputs, searchText, validAt", async () => {
            const r = await make();
            await r.saveIntent(
                intent("a", {
                    state: "batch_succeeded",
                    registrationId: "srv1",
                    commitmentTransactionId: "ctx",
                    proofInputs: [{ txid: "p", vout: 1 }],
                    validFrom: 10,
                    validUntil: 20,
                }),
            );
            await r.saveIntent(intent("b", { state: "waiting_for_batch" }));
            expect(
                (await collectIntents(r, { states: ["batch_succeeded"] })).map((i) => i.proofTxId),
            ).toEqual(["a"]);
            expect(
                (await collectIntents(r, { registrationIds: ["srv1"] })).map((i) => i.proofTxId),
            ).toEqual(["a"]);
            expect(
                (
                    await collectIntents(r, {
                        containingInputs: [{ txid: "p", vout: 1 }],
                    })
                ).map((i) => i.proofTxId),
            ).toEqual(["a"]);
            expect(
                (await collectIntents(r, { searchText: "ctx" })).map((i) => i.proofTxId),
            ).toEqual(["a"]);
            // "null bounds = open": intent "b" has no validity window, so it
            // is valid at every instant; "a" is bounded [10, 20].
            expect((await collectIntents(r, { validAt: 15 })).map((i) => i.proofTxId)).toEqual([
                "a",
                "b",
            ]);
            expect((await collectIntents(r, { validAt: 25 })).map((i) => i.proofTxId)).toEqual([
                "b",
            ]);
        });

        it("orders by intentTxId across pages", async () => {
            const r = await make();
            // Written out of order, with same-createdAt ties and a
            // non-insertion-order timestamp to pin the cross-backend contract.
            await r.saveIntent(intent("d", { createdAt: 2 }));
            await r.saveIntent(intent("b", { createdAt: 1 }));
            await r.saveIntent(intent("a", { createdAt: 1 }));
            await r.saveIntent(intent("c", { createdAt: 2 }));
            // (createdAt, intentTxId): (1,a) (1,b) (2,c) (2,d)
            expect((await collectIntents(r)).map((i) => i.proofTxId)).toEqual(["a", "b", "c", "d"]);
            const first = await r.getIntentsPage(undefined, { limit: 2 });
            const second = await r.getIntentsPage(undefined, { limit: 2, after: first.nextCursor });
            expect(first.items.map((i) => i.proofTxId)).toEqual(["a", "b"]);
            expect(second.items.map((i) => i.proofTxId)).toEqual(["c", "d"]);
        });

        it("pages filtered intents by stable ID without dropping equal-time rows", async () => {
            const r = await make();
            for (const id of ["b", "B", "a", "c"]) {
                await r.saveIntent(
                    intent(id, { state: id === "c" ? "cancelled" : "waiting_for_batch" }),
                );
            }
            const filter = { states: ["waiting_for_batch" as const] };
            const first = await r.getIntentsPage(filter, { limit: 2 });
            expect(first.items.map((i) => i.proofTxId)).toEqual(["B", "a"]);
            expect(first.nextCursor).toBe("a");
            const second = await r.getIntentsPage(filter, { after: first.nextCursor, limit: 2 });
            expect(second.items.map((i) => i.proofTxId)).toEqual(["b"]);
            expect(second.nextCursor).toBeUndefined();
            await expect(r.getIntentsPage(undefined, { limit: 501 })).rejects.toThrow(RangeError);
        });

        it("pages an intentTxIds lookup and still applies the other filters", async () => {
            const r = await make();
            for (const id of ["b", "a", "c", "d"]) {
                await r.saveIntent(
                    intent(id, { state: id === "c" ? "cancelled" : "waiting_for_batch" }),
                );
            }
            const filter = {
                proofTxIds: ["d", "c", "a", "missing", "a"],
                states: ["waiting_for_batch" as const],
            };
            const first = await r.getIntentsPage(filter, { limit: 1 });
            expect(first.items.map((i) => i.proofTxId)).toEqual(["a"]);
            const second = await r.getIntentsPage(filter, { limit: 1, after: first.nextCursor });
            expect(second.items.map((i) => i.proofTxId)).toEqual(["d"]);
            expect(second.nextCursor).toBeUndefined();
        });

        it("locks exactly the non-terminal intents, including batch_in_progress", async () => {
            const r = await make();
            // batch_in_progress locks in TS but NOT in NArk EF storage — the TS
            // balance is offline-first and this set is its only coin lock, so an
            // in-progress batch's inputs must stay hidden. See
            // getLockedVtxoOutpoints docs.
            const cases: [ArkIntentState, boolean][] = [
                ["waiting_to_submit", true],
                ["waiting_for_batch", true],
                ["batch_in_progress", true],
                ["batch_failed", false],
                ["batch_succeeded", false],
                ["cancelled", false],
            ];
            for (const [state] of cases) {
                await r.saveIntent(
                    intent(state, { state, proofInputs: [{ txid: state, vout: 0 }] }),
                );
            }
            const locked = new Set((await r.getLockedVtxoOutpoints()).map((o) => o.txid));
            for (const [state, shouldLock] of cases) {
                expect(locked.has(state)).toBe(shouldLock);
            }
        });

        it("clear empties the store", async () => {
            const r = await make();
            await r.saveIntent(intent("a"));
            await r.clear();
            expect(await collectIntents(r)).toEqual([]);
        });
    });
}
