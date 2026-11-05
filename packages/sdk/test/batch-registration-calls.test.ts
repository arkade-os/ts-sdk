import { afterEach, describe, expect, it, vi } from "vitest";
import { Intent, RestArkProvider, RestEmulatorProvider, Wallet } from "../src";

const registerMessage: Intent.RegisterMessage = {
    type: "register",
    onchain_output_indexes: [],
    valid_at: 0,
    expire_at: 0,
    cosigners_public_keys: [],
};
const signed = { proof: "cHJvb2Y=", message: registerMessage };
const signedDelete = {
    proof: "cHJvb2Y=",
    message: { type: "delete", expire_at: 0 } as Intent.DeleteMessage,
};

/** Stubs `fetch`, answering every call with `body`, and returns the calls it saw. */
function stubFetch(body: unknown) {
    const spy = vi.fn(
        async (_url: string, _init?: RequestInit) =>
            new Response(JSON.stringify(body), { status: 200 }),
    );
    vi.stubGlobal("fetch", spy);
    return {
        url: () => spy.mock.calls[0][0],
        body: () => JSON.parse(String(spy.mock.calls[0][1]?.body)),
    };
}

afterEach(() => vi.unstubAllGlobals());

describe("what the operator and the emulator parse", () => {
    it("creates a batch registration through RegisterIntent", async () => {
        const http = stubFetch({ intentId: "r" });
        const id = await new RestArkProvider("http://o").createBatchRegistration(signed);
        expect(id).toBe("r");
        expect(http.url()).toBe("http://o/v1/batch/registerIntent");
        expect(http.body()).toEqual({
            intent: { proof: signed.proof, message: Intent.encodeMessage(registerMessage) },
        });
    });

    it("deletes a batch registration through DeleteIntent", async () => {
        const http = stubFetch({});
        await new RestArkProvider("http://o").deleteBatchRegistration(signedDelete);
        expect(http.url()).toBe("http://o/v1/batch/deleteIntent");
        expect(Object.keys(http.body())).toEqual(["intent"]);
    });

    it("submits a proof to the emulator's intent route", async () => {
        const http = stubFetch({ signedProof: "s" });
        await expect(new RestEmulatorProvider("http://e").submitProof(signed)).resolves.toBe("s");
        expect(http.url()).toBe("http://e/v1/intent");
        expect(Object.keys(http.body())).toEqual(["intent"]);
    });
});

describe("deprecated batch registration names", () => {
    it("forward provider calls", async () => {
        let http = stubFetch({ intentId: "r" });
        await new RestArkProvider("http://o").registerIntent(signed);
        expect(http.url()).toContain("/registerIntent");

        http = stubFetch({});
        await new RestArkProvider("http://o").deleteIntent(signedDelete);
        expect(http.url()).toContain("/deleteIntent");

        http = stubFetch({ signedProof: "s" });
        await new RestEmulatorProvider("http://e").submitIntent(signed);
        expect(http.url()).toContain("/v1/intent");
    });

    it("forward wallet calls", async () => {
        const wallet = Object.create(Wallet.prototype) as Wallet;
        wallet.safeCreateBatchRegistration = vi.fn().mockResolvedValue("r");
        wallet.makeBatchRegistrationProof = vi.fn().mockResolvedValue(signed);
        wallet.makeDeleteBatchRegistrationProof = vi.fn().mockResolvedValue(signedDelete);
        wallet.makeGetPendingTxProof = vi.fn().mockResolvedValue(signed);
        expect(await wallet.safeRegisterIntent(signed, [])).toBe("r");
        expect(await wallet.makeRegisterIntentSignature([], [], [], [])).toBe(signed);
        expect(await wallet.makeDeleteIntentSignature([])).toBe(signedDelete);
        expect(await wallet.makeGetPendingTxIntentSignature([])).toBe(signed);
    });
});
