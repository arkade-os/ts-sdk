import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { hex } from "@scure/base";
import { DelegateManagerImpl, findDestinationOutputIndex } from "../../src/wallet/delegate";
import type { ArkadeInfo, Identity } from "../../src";
import type { DelegateProvider } from "../../src/providers/delegate";
import {
    TEST_DEFAULT_ARK_ADDRESS,
    TEST_DELEGATE_PUB_KEY,
    TEST_SERVER_PUB_KEY_HEX,
    createMockContractVtxo,
    testDelegateScript,
} from "../contracts/helpers";

describe("default delegation schedule", () => {
    const NOW = Date.UTC(2026, 0, 1);

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(NOW);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /** The `valid_at` signed for a coin expiring at `expiry`, delegated with no explicit date. */
    async function validAt(expiry: number, sessionDuration: bigint): Promise<number> {
        const delegate = vi.fn(async (_intent: { message: { valid_at: number } }) => {});
        const provider = {
            getDelegateInfo: async () => ({
                pubkey: hex.encode(TEST_DELEGATE_PUB_KEY),
                fee: "0",
                delegateAddress: TEST_DEFAULT_ARK_ADDRESS,
            }),
            delegate,
        } as unknown as DelegateProvider;
        const info = {
            dust: 100n,
            fees: { intentFee: {}, txFeeRate: "0" },
            forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
            forfeitPubkey: TEST_SERVER_PUB_KEY_HEX,
            network: "mutinynet",
            sessionDuration,
            signerPubkey: TEST_SERVER_PUB_KEY_HEX,
        } as ArkadeInfo;
        const identity = { sign: async (tx: unknown) => tx } as unknown as Identity;
        const coin = createMockContractVtxo(hex.encode(testDelegateScript.pkScript), {
            value: 1_000_000,
            tapTree: testDelegateScript.encode(),
            forfeitTapLeafScript: testDelegateScript.forfeit(),
            intentTapLeafScript: testDelegateScript.delegate(),
            expiresAt: new Date(expiry),
        });

        const manager = new DelegateManagerImpl(provider, { getInfo: async () => info }, identity);
        const { failed } = await manager.delegate([coin], TEST_DEFAULT_ARK_ADDRESS);

        expect(failed).toEqual([]);
        return delegate.mock.calls[0][0].message.valid_at;
    }

    it("leaves three operator sessions before expiry", async () => {
        const expiry = NOW + 30 * 86_400_000;
        expect(await validAt(expiry, 60n)).toBe(expiry / 1000 - 180);
    });

    it("stays before expiry when already inside that window", async () => {
        expect(await validAt(NOW + 50_000, 30n)).toBe(NOW / 1000 + 2);
    });
});

describe("findDestinationOutputIndex", () => {
    const scriptA = new Uint8Array([0x00, 0x14, 0xaa, 0xbb]);
    const scriptB = new Uint8Array([0x00, 0x14, 0xcc, 0xdd]);
    const scriptC = new Uint8Array([0x00, 0x14, 0xee, 0xff]);

    it("should find the destination output when it is the last output", () => {
        const outputs = [
            { script: scriptA, amount: 1000n },
            { script: scriptB, amount: 5000n },
        ];
        expect(findDestinationOutputIndex(outputs, scriptB)).toBe(1);
    });

    it("should find the destination output when it is the first output", () => {
        const outputs = [
            { script: scriptB, amount: 5000n },
            { script: scriptA, amount: 1000n },
        ];
        expect(findDestinationOutputIndex(outputs, scriptB)).toBe(0);
    });

    it("should find the destination output in the middle", () => {
        const outputs = [
            { script: scriptA, amount: 1000n },
            { script: scriptB, amount: 5000n },
            { script: scriptC, amount: 3000n },
        ];
        expect(findDestinationOutputIndex(outputs, scriptB)).toBe(1);
    });

    it("should return -1 when no output matches", () => {
        const outputs = [
            { script: scriptA, amount: 1000n },
            { script: scriptC, amount: 3000n },
        ];
        expect(findDestinationOutputIndex(outputs, scriptB)).toBe(-1);
    });

    it("should return -1 for empty outputs", () => {
        expect(findDestinationOutputIndex([], scriptA)).toBe(-1);
    });

    it("should skip outputs with undefined script", () => {
        const outputs = [{ amount: 1000n }, { script: scriptA, amount: 5000n }];
        expect(findDestinationOutputIndex(outputs, scriptA)).toBe(1);
    });

    it("should not match outputs with different-length scripts", () => {
        const shortScript = new Uint8Array([0x00, 0x14]);
        const outputs = [{ script: shortScript, amount: 1000n }];
        expect(findDestinationOutputIndex(outputs, scriptA)).toBe(-1);
    });

    it("should return the first match when duplicates exist", () => {
        const outputs = [
            { script: scriptA, amount: 1000n },
            { script: scriptB, amount: 2000n },
            { script: scriptB, amount: 3000n },
        ];
        expect(findDestinationOutputIndex(outputs, scriptB)).toBe(1);
    });
});
