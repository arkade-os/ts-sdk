import { describe, it, expect } from "vitest";
import {
    IntentRepository,
    ArkIntent,
    ArkIntentState,
} from "../../src/repositories/intentRepository";

const intent = (intentTxId: string, over: Partial<ArkIntent> = {}): ArkIntent => ({
    intentTxId,
    state: "waiting_to_submit",
    createdAt: 1,
    updatedAt: 1,
    registerProof: "rp",
    registerProofMessage: "rpm",
    deleteProof: "dp",
    deleteProofMessage: "dpm",
    partialForfeits: [],
    intentVtxos: [{ txid: "x", vout: 0 }],
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
            const got = (await r.getIntents({ intentTxIds: ["a"] }))[0];
            expect(got.state).toBe("waiting_for_batch");
            expect(got.updatedAt).toBeGreaterThan(1);
            expect((await r.getIntents()).length).toBe(1);
        });

        it("rejects reusing an intentId for a different intentTxId, without losing the original", async () => {
            const r = await make();
            await r.saveIntent(intent("a", { intentId: "srv1" }));
            await expect(r.saveIntent(intent("b", { intentId: "srv1" }))).rejects.toThrow();
            // The original row must survive — no silent delete/replace.
            expect((await r.getIntents({ intentIds: ["srv1"] })).map((i) => i.intentTxId)).toEqual([
                "a",
            ]);
        });

        it("allows updating the same intentTxId that keeps its intentId", async () => {
            const r = await make();
            await r.saveIntent(intent("a", { intentId: "srv1", state: "waiting_for_batch" }));
            await expect(
                r.saveIntent(intent("a", { intentId: "srv1", state: "batch_succeeded" })),
            ).resolves.toBeUndefined();
            expect((await r.getIntents({ intentTxIds: ["a"] }))[0].state).toBe("batch_succeeded");
        });

        it("filters by state, intentId, containingInputs, searchText, validAt", async () => {
            const r = await make();
            await r.saveIntent(
                intent("a", {
                    state: "batch_succeeded",
                    intentId: "srv1",
                    commitmentTransactionId: "ctx",
                    intentVtxos: [{ txid: "p", vout: 1 }],
                    validFrom: 10,
                    validUntil: 20,
                }),
            );
            await r.saveIntent(intent("b", { state: "waiting_for_batch" }));
            expect(
                (await r.getIntents({ states: ["batch_succeeded"] })).map((i) => i.intentTxId),
            ).toEqual(["a"]);
            expect((await r.getIntents({ intentIds: ["srv1"] })).map((i) => i.intentTxId)).toEqual([
                "a",
            ]);
            expect(
                (
                    await r.getIntents({
                        containingInputs: [{ txid: "p", vout: 1 }],
                    })
                ).map((i) => i.intentTxId),
            ).toEqual(["a"]);
            expect((await r.getIntents({ searchText: "ctx" })).map((i) => i.intentTxId)).toEqual([
                "a",
            ]);
            // "null bounds = open": intent "b" has no validity window, so it
            // is valid at every instant; "a" is bounded [10, 20].
            expect((await r.getIntents({ validAt: 15 })).map((i) => i.intentTxId)).toEqual([
                "a",
                "b",
            ]);
            expect((await r.getIntents({ validAt: 25 })).map((i) => i.intentTxId)).toEqual(["b"]);
        });

        it("orders by (createdAt, intentTxId) across skip/take", async () => {
            const r = await make();
            // Written out of order, with same-createdAt ties and a
            // non-insertion-order timestamp to pin the cross-backend contract.
            await r.saveIntent(intent("d", { createdAt: 2 }));
            await r.saveIntent(intent("b", { createdAt: 1 }));
            await r.saveIntent(intent("a", { createdAt: 1 }));
            await r.saveIntent(intent("c", { createdAt: 2 }));
            // (createdAt, intentTxId): (1,a) (1,b) (2,c) (2,d)
            expect((await r.getIntents()).map((i) => i.intentTxId)).toEqual(["a", "b", "c", "d"]);
            expect((await r.getIntents({ skip: 1, take: 2 })).map((i) => i.intentTxId)).toEqual([
                "b",
                "c",
            ]);
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
                    intent(state, { state, intentVtxos: [{ txid: state, vout: 0 }] }),
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
            expect(await r.getIntents()).toEqual([]);
        });
    });
}
