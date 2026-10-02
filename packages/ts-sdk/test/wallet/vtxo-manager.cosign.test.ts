import { hex } from "@scure/base";
import { p2tr } from "@scure/btc-signer";
import { pubSchnorr } from "@scure/btc-signer/utils.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnchainCosignPreflightError } from "../../src/contracts/onchainSpend";
import {
    OnchainCosignAmbiguousError,
    OnchainCosignRejectedError,
    OnchainCosignUnsupportedError,
} from "../../src/providers/ark";
import { Transaction } from "../../src/utils/transaction";
import { VtxoScript } from "../../src/script/base";
import { CSVMultisigTapscript } from "../../src/script/tapscript";
import type { ExtendedCoin } from "../../src/wallet";
import { SingleKey } from "../../src/identity/singleKey";
import { getNetwork } from "../../src/networks";
import { VtxoManager } from "../../src/wallet/vtxo-manager";

const identity = SingleKey.fromHex("aa".repeat(32));
const exitScript = CSVMultisigTapscript.encode({
    timelock: { type: "blocks", value: 10n },
    pubkeys: [pubSchnorr(hex.decode("aa".repeat(32)))],
});

const BOARDING = p2tr(new Uint8Array(32).fill(0x02), undefined, getNetwork("regtest")).address!;

const expiredCoin = {
    txid: "ab".repeat(32),
    vout: 0,
    value: 50_000,
    tapTree: new VtxoScript([exitScript.script]).encode(),
    status: { confirmed: true, block_time: 1000, block_height: 100 },
} as ExtendedCoin;

const SWEEP_INPUTS = [{ txid: "cd".repeat(32), vout: 1 }];

function makeWallet(opts: {
    sendOnchain?: unknown;
    utxos?: ExtendedCoin[][];
    inputs?: { txid: string; vout: number }[];
}) {
    const utxoCalls = [...(opts.utxos ?? [[expiredCoin]])];
    const contractManager = {
        onContractEvent: vi.fn().mockReturnValue(() => {}),
        refreshOutpoints: vi.fn().mockResolvedValue(undefined),
    };
    return {
        getVtxos: vi.fn().mockResolvedValue([]),
        getSpendableVtxos: vi.fn().mockResolvedValue([]),
        getAddress: vi.fn().mockResolvedValue("tark1x"),
        getDelegateManager: vi.fn().mockResolvedValue(undefined),
        getDelegatorManager: vi.fn().mockResolvedValue(undefined),
        getContractManager: vi.fn().mockResolvedValue(contractManager),
        settle: vi.fn(),
        dustAmount: 330n,
        getBoardingUtxos: vi
            .fn()
            .mockImplementation(async () =>
                utxoCalls.length > 1 ? utxoCalls.shift() : utxoCalls[0],
            ),
        getBoardingAddress: vi.fn().mockResolvedValue(BOARDING),
        boardingTapscript: {
            exitScript: hex.encode(exitScript.script),
            pkScript: new Uint8Array([0x51, 0x20, ...new Array(32).fill(0)]),
            exit: vi.fn().mockReturnValue([
                {
                    version: 0xc0,
                    internalKey: new Uint8Array(32),
                    merklePath: [new Uint8Array(32)],
                },
                new Uint8Array([0xc0, 0x01, 0x02, 0x03]),
            ]),
        },
        onchainProvider: {
            getFeeRate: vi.fn().mockResolvedValue(1),
            broadcastTransaction: vi.fn().mockResolvedValue("csv-txid"),
            getChainTip: vi.fn().mockResolvedValue({ height: 200, time: 0, hash: "0".repeat(64) }),
        },
        arkProvider: { getInfo: vi.fn().mockResolvedValue({ fees: { intentFee: {} } }) },
        network: { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef },
        identity: {
            sign: vi.fn().mockImplementation((tx: unknown) => tx),
            xOnlyPublicKey: vi.fn().mockResolvedValue(new Uint8Array(32)),
        },
        signOnchainBoardingTx: vi.fn().mockImplementation((tx: Transaction) => identity.sign(tx)),
        getOnchainSweepInputs: vi.fn().mockResolvedValue(opts.inputs ?? SWEEP_INPUTS),
        ...(opts.sendOnchain ? { sendOnchain: opts.sendOnchain } : {}),
    } as any;
}

const manager = (wallet: unknown) =>
    new VtxoManager(wallet as any, undefined, { boardingUtxoSweep: true });

afterEach(() => vi.restoreAllMocks());

