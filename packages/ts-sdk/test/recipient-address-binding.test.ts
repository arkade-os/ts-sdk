import { describe, it, expect, vi, beforeEach } from "vitest";
import { hex } from "@scure/base";
import { Script } from "@scure/btc-signer";
import { Wallet, SingleKey, type Recipient } from "../src";
import { VtxoScript } from "../src/script/base";
import { ArkAddress } from "../src/script/address";
import {
    assertRecipientArkadeAddress,
    validateRecipients,
    type RecipientArkadeAddressContext,
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

function makeContext(deprecated?: Map<string, bigint>): RecipientArkadeAddressContext {
    return {
        hrp: "tark",
        signerSet: {
            active: hex.encode(SERVER_XONLY),
            deprecated: deprecated ?? new Map(),
        },
    };
}

describe("assertRecipientArkadeAddress", () => {
    it("rejects an address with another network's prefix", () => {
        const encoded = encodeAddr(SERVER_XONLY, "ark");
        expect(() =>
            assertRecipientArkadeAddress(encoded, ArkAddress.decode(encoded), makeContext()),
        ).toThrow(/expected prefix "tark", got "ark"/);
    });

    it("rejects an address embedding an unknown operator signer key", () => {
        const encoded = encodeAddr(FOREIGN_XONLY, "tark");
        expect(() =>
            assertRecipientArkadeAddress(encoded, ArkAddress.decode(encoded), makeContext()),
        ).toThrow(/unknown operator signer key/);
    });

    it("accepts an address embedding the current signer key", () => {
        const encoded = encodeAddr(SERVER_XONLY, "tark");
        expect(() =>
            assertRecipientArkadeAddress(encoded, ArkAddress.decode(encoded), makeContext()),
        ).not.toThrow();
    });

    it("accepts a deprecated signer key before its cutoff", () => {
        const encoded = encodeAddr(DEPRECATED_XONLY, "tark");
        const deprecated = new Map([[hex.encode(DEPRECATED_XONLY), BigInt(NOW_SECONDS + 100_000)]]);
        expect(() =>
            assertRecipientArkadeAddress(
                encoded,
                ArkAddress.decode(encoded),
                makeContext(deprecated),
            ),
        ).not.toThrow();
    });

    it("accepts a deprecated signer key with no advertised cutoff", () => {
        const encoded = encodeAddr(DEPRECATED_XONLY, "tark");
        const deprecated = new Map([[hex.encode(DEPRECATED_XONLY), 0n]]);
        expect(() =>
            assertRecipientArkadeAddress(
                encoded,
                ArkAddress.decode(encoded),
                makeContext(deprecated),
            ),
        ).not.toThrow();
    });

    it("rejects a deprecated signer key past its cutoff", () => {
        const encoded = encodeAddr(DEPRECATED_XONLY, "tark");
        const deprecated = new Map([[hex.encode(DEPRECATED_XONLY), 1n]]);
        expect(() =>
            assertRecipientArkadeAddress(
                encoded,
                ArkAddress.decode(encoded),
                makeContext(deprecated),
            ),
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
 * The concrete case: a daemon claiming a preimage-gated output on the receiver's
 * behalf walks the published tree for the closure it can spend, and a tree for
 * some other contract fails that walk with nothing useful to say. Checking here
 * turns that into an error at the call that caused it.
 */
describe("validateRecipients published taptree", () => {
    // Three ordinary key-path leaves, enough to build real VtxoScripts. Real curve
    // points (G, 2G, 3G) because the taproot builder validates every key-path leaf.
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

    it("points a rejected taptree at the encoding it needed", () => {
        // The check ignores leaf depths and rebuilds the tree in arkd's shape, so a
        // valid tree from another encoder is refused — the message has to name that.
        expect(() =>
            validateRecipients(
                [{ address: addressFor(script), amount: 2000, tapTree: otherContract.encode() }],
                1000,
                makeContext(),
            ),
        ).toThrow(/Expected VtxoScript\.encode\(\) form/);
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

    it("send with selected vtxos rejects a foreign-operator address", async () => {
        const wallet = await Wallet.create({
            identity: mockIdentity,
            arkServerUrl: "http://localhost:7070",
        });

        await expect(
            wallet.send({
                recipients: [{ address: encodeAddr(FOREIGN_XONLY, "tark"), amount: 2000 }],
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
            wallet as unknown as { recipientAddressContext(): RecipientArkadeAddressContext }
        ).recipientAddressContext();
        expect(context.signerSet.deprecated.get(hex.encode(DEPRECATED_XONLY))).toBe(cutoff);

        const encoded = encodeAddr(DEPRECATED_XONLY, "tark");
        expect(() =>
            assertRecipientArkadeAddress(encoded, ArkAddress.decode(encoded), context),
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

/**
 * Every way the named set can fail to cover the outputs has to be an error rather
 * than a top-up. These all land before any network call — the selected path never
 * reads the wallet's own outputs — so a wallet with only its info mocked reaches
 * them.
 */
describe("send with caller-selected vtxos", () => {
    const ASSET_A = "a".repeat(64);
    const ASSET_B = "b".repeat(64);
    const ADDR = encodeAddr(SERVER_XONLY, "tark");

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

    // Only `value` and `assets` are read before the errors under test fire.
    const coin = (value: number, assets?: { assetId: string; amount: bigint }[]) =>
        ({ value, ...(assets ? { assets } : {}) }) as never;

    const makeWallet = () =>
        Wallet.create({ identity: mockIdentity, arkServerUrl: "http://localhost:7070" });

    beforeEach(() => {
        mockFetch.mockReset();
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(mockArkInfo),
        });
    });

    it("rejects an empty selection instead of choosing for the caller", async () => {
        const wallet = await makeWallet();
        await expect(
            wallet.send({ recipients: [{ address: ADDR, amount: 2000 }], selectedVtxos: [] }),
        ).rejects.toThrow(/send\(\{ selectedVtxos \}\): no inputs/);
    });

    it("errors on a bitcoin shortfall rather than topping up from the wallet", async () => {
        const wallet = await makeWallet();
        await expect(
            wallet.send({
                recipients: [{ address: ADDR, amount: 500 }],
                selectedVtxos: [coin(300)],
            }),
        ).rejects.toThrow(/inputs total 300 sats, outputs need 500/);
    });

    it("errors on an asset shortfall, naming the asset and the gap", async () => {
        const wallet = await makeWallet();
        await expect(
            wallet.send({
                recipients: [
                    { address: ADDR, amount: 2000, assets: [{ assetId: ASSET_A, amount: 200n }] },
                ],
                selectedVtxos: [coin(5000, [{ assetId: ASSET_A, amount: 100n }])],
            }),
        ).rejects.toThrow(new RegExp(`inputs are short 100 of asset ${ASSET_A}`));
    });

    it("pools an asset across every named input before calling it short", async () => {
        // Two coins of 100 against a demand of 250. The gap of 50 is only
        // reachable by summing both — one coin alone would report 150.
        const wallet = await makeWallet();
        await expect(
            wallet.send({
                recipients: [
                    { address: ADDR, amount: 2000, assets: [{ assetId: ASSET_A, amount: 250n }] },
                ],
                selectedVtxos: [
                    coin(5000, [{ assetId: ASSET_A, amount: 100n }]),
                    coin(5000, [{ assetId: ASSET_A, amount: 100n }]),
                ],
            }),
        ).rejects.toThrow(/inputs are short 50 of asset/);
    });

    it("reports no shortfall when the pooled inputs cover the demand", async () => {
        const wallet = await makeWallet();
        const err = await wallet
            .send({
                recipients: [
                    { address: ADDR, amount: 2000, assets: [{ assetId: ASSET_A, amount: 150n }] },
                ],
                selectedVtxos: [
                    coin(5000, [{ assetId: ASSET_A, amount: 100n }]),
                    coin(5000, [{ assetId: ASSET_A, amount: 100n }]),
                ],
            })
            .catch((e: unknown) => e);
        // It fails later, at the submit this mock cannot serve. What matters is
        // that it got past the accounting rather than being turned away there.
        expect(String(err)).not.toMatch(/inputs are short/);
    });

    it("draws each recipient in turn off the pooled amount", async () => {
        // 100 in, two recipients wanting 60 each. Only a running subtraction
        // sees the second one overdraw.
        const wallet = await makeWallet();
        await expect(
            wallet.send({
                recipients: [
                    { address: ADDR, amount: 2000, assets: [{ assetId: ASSET_A, amount: 60n }] },
                    { address: ADDR, amount: 2000, assets: [{ assetId: ASSET_A, amount: 60n }] },
                ],
                selectedVtxos: [coin(9000, [{ assetId: ASSET_A, amount: 100n }])],
            }),
        ).rejects.toThrow(/inputs are short 20 of asset/);
    });

    it("re-declares an asset the caller's coins carried in but no recipient asked for", async () => {
        // Asset B rides in on the named coin and is spoken for by nobody, so it
        // has to leave as change — which is what makes the dust floor bite.
        const wallet = await makeWallet();
        await expect(
            wallet.send({
                recipients: [{ address: ADDR, amount: 2000 }],
                selectedVtxos: [coin(2000, [{ assetId: ASSET_B, amount: 100n }])],
            }),
        ).rejects.toThrow(/0 sats of change cannot carry 1 asset change\(s\), needs 1000/);
    });

    it("refuses when the change left over cannot carry the asset change at dust", async () => {
        const wallet = await makeWallet();
        await expect(
            wallet.send({
                recipients: [
                    { address: ADDR, amount: 2000, assets: [{ assetId: ASSET_A, amount: 40n }] },
                ],
                selectedVtxos: [coin(2000, [{ assetId: ASSET_A, amount: 100n }])],
            }),
        ).rejects.toThrow(/cannot carry 1 asset change\(s\), needs 1000/);
    });
});

/**
 * The two call forms are told apart by the presence of `recipients`, not by
 * argument count — a single recipient produces one argument either way.
 */
describe("send argument dispatch", () => {
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

    const makeWallet = () =>
        Wallet.create({ identity: mockIdentity, arkServerUrl: "http://localhost:7070" });

    beforeEach(() => {
        mockFetch.mockReset();
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(mockArkInfo),
        });
    });

    it("reads a lone recipient object as a recipient, not as params", async () => {
        // Reaching the address check at all means it was validated as a
        // recipient; read as params it would have found no `recipients`.
        const wallet = await makeWallet();
        await expect(
            wallet.send({ address: encodeAddr(SERVER_XONLY, "ark"), amount: 2000 }),
        ).rejects.toThrow(/expected prefix "tark", got "ark"/);
    });

    it("reads an object carrying recipients as params", async () => {
        const wallet = await makeWallet();
        await expect(
            wallet.send({
                recipients: [{ address: encodeAddr(SERVER_XONLY, "ark"), amount: 2000 }],
            }),
        ).rejects.toThrow(/expected prefix "tark", got "ark"/);
    });

    it("rejects params carrying an empty recipient list", async () => {
        const wallet = await makeWallet();
        await expect(
            wallet.send({ recipients: [] } as unknown as { recipients: [Recipient] }),
        ).rejects.toThrow(/At least one receiver is required/);
    });

    it("rejects a call with no arguments at all", async () => {
        // Unreachable from TypeScript, which types the variadic form as
        // non-empty — but this ships as JavaScript, where `send()` is just a
        // call. It lands on the guard in `_sendImpl`, not in `asSendParams`.
        const wallet = await makeWallet();
        await expect((wallet as unknown as { send(): Promise<string> }).send()).rejects.toThrow(
            /At least one receiver is required/,
        );
    });
});
