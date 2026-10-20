import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { VtxoManager } from "../src/wallet/vtxo-manager";
import { VtxoReservedError } from "../src/wallet/wallet";
import { isSdkPicked } from "../src/wallet/utils";
import { CSVMultisigTapscript } from "../src/script/tapscript";

const ARK_ADDR =
    "tark1qpt0syx7j0jspe69kldtljet0x9jz6ns4xw70m0w0xl30yfhn0mzmxz6yz8rduexx9sv73mqth7ecy8rtzcgm498kad3avmhyhmy097ew6h83g";
const flush = async () => {
    for (let i = 0; i < 48; i++) await Promise.resolve();
};
const reserved = () => new VtxoReservedError([`${"aa".repeat(32)}:0`], "in-flight");

describe("VtxoManager and a concurrent spend", () => {
    it("skips a renewal whose coins another operation holds, without logging an error", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const now = Date.now();
        const vtxo = {
            txid: "aa".repeat(32),
            vout: 0,
            value: 5_000,
            createdAt: new Date(now - 100_000),
            status: { confirmed: true },
            isUnrolled: false,
            isSpent: false,
            isSwept: false,
            isPreconfirmed: false,
            spentBy: "",
            commitmentTxIds: [],
            expiresAt: new Date(now + 5_000),
            forfeitTapLeafScript: [new Uint8Array(), new Uint8Array()],
            intentTapLeafScript: [new Uint8Array(), new Uint8Array()],
            tapTree: new Uint8Array(),
        };
        let onEvent: ((event: unknown) => void) | undefined;
        const wallet = {
            getVtxos: vi.fn().mockResolvedValue([vtxo]),
            getSpendableVtxos: vi.fn().mockResolvedValue([vtxo]),
            getAddress: vi.fn().mockResolvedValue(ARK_ADDR),
            getDelegateManager: vi.fn().mockResolvedValue(undefined),
            getContractManager: vi.fn().mockResolvedValue({
                onContractEvent: vi.fn((handler) => {
                    onEvent = handler;
                    return () => {};
                }),
                refreshOutpoints: vi.fn().mockResolvedValue(undefined),
            }),
            settle: vi.fn().mockRejectedValue(reserved()),
            dustAmount: 1000n,
            arkProvider: {
                getInfo: vi.fn().mockResolvedValue({ fees: { intentFee: {} }, vtxoMaxAmount: -1n }),
            },
        } as any;

        const manager = new VtxoManager(wallet, {});
        await flush();
        onEvent!({ type: "vtxo_received", vtxos: [], contract: {} });
        await flush();

        expect(wallet.settle).toHaveBeenCalledTimes(1);
        expect(isSdkPicked(wallet.settle.mock.calls[0][0])).toBe(true);
        expect(error).not.toHaveBeenCalledWith("Error renewing VTXOs:", expect.anything());
        await manager.dispose();
        error.mockRestore();
    });

    it("skips a periodic settle that lost an input, without counting a failure", async () => {
        const exitScript = hex.encode(
            CSVMultisigTapscript.encode({
                timelock: { type: "seconds", value: 604672n },
                pubkeys: [new Uint8Array(32).fill(1)],
            }).script,
        );
        const utxo = {
            txid: "boarding-txid-10000-0",
            vout: 0,
            value: 10_000,
            status: { confirmed: true, block_time: Math.floor(Date.now() / 1000) - 60 },
        } as any;
        const wallet = {
            getVtxos: vi.fn().mockResolvedValue([]),
            getSpendableVtxos: vi.fn().mockResolvedValue([]),
            getAddress: vi.fn().mockResolvedValue(ARK_ADDR),
            getDelegateManager: vi.fn().mockResolvedValue(undefined),
            getDelegatorManager: vi.fn().mockResolvedValue(undefined),
            getContractManager: vi.fn().mockResolvedValue({
                onContractEvent: vi.fn().mockReturnValue(() => {}),
                refreshOutpoints: vi.fn().mockResolvedValue(undefined),
            }),
            settle: vi.fn().mockRejectedValue(reserved()),
            dustAmount: 330n,
            getBoardingUtxos: vi.fn().mockResolvedValue([utxo]),
            getBoardingAddress: vi.fn().mockResolvedValue("bcrt1qtest"),
            boardingTapscript: {
                exitScript,
                pkScript: new Uint8Array([0x51, 0x20, ...new Array(32).fill(0)]),
            },
            onchainProvider: {
                getFeeRate: vi.fn().mockResolvedValue(1),
                getChainTip: vi.fn().mockResolvedValue({
                    height: 1000,
                    time: Math.floor(Date.now() / 1000),
                    hash: "0".repeat(64),
                }),
            },
            arkProvider: { getInfo: vi.fn().mockResolvedValue({ fees: { intentFee: {} } }) },
            network: { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef },
            identity: {
                sign: vi.fn().mockImplementation((tx: unknown) => tx),
                xOnlyPublicKey: vi.fn().mockResolvedValue(new Uint8Array(32)),
            },
            signOnchainBoardingTx: vi.fn().mockImplementation((tx: unknown) => tx),
        } as any;
        const manager = new VtxoManager(wallet, {
            boardingUtxoSweep: false,
            pollIntervalMs: 60_000,
        });
        manager.dispose();

        await expect((manager as any).runPeriodicSettle([utxo])).resolves.toBeUndefined();
        expect(wallet.settle).toHaveBeenCalledTimes(1);
        expect(isSdkPicked(wallet.settle.mock.calls[0][0])).toBe(true);
        expect((manager as any).consecutivePeriodicSettleFailures).toBe(0);
    });
});

