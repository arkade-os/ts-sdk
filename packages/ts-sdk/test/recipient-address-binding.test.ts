import { describe, it, expect, vi, beforeEach } from "vitest";
import { hex } from "@scure/base";
import { Script } from "@scure/btc-signer";
import { Wallet, SingleKey } from "../src";
import { VtxoScript } from "../src/script/base";
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

/**
 * A published taptree is a claim about the output: these, and only these, are
 * the paths that can spend it. Nothing downstream re-derives the address from
 * it — a reader takes the leaves and builds a spend — so a tree that does not
 * belong to the address is a false statement, and it fails wherever it is
 * eventually read rather than where it was attached.
 *
 * The concrete case is a daemon claiming a preimage-gated output on the
 * receiver's behalf: it walks the published tree looking for the closure it
 * can spend, and a tree for some other contract fails that walk with nothing
 * useful to say. Refusing here turns that into an error at the call that
 * caused it.
 */
describe("validateRecipients published taptree", () => {
    // Three ordinary key-path leaves — enough to build real VtxoScripts. Their
    // content is beside the point: what is under test is that the tree and the
    // address agree, not what the tree permits. The keys are real curve points
    // (G, 2G, 3G) because the taproot builder validates every key-path leaf.
    const leafA = Script.encode([hex.decode(SERVER_KEY_HEX).slice(1), "CHECKSIG"]);
    const leafB = Script.encode([
        hex.decode("c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"),
        "CHECKSIG",
    ]);
    const leafC = Script.encode([
        hex.decode("f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"),
        "CHECKSIG",
    ]);
    const script = new VtxoScript([leafA, leafB]);
    const otherContract = new VtxoScript([leafA, leafC]);
    const addressFor = (vs: VtxoScript) =>
        new ArkAddress(SERVER_XONLY, vs.tweakedPublicKey, "tark").encode();

    it("passes a taptree that derives the recipient address through to the output", () => {
        const validated = validateRecipients(
            [{ address: addressFor(script), amount: 2000, tapTree: script.encode() }],
            1000,
            makeContext(),
        );
        expect(validated[0].tapTree).toEqual(script.encode());
    });

    it("rejects a well-formed taptree belonging to a different contract", () => {
        expect(() =>
            validateRecipients(
                [{ address: addressFor(script), amount: 2000, tapTree: otherContract.encode() }],
                1000,
                makeContext(),
            ),
        ).toThrow(/Invalid tapTree/);
    });

    it("rejects bytes that are not a taptree at all", () => {
        expect(() =>
            validateRecipients(
                [
                    {
                        address: addressFor(script),
                        amount: 2000,
                        tapTree: new Uint8Array([0xff, 0xff]),
                    },
                ],
                1000,
                makeContext(),
            ),
        ).toThrow(/Invalid tapTree/);
    });

    it("validates against the address, not the output script, for a sub-dust recipient", () => {
        // Sub-dust pays to the `RETURN` form of the same taproot key, so a
        // check written against the output script would reject this pairing
        // even though the tree describes exactly the right key.
        const encoded = addressFor(script);
        const validated = validateRecipients(
            [{ address: encoded, amount: 100, tapTree: script.encode() }],
            1000,
            makeContext(),
        );
        expect(validated[0].tapTree).toEqual(script.encode());
        expect(validated[0].script).toEqual(ArkAddress.decode(encoded).subdustPkScript);
    });

    it("leaves the taptree undefined when the caller published none", () => {
        const validated = validateRecipients(
            [{ address: addressFor(script), amount: 2000 }],
            1000,
            makeContext(),
        );
        expect(validated[0].tapTree).toBeUndefined();
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
            "039d0440b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac",
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
