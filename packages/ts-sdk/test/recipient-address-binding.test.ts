import { describe, it, expect, vi, beforeEach } from "vitest";
import { hex } from "@scure/base";
import { Wallet, SingleKey } from "../src";
import { ArkAddress } from "../src/script/address";
import {
    assertRecipientArkAddress,
    validateRecipients,
    type RecipientAddressContext,
} from "../src/wallet/utils";

// Mock fetch
const { mockFetch } = vi.hoisted(() => ({
    mockFetch: vi.fn(),
}));

vi.mock("../src/utils/fetch", () => ({
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

const SERVER_KEY_HEX = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const SERVER_XONLY = hex.decode(SERVER_KEY_HEX).slice(1);
const DEPRECATED_XONLY = new Uint8Array(32).fill(0x88);
const FOREIGN_XONLY = new Uint8Array(32).fill(0x77);
const VTXO_KEY = new Uint8Array(32).fill(0xaa);

const encodeAddr = (serverPubKey: Uint8Array, hrp: string) =>
    new ArkAddress(serverPubKey, VTXO_KEY, hrp).encode();

const NOW_SECONDS = Math.floor(Date.now() / 1000);

function makeContext(deprecated?: Map<string, bigint>): RecipientAddressContext {
    return {
        hrp: "tark",
        signerSet: {
            active: hex.encode(SERVER_XONLY),
            deprecated: deprecated ?? new Map(),
        },
    };
}

describe("assertRecipientArkAddress", () => {
    it("rejects an address with another network's prefix", () => {
        const encoded = encodeAddr(SERVER_XONLY, "ark");
        expect(() =>
            assertRecipientArkAddress(encoded, ArkAddress.decode(encoded), makeContext()),
        ).toThrow(/expected prefix "tark", got "ark"/);
    });

    it("rejects an address embedding an unknown operator signer key", () => {
        const encoded = encodeAddr(FOREIGN_XONLY, "tark");
        expect(() =>
            assertRecipientArkAddress(encoded, ArkAddress.decode(encoded), makeContext()),
        ).toThrow(/unknown operator signer key/);
    });

    it("accepts an address embedding the current signer key", () => {
        const encoded = encodeAddr(SERVER_XONLY, "tark");
        expect(() =>
            assertRecipientArkAddress(encoded, ArkAddress.decode(encoded), makeContext()),
        ).not.toThrow();
    });

    it("accepts a deprecated signer key before its cutoff", () => {
        const encoded = encodeAddr(DEPRECATED_XONLY, "tark");
        const deprecated = new Map([[hex.encode(DEPRECATED_XONLY), BigInt(NOW_SECONDS + 100_000)]]);
        expect(() =>
            assertRecipientArkAddress(encoded, ArkAddress.decode(encoded), makeContext(deprecated)),
        ).not.toThrow();
    });

    it("accepts a deprecated signer key with no advertised cutoff", () => {
        const encoded = encodeAddr(DEPRECATED_XONLY, "tark");
        const deprecated = new Map([[hex.encode(DEPRECATED_XONLY), 0n]]);
        expect(() =>
            assertRecipientArkAddress(encoded, ArkAddress.decode(encoded), makeContext(deprecated)),
        ).not.toThrow();
    });

    it("rejects a deprecated signer key past its cutoff", () => {
        const encoded = encodeAddr(DEPRECATED_XONLY, "tark");
        const deprecated = new Map([[hex.encode(DEPRECATED_XONLY), 1n]]);
        expect(() =>
            assertRecipientArkAddress(encoded, ArkAddress.decode(encoded), makeContext(deprecated)),
        ).toThrow(/past its rotation cutoff/);
    });
});

describe("validateRecipients address binding", () => {
    it("rejects a recipient list containing a foreign-operator address", () => {
        expect(() =>
            validateRecipients(
                [{ address: encodeAddr(FOREIGN_XONLY, "tark"), amount: 2000 }],
                1000,
                makeContext(),
            ),
        ).toThrow(/unknown operator signer key/);
    });

    it("accepts a recipient list bound to the wallet's operator", () => {
        const validated = validateRecipients(
            [{ address: encodeAddr(SERVER_XONLY, "tark"), amount: 2000 }],
            1000,
            makeContext(),
        );
        expect(validated).toHaveLength(1);
    });
});

describe("Wallet recipient address binding", () => {
    const mockIdentity = SingleKey.fromHex(
        "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2",
    );

    const mockArkInfo = {
        signerPubkey: SERVER_KEY_HEX,
        forfeitPubkey: SERVER_KEY_HEX,
        batchExpiry: BigInt(144),
        unilateralExitDelay: BigInt(144),
        boardingExitDelay: BigInt(144),
        roundInterval: BigInt(144),
        network: "mutinynet",
        dust: BigInt(1000),
        forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
        checkpointTapscript:
            "5ab27520e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
    };

    beforeEach(() => {
        mockFetch.mockReset();
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(mockArkInfo),
        });
    });

    it("send rejects an address from another network before spending", async () => {
        const wallet = await Wallet.create({
            identity: mockIdentity,
            arkServerUrl: "http://localhost:7070",
        });
        const fetchCallsAfterCreate = mockFetch.mock.calls.length;

        await expect(
            wallet.send({ address: encodeAddr(SERVER_XONLY, "ark"), amount: 2000 }),
        ).rejects.toThrow(/expected prefix "tark", got "ark"/);
        expect(mockFetch.mock.calls.length).toBe(fetchCallsAfterCreate);
    });

    it("sendBitcoin with selected vtxos rejects a foreign-operator address", async () => {
        const wallet = await Wallet.create({
            identity: mockIdentity,
            arkServerUrl: "http://localhost:7070",
        });

        await expect(
            wallet.sendBitcoin({
                address: encodeAddr(FOREIGN_XONLY, "tark"),
                amount: 2000,
                selectedVtxos: [{ value: 100_000 } as never],
            }),
        ).rejects.toThrow(/unknown operator signer key/);
    });

    it("carries cached deprecated signers, cutoffs included, into the recipient context", async () => {
        const cutoff = BigInt(NOW_SECONDS + 100_000);
        mockFetch.mockReset();
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () =>
                Promise.resolve({
                    ...mockArkInfo,
                    deprecatedSigners: [
                        { pubkey: hex.encode(DEPRECATED_XONLY), cutoffDate: cutoff.toString() },
                    ],
                }),
        });

        const wallet = await Wallet.create({
            identity: mockIdentity,
            arkServerUrl: "http://localhost:7070",
        });

        const context = (
            wallet as unknown as { recipientAddressContext(): RecipientAddressContext }
        ).recipientAddressContext();
        expect(context.signerSet.deprecated.get(hex.encode(DEPRECATED_XONLY))).toBe(cutoff);

        const encoded = encodeAddr(DEPRECATED_XONLY, "tark");
        expect(() =>
            assertRecipientArkAddress(encoded, ArkAddress.decode(encoded), context),
        ).not.toThrow();
    });

    it("settle rejects a foreign offchain output with the binding error", async () => {
        const wallet = await Wallet.create({
            identity: mockIdentity,
            arkServerUrl: "http://localhost:7070",
        });

        await expect(
            wallet.settle({
                inputs: [],
                outputs: [{ address: encodeAddr(SERVER_XONLY, "ark"), amount: 2000n }],
            }),
        ).rejects.toThrow(/expected prefix "tark", got "ark"/);
    });
});
