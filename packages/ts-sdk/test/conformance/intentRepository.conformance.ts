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

        it("paginates with skip/take on a stable order", async () => {
            const r = await make();
            for (const id of ["a", "b", "c"]) await r.saveIntent(intent(id));
            const page = await r.getIntents({ skip: 1, take: 1 });
            expect(page.length).toBe(1);
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