describe("VtxoManager and a held VTXO due for renewal", () => {
    const heldVtxo = (fill: string, expiresInMs: number) => ({
        txid: fill.repeat(32),
        vout: 0,
        value: 5_000,
        createdAt: new Date(),
        status: { confirmed: true },
        isUnrolled: false,
        isSpent: false,
        isSwept: false,
        isPreconfirmed: false,
        spentBy: "",
        commitmentTxIds: [],
        expiresAt: new Date(Date.now() + expiresInMs),
    });

    it("skips it, and warns once per hold that it will not be renewed", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const due = heldVtxo("aa", 5_000);
        const later = heldVtxo("bb", 30 * 24 * 3_600_000);
        const wallet = {
            getSpendableVtxos: vi.fn().mockResolvedValue([]),
            getHeldVtxos: vi.fn().mockResolvedValue([due, later]),
            dustAmount: 1000n,
        } as any;
        const manager = new VtxoManager(wallet, false);
        manager.dispose();

        expect(await manager.getExpiringVtxos(3_600_000)).toEqual([]);
        expect(await manager.getExpiringVtxos(3_600_000)).toEqual([]);
        const held = warn.mock.calls.filter(([m]) => String(m).includes("held by reserveVtxos"));
        expect(held).toHaveLength(1);
        expect(held[0]![0]).toContain(`${due.txid}:0`);
        expect(held[0]![0]).not.toContain(later.txid);

        // Released, then held again: a fresh hold is reported again.
        wallet.getHeldVtxos.mockResolvedValueOnce([]);
        await manager.getExpiringVtxos(3_600_000);
        await manager.getExpiringVtxos(3_600_000);
        expect(
            warn.mock.calls.filter(([m]) => String(m).includes("held by reserveVtxos")),
        ).toHaveLength(2);
    });

    it("still answers when the held read fails", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const vtxo = heldVtxo("cc", 5_000);
        const wallet = {
            getSpendableVtxos: vi.fn().mockResolvedValue([vtxo]),
            getHeldVtxos: vi.fn().mockRejectedValue(new Error("store offline")),
            dustAmount: 1000n,
        } as any;
        const manager = new VtxoManager(wallet, false);
        manager.dispose();

        expect(await manager.getExpiringVtxos(3_600_000)).toEqual([vtxo]);
    });
});
