import { Transaction } from "@arkade-os/sdk";
import { base64 } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signPsbt } from "../src/wallet";

// The confirmation gate is the only thing between a hostile dapp and a
// signature over the user's VTXOs, so it gets tested against the real
// signPsbt rather than the mock used by index.test.ts.

type SnapRequest = (args: { method: string; params?: unknown }) => Promise<unknown>;

const requestMock = vi.fn<SnapRequest>();

/** Build a structurally valid PSBT so Transaction.fromPSBT succeeds. */
function validPsbtBase64() {
    const tx = new Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });
    return base64.encode(tx.toPSBT());
}

describe("signPsbt user confirmation", () => {
    beforeEach(() => {
        requestMock.mockReset();
        (globalThis as Record<string, unknown>).snap = { request: requestMock };
    });

    afterEach(() => {
        delete (globalThis as Record<string, unknown>).snap;
    });

    it("asks for confirmation and names the requesting origin", async () => {
        requestMock.mockImplementation(async ({ method }) => {
            if (method === "snap_dialog") return false;
            throw new Error(`unexpected method ${method}`);
        });

        await expect(
            signPsbt({ psbt: validPsbtBase64(), inputIndexes: [0] }, "https://evil.example"),
        ).rejects.toThrow("User rejected the signature request");

        const dialogCall = requestMock.mock.calls.find(([a]) => a.method === "snap_dialog");
        expect(dialogCall).toBeDefined();
        expect(JSON.stringify(dialogCall?.[0].params)).toContain("https://evil.example");
    });

    it("never touches key material when the user rejects", async () => {
        requestMock.mockImplementation(async ({ method }) => {
            if (method === "snap_dialog") return false;
            throw new Error(`unexpected method ${method}`);
        });

        await expect(
            signPsbt({ psbt: validPsbtBase64(), inputIndexes: [0] }, "https://evil.example"),
        ).rejects.toThrow("User rejected");

        // The critical assertion: a rejection must not reach snap_getEntropy.
        const methods = requestMock.mock.calls.map(([a]) => a.method);
        expect(methods).toContain("snap_dialog");
        expect(methods).not.toContain("snap_getEntropy");
    });

    it("treats a non-true dialog result as a rejection", async () => {
        requestMock.mockImplementation(async ({ method }) => {
            if (method === "snap_dialog") return null;
            throw new Error(`unexpected method ${method}`);
        });

        await expect(
            signPsbt({ psbt: validPsbtBase64(), inputIndexes: [0] }, "https://dapp.example"),
        ).rejects.toThrow("User rejected the signature request");
    });

    it("requests confirmation before entropy when the user approves", async () => {
        const seen: string[] = [];
        requestMock.mockImplementation(async ({ method }) => {
            seen.push(method);
            if (method === "snap_dialog") return true;
            if (method === "snap_getEntropy") return `0x${"11".repeat(32)}`;
            throw new Error(`unexpected method ${method}`);
        });

        await signPsbt(
            { psbt: validPsbtBase64(), inputIndexes: [0] },
            "https://dapp.example",
        ).catch(() => {
            // Signing an input-less PSBT may still fail downstream; ordering
            // is what this test asserts.
        });

        expect(seen.indexOf("snap_dialog")).toBeGreaterThanOrEqual(0);
        if (seen.includes("snap_getEntropy")) {
            expect(seen.indexOf("snap_dialog")).toBeLessThan(seen.indexOf("snap_getEntropy"));
        }
    });
});
