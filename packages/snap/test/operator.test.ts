import { SingleKey } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readState, updateState } from "../src/operator";
import { getAddress } from "../src/wallet";
import { installSnap, MAINNET_ADDRESS, MAINNET_INFO, stubOperators } from "./harness";

const CUSTOM = "http://localhost:7070";
const REGTEST_INFO = { ...MAINNET_INFO, network: "regtest", unilateralExitDelay: "20" };
const ROTATED_KEY = hex.encode(await SingleKey.fromHex("33".repeat(32)).compressedPublicKey());

describe("arkade_getAddress resolves the operator itself", () => {
    beforeEach(() => installSnap());
    afterEach(() => {
        vi.unstubAllGlobals();
        delete (globalThis as Record<string, unknown>).snap;
    });

    it("rejects an unknown network", async () => {
        stubOperators({});
        await expect(getAddress({ network: "litecoin" }, "https://dapp.example")).rejects.toThrow(
            "Invalid network",
        );
    });

    it("needs an operator URL where no operator is built in", async () => {
        stubOperators({});
        await expect(getAddress({ network: "regtest" }, "https://dapp.example")).rejects.toThrow(
            "operatorUrl",
        );
    });

    it("derives the address from the built-in operator's own info", async () => {
        const fetchMock = stubOperators({ "https://arkade.computer": MAINNET_INFO });
        const { dialogs } = installSnap();

        const { address } = await getAddress({ network: "bitcoin" }, "https://dapp.example");

        expect(address).toBe(MAINNET_ADDRESS);
        expect(String(fetchMock.mock.calls[0][0])).toBe("https://arkade.computer/v1/info");
        expect(dialogs).toHaveLength(0);
    });

    it("ignores operator fields the caller passes", async () => {
        stubOperators({ "https://arkade.computer": MAINNET_INFO });
        const { address } = await getAddress(
            { network: "bitcoin", signerPubkey: "ab".repeat(32), unilateralExitDelay: "1" },
            "https://dapp.example",
        );
        expect(address).toBe(MAINNET_ADDRESS);
    });

    it("rejects an operator that reports another network", async () => {
        stubOperators({ "https://arkade.computer": { ...MAINNET_INFO, network: "mutinynet" } });
        await expect(getAddress({ network: "bitcoin" }, "https://dapp.example")).rejects.toThrow(
            "reports network mutinynet",
        );
    });

    it("refuses a plain-http operator URL off loopback", async () => {
        stubOperators({});
        await expect(
            getAddress(
                { network: "regtest", operatorUrl: "http://operator.example" },
                "https://dapp.example",
            ),
        ).rejects.toThrow("https");
    });

    it("asks before using a custom operator, showing its URL and key", async () => {
        stubOperators({ [CUSTOM]: REGTEST_INFO });
        const { dialogs } = installSnap(() => true);

        const { address } = await getAddress(
            { network: "regtest", operatorUrl: `${CUSTOM}/` },
            "https://dapp.example",
        );

        expect(address).toMatch(/^tark1/);
        expect(dialogs).toHaveLength(1);
        const shown = JSON.stringify(dialogs[0]);
        expect(shown).toContain(CUSTOM);
        expect(shown).toContain(MAINNET_INFO.signerPubkey);
        expect(shown).toContain("https://dapp.example");
    });

    it("rejects a custom operator the user declines", async () => {
        stubOperators({ [CUSTOM]: REGTEST_INFO });
        installSnap(() => false);
        await expect(
            getAddress({ network: "regtest", operatorUrl: CUSTOM }, "https://dapp.example"),
        ).rejects.toThrow("rejected");
    });

    it("pins an approved custom operator per origin", async () => {
        stubOperators({ [CUSTOM]: REGTEST_INFO });
        const { dialogs } = installSnap(() => true);
        const params = { network: "regtest", operatorUrl: CUSTOM };

        await getAddress(params, "https://a.example");
        await getAddress(params, "https://a.example");
        expect(dialogs).toHaveLength(1);

        await getAddress(params, "https://b.example");
        expect(dialogs).toHaveLength(2);
    });

    it("asks again when a pinned operator's key changes", async () => {
        const fetchMock = stubOperators({ [CUSTOM]: REGTEST_INFO });
        const { dialogs } = installSnap(() => true);
        const params = { network: "regtest", operatorUrl: CUSTOM };
        await getAddress(params, "https://a.example");

        fetchMock.mockImplementation(
            async () =>
                new Response(JSON.stringify({ ...REGTEST_INFO, signerPubkey: ROTATED_KEY }), {
                    status: 200,
                }),
        );
        await getAddress(params, "https://a.example");

        expect(dialogs).toHaveLength(2);
        expect(JSON.stringify(dialogs[1])).toContain(ROTATED_KEY);
    });

    it("falls back to the last info it fetched when the operator is unreachable", async () => {
        const fetchMock = stubOperators({ "https://arkade.computer": MAINNET_INFO });
        await getAddress({ network: "bitcoin" }, "https://dapp.example");

        fetchMock.mockRejectedValue(new TypeError("fetch failed"));
        const { address } = await getAddress({ network: "bitcoin" }, "https://dapp.example");

        expect(address).toBe(MAINNET_ADDRESS);
    });

    it("fails closed on an operator that reports no signer key", async () => {
        stubOperators({ "https://arkade.computer": { ...MAINNET_INFO, signerPubkey: "" } });
        await expect(getAddress({ network: "bitcoin" }, "https://dapp.example")).rejects.toThrow(
            "signer key",
        );
    });

    it("uses fresh info even when caching it fails", async () => {
        const fetchMock = stubOperators({ "https://arkade.computer": MAINNET_INFO });
        const { control } = installSnap();
        await getAddress({ network: "bitcoin" }, "https://dapp.example");

        fetchMock.mockImplementation(
            async () =>
                new Response(JSON.stringify({ ...MAINNET_INFO, signerPubkey: ROTATED_KEY }), {
                    status: 200,
                }),
        );
        control.failWrites = true;
        const { address } = await getAddress({ network: "bitcoin" }, "https://dapp.example");

        expect(address).toMatch(/^ark1/);
        expect(address).not.toBe(MAINNET_ADDRESS);
    });
});

describe("snap state", () => {
    afterEach(() => {
        delete (globalThis as Record<string, unknown>).snap;
    });

    it("keeps both of two overlapping writes", async () => {
        installSnap();
        await Promise.all([
            updateState((state) => ({ ...state, pubkey: "aa" })),
            updateState((state) => ({ ...state, pins: { "https://a.example": {} } })),
        ]);
        const state = await readState();
        expect(state.pubkey).toBe("aa");
        expect(state.pins).toEqual({ "https://a.example": {} });
    });
});