describe("VtxoManager cosign-first sweeps", () => {
    it("returns the cosign txid and builds no CSV tx", async () => {
        const sendOnchain = vi.fn().mockResolvedValue("cosign-txid");
        const wallet = makeWallet({ sendOnchain });
        await expect(manager(wallet).sweepOnchainCoins()).resolves.toBe("cosign-txid");
        expect(sendOnchain).toHaveBeenCalledWith({
            outputs: [],
            inputs: SWEEP_INPUTS,
            sweepTo: BOARDING,
        });
        expect(wallet.signOnchainBoardingTx).not.toHaveBeenCalled();
    });

    it("falls back to the CSV path on Unsupported, quietly", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const wallet = makeWallet({
            sendOnchain: vi.fn().mockRejectedValue(new OnchainCosignUnsupportedError()),
        });
        const m = manager(wallet);
        await expect(m.sweepOnchainCoins()).resolves.toBeUndefined();
        await expect(m.sweepExpiredBoardingUtxos()).resolves.toBe("csv-txid");
        expect(wallet.signOnchainBoardingTx).toHaveBeenCalledTimes(1);
        expect(warn).not.toHaveBeenCalled();
    });

    it("falls back on Rejected and warns", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const wallet = makeWallet({
            sendOnchain: vi
                .fn()
                .mockRejectedValue(new OnchainCosignRejectedError("nope", "INVALID_ARK_PSBT")),
        });
        const m = manager(wallet);
        await expect(m.sweepOnchainCoins()).resolves.toBeUndefined();
        await expect(m.sweepExpiredBoardingUtxos()).resolves.toBe("csv-txid");
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("falls back on Preflight, quietly", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const wallet = makeWallet({
            sendOnchain: vi
                .fn()
                .mockRejectedValue(new OnchainCosignPreflightError("nothing to sweep")),
        });
        const m = manager(wallet);
        await expect(m.sweepOnchainCoins()).resolves.toBeUndefined();
        await expect(m.sweepExpiredBoardingUtxos()).resolves.toBe("csv-txid");
        expect(warn).not.toHaveBeenCalled();
    });

    it("rethrows an ambiguous outcome instead of building a CSV tx", async () => {
        const wallet = makeWallet({
            sendOnchain: vi.fn().mockRejectedValue(new OnchainCosignAmbiguousError("500")),
        });
        await expect(manager(wallet).sweepOnchainCoins()).rejects.toBeInstanceOf(
            OnchainCosignAmbiguousError,
        );
        expect(wallet.signOnchainBoardingTx).not.toHaveBeenCalled();
    });

    it("rethrows any other error", async () => {
        const wallet = makeWallet({ sendOnchain: vi.fn().mockRejectedValue(new Error("boom")) });
        await expect(manager(wallet).sweepOnchainCoins()).rejects.toThrow("boom");
    });

    it("does not call sendOnchain when no coin needs a sweep", async () => {
        const sendOnchain = vi.fn();
        const wallet = makeWallet({ sendOnchain, inputs: [] });
        await expect(manager(wallet).sweepOnchainCoins()).resolves.toBeUndefined();
        expect(sendOnchain).not.toHaveBeenCalled();
    });

    it("poll tick: a non-cosign error is logged without raising the poll backoff", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const wallet = makeWallet({ sendOnchain: vi.fn().mockRejectedValue(new Error("boom")) });
        const m = manager(wallet);
        vi.spyOn(m as any, "runPeriodicSettle").mockResolvedValue(undefined);
        await (m as any).pollBoardingUtxos();
        expect((m as any).consecutivePollFailures).toBe(0);
        expect(wallet.onchainProvider.broadcastTransaction).toHaveBeenCalledTimes(1);
    });

    it("returns undefined without a cosign attempt when the wallet has no sendOnchain", async () => {
        await expect(manager(makeWallet({})).sweepOnchainCoins()).resolves.toBeUndefined();
    });

    it("poll tick: a cosign sweep keeps the expired sweep from building a CSV tx", async () => {
        const sendOnchain = vi.fn().mockResolvedValue("cosign-txid");
        const wallet = makeWallet({ sendOnchain, utxos: [[expiredCoin], []] });
        const m = manager(wallet);
        vi.spyOn(m as any, "runPeriodicSettle").mockResolvedValue(undefined);
        await (m as any).pollBoardingUtxos();
        expect(sendOnchain).toHaveBeenCalledTimes(1);
        expect(wallet.signOnchainBoardingTx).not.toHaveBeenCalled();
        expect(wallet.onchainProvider.broadcastTransaction).not.toHaveBeenCalled();
    });

    it("poll tick: falls through to the CSV sweep when cosign is unsupported", async () => {
        const wallet = makeWallet({
            sendOnchain: vi.fn().mockRejectedValue(new OnchainCosignUnsupportedError()),
        });
        const m = manager(wallet);
        vi.spyOn(m as any, "runPeriodicSettle").mockResolvedValue(undefined);
        await (m as any).pollBoardingUtxos();
        expect(wallet.onchainProvider.broadcastTransaction).toHaveBeenCalledTimes(1);
    });
});
