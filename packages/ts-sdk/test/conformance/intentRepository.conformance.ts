import { describe, it, expect } from "vitest";
import { IntentRepository, ArkIntent } from "../../src/repositories/intentRepository";

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

        it("getLockedVtxoOutpoints excludes terminal intents", async () => {
            const r = await make();
            await r.saveIntent(
                intent("live", {
                    state: "waiting_for_batch",
                    intentVtxos: [{ txid: "L", vout: 0 }],
                }),
            );
            await r.saveIntent(
                intent("done", {
                    state: "batch_succeeded",
                    intentVtxos: [{ txid: "D", vout: 0 }],
                }),
            );
            const locked = await r.getLockedVtxoOutpoints();
            expect(locked).toEqual([{ txid: "L", vout: 0 }]);
        });

        it("clear empties the store", async () => {
            const r = await make();
            await r.saveIntent(intent("a"));
            await r.clear();
            expect(await r.getIntents()).toEqual([]);
        });
    });
}
