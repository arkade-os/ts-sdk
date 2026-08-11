/**
 * `sendBitcoin({ selectedVtxos, extensions })` — the two properties that break
 * silently.
 *
 * Both are ordering/omission bugs rather than logic bugs, which is why they get
 * a test rather than a comment: neither throws, neither shows up in a type, and
 * both produce a transaction that looks well-formed and is not.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { hex } from "@scure/base";
import { Wallet, SingleKey } from "../src";
import { ArkAddress } from "../src/script/address";

const SERVER_KEY_HEX = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const SERVER_XONLY = hex.decode(SERVER_KEY_HEX).slice(1);

const mockIdentity = SingleKey.fromHex(
    "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2",
);

// Lifted verbatim from recipient-address-binding.test.ts: the delays must be
// BIP68-representable (multiples of 512 seconds) or `Wallet.create` refuses,
// which is not a thing worth rediscovering per test file.
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

const VTXO_KEY = new Uint8Array(32).fill(0xaa);

const encodeAddr = (serverPubKey: Uint8Array, hrp: string): string =>
    new ArkAddress(serverPubKey, VTXO_KEY, hrp).encode();

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
    // URL-aware rather than a blanket resolve: the wallet's background VtxoManager
    // queries the indexer during construction, and handing it `arkInfo` makes
    // `Wallet.create` fail with "Invalid vtxos data received" — a failure about
    // this mock rather than about anything under test.
    mockFetch = vi.fn().mockImplementation((input: unknown) => {
        const url = String(input);
        const body = url.includes("/v1/info")
            ? mockArkInfo
            : { vtxos: [], txs: [], page: null, commitmentTxs: {}, chains: [] };
        return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(body),
            text: () => Promise.resolve(""),
        });
    });
    vi.stubGlobal("fetch", mockFetch);
});

describe("sendBitcoin({ selectedVtxos, extensions })", () => {
    /**
     * The asset packet this branch never builds.
     *
     * `_sendImpl` emits `createAssetPacket(...)` alongside any custom packets;
     * this branch builds its own outputs and emits neither. So an asset carried
     * in on a selected VTXO was already being dropped silently — spent, not
     * re-declared, nothing said. Adding `extensions` makes that worse in one
     * specific way: an extension output now exists, so the transaction looks
     * well-formed while still omitting the asset packet that had to be in it.
     *
     * Refusing is the fix. Building the packet here would mean inventing an
     * asset-routing mapping (which assets follow the recipient, which the
     * change) that a BTC-only helper has no basis to decide.
     */
    it("refuses asset-bearing selected VTXOs rather than dropping their assets", async () => {
        const wallet = await Wallet.create({
            identity: mockIdentity,
            arkServerUrl: "http://localhost:7070",
        });

        await expect(
            wallet.sendBitcoin({
                address: encodeAddr(SERVER_XONLY, "tark"),
                amount: 2000,
                selectedVtxos: [
                    { value: 100_000, assets: [{ assetId: "aa".repeat(34), amount: 5n }] },
                ] as never,
                extensions: [{ type: 0x04, payload: new Uint8Array([1, 2, 3]) }],
            }),
        ).rejects.toThrow(/cannot spend asset-bearing VTXOs/);
    });

    it("refuses them with no extensions either — the silent drop predates extensions", async () => {
        const wallet = await Wallet.create({
            identity: mockIdentity,
            arkServerUrl: "http://localhost:7070",
        });

        await expect(
            wallet.sendBitcoin({
                address: encodeAddr(SERVER_XONLY, "tark"),
                amount: 2000,
                selectedVtxos: [
                    { value: 100_000, assets: [{ assetId: "bb".repeat(34), amount: 1n }] },
                ] as never,
            }),
        ).rejects.toThrow(/cannot spend asset-bearing VTXOs/);
    });

    /**
     * `changeVout` indexes the change output as `outputs.length - 1`, so it has
     * to be read BEFORE the extension output is appended. Get the order wrong
     * and it points at the OP_RETURN instead — change metadata silently bound
     * to an unspendable output, with nothing throwing.
     *
     * Asserted against the value handed to `_submitOffchainSpend`, because that
     * is the only place the mistake would surface, and it would surface as a
     * wrong number rather than an error.
     */
    it("keeps changeVout pointing at the change output, not the extension", async () => {
        const wallet = await Wallet.create({
            identity: mockIdentity,
            arkServerUrl: "http://localhost:7070",
        });

        const submitted: Array<{ outputs: unknown[]; changeVout: number }> = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (wallet as any)._submitOffchainSpend = async (
            _inputs: unknown,
            outputs: unknown[],
            meta: { changeVout: number },
        ) => {
            submitted.push({ outputs, changeVout: meta.changeVout });
            return "txid";
        };

        await wallet.sendBitcoin({
            address: encodeAddr(SERVER_XONLY, "tark"),
            amount: 2000,
            // 100_000 in, 2_000 out => change, so outputs are [dest, change, ext]
            selectedVtxos: [{ value: 100_000 }] as never,
            extensions: [{ type: 0x04, payload: new Uint8Array([1, 2, 3, 4]) }],
        });

        expect(submitted).toHaveLength(1);
        const call = submitted[0]!;
        // Three outputs: destination, change, and the extension OP_RETURN.
        expect(call.outputs).toHaveLength(3);
        // The change is index 1. If the extension were appended before this was
        // read, `outputs.length - 1` would have made it 2 — the OP_RETURN.
        expect(call.changeVout).toBe(1);
    });

    it("emits no extension output when none is asked for", async () => {
        const wallet = await Wallet.create({
            identity: mockIdentity,
            arkServerUrl: "http://localhost:7070",
        });

        const submitted: Array<{ outputs: unknown[] }> = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (wallet as any)._submitOffchainSpend = async (_inputs: unknown, outputs: unknown[]) => {
            submitted.push({ outputs });
            return "txid";
        };

        await wallet.sendBitcoin({
            address: encodeAddr(SERVER_XONLY, "tark"),
            amount: 2000,
            selectedVtxos: [{ value: 100_000 }] as never,
        });

        // Destination and change only — an empty or absent `extensions` must not
        // add a stray OP_RETURN.
        expect(submitted[0]!.outputs).toHaveLength(2);
    });
});
