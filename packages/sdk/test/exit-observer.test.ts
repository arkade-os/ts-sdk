import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { p2tr } from "@scure/btc-signer";
import { describe, expect, it, vi } from "vitest";
import { SingleKey } from "../src/identity/singleKey";
import { getNetwork } from "../src/networks";
import { DefaultVtxo } from "../src/script/default";
import type { ExtendedVirtualCoin } from "../src/wallet";
import {
    exitObserverFor,
    notifyExitObserved,
    type OnExitObserved,
} from "../src/wallet/exitObserver";
import { UnilateralExit } from "../src/wallet/exit";
import { prepareUnrollTransaction, Unroll } from "../src/wallet/unroll";
import type { Wallet } from "../src/wallet/wallet";

const network = getNetwork("regtest");
const identity = SingleKey.fromHex("aa".repeat(32));
const server = schnorr.getPublicKey(new Uint8Array(32).fill(0xbb));
const timelock = { type: "blocks", value: 144n } as const;
const destAddress = p2tr(schnorr.getPublicKey(new Uint8Array(32).fill(4)), undefined, network)
    .address!;

// Deliberately not byte-reversal-symmetric, so a wrong txid encoding cannot pass unnoticed.
const EXITED = "0123456789abcdef".repeat(4);

/** An empty chain makes `next()` return DONE on the first call, so nothing else is touched. */
function doneSession(vout: number, onExitObserved?: OnExitObserved) {
    return new Unroll.Session(
        { txid: EXITED, vout, chain: [] },
        {} as never,
        {} as never,
        {} as never,
        undefined,
        onExitObserved,
    );
}

describe("Unroll.Session exit observation", () => {
    it("fires the hook once with the full outpoint at DONE", async () => {
        const hook = vi.fn();
        const steps: Unroll.Step[] = [];
        for await (const step of doneSession(3, hook)) steps.push(step);

        expect(steps.map((s) => s.type)).toEqual([Unroll.StepType.DONE]);
        expect(hook).toHaveBeenCalledTimes(1);
        expect(hook).toHaveBeenCalledWith({ txid: EXITED, vout: 3 });
    });

    it("runs to DONE with no hook attached", async () => {
        const steps: Unroll.Step[] = [];
        for await (const step of doneSession(0)) steps.push(step);
        expect(steps.map((s) => s.type)).toEqual([Unroll.StepType.DONE]);
    });

    it("completes the exit even when the hook rejects", async () => {
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        const hook = vi.fn(async () => {
            throw new Error("repository is gone");
        });

        const steps: Unroll.Step[] = [];
        for await (const step of doneSession(1, hook)) steps.push(step);

        expect(steps.map((s) => s.type)).toEqual([Unroll.StepType.DONE]);
        expect(hook).toHaveBeenCalledTimes(1);
        expect(errors).toHaveBeenCalled();
        errors.mockRestore();
    });
});

describe("exitObserverFor", () => {
    it("forwards the outpoint to refreshOutpoints as a one-element array", async () => {
        const refreshOutpoints = vi.fn(async () => {});
        await exitObserverFor({ refreshOutpoints })({ txid: EXITED, vout: 2 });
        expect(refreshOutpoints).toHaveBeenCalledWith([{ txid: EXITED, vout: 2 }]);
    });

    it("swallows a rejecting refreshOutpoints when fired through notifyExitObserved", async () => {
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        const refreshOutpoints = vi.fn(async () => {
            throw new Error("indexer down");
        });

        await expect(
            notifyExitObserved(exitObserverFor({ refreshOutpoints }), { txid: EXITED, vout: 0 }),
        ).resolves.toBeUndefined();
        expect(refreshOutpoints).toHaveBeenCalledTimes(1);
        errors.mockRestore();
    });

    it("is a no-op without a hook", async () => {
        await expect(
            notifyExitObserved(undefined, { txid: EXITED, vout: 0 }),
        ).resolves.toBeUndefined();
    });
});

function exitedVtxo(overrides?: Partial<ExtendedVirtualCoin>): ExtendedVirtualCoin {
    const script = new DefaultVtxo.Script({
        pubKey: schnorr.getPublicKey(hex.decode("aa".repeat(32))),
        serverPubKey: server,
        csvTimelock: timelock,
    });
    return {
        txid: EXITED,
        vout: 1,
        value: 50_000,
        status: { confirmed: true },
        createdAt: new Date(0),
        script: hex.encode(script.pkScript),
        tapTree: script.encode(),
        forfeitTapLeafScript: script.forfeit(),
        intentTapLeafScript: script.exit(),
        isUnrolled: true,
        isSpent: false,
        isSwept: false,
        isPreconfirmed: false,
        virtualStatus: { state: "settled" },
        ...overrides,
    };
}

function walletStub(vtxos: ExtendedVirtualCoin[], refresh?: () => Promise<void>) {
    const refreshOutpoints = vi.fn(refresh ?? (async () => {}));
    const broadcastTransaction = vi.fn(async (..._hexes: string[]) => "broadcast-txid");
    const getVtxos = vi.fn(async (_opts?: unknown) => vtxos);
    const getVtxoChain = vi.fn(async (_o: unknown) => ({ chain: [] }));
    const indexerProvider = { getVtxoChain };
    const virtualTxRepository = { marker: "repo" };
    const wallet = {
        network,
        identity,
        indexerProvider,
        virtualTxRepository,
        onchainProvider: {
            getChainTip: async () => ({ height: 1_000, time: 2_000_000 }),
            getTxStatus: async () => ({
                confirmed: true,
                blockHeight: 100,
                blockTime: 1_000_000,
            }),
            getFeeRate: async () => 2,
            broadcastTransaction,
        },
        getVtxos,
        getContractManager: async () => ({ refreshOutpoints }),
    };
    return {
        wallet: wallet as never as Wallet,
        refreshOutpoints,
        broadcastTransaction,
        getVtxos,
        indexerProvider,
        virtualTxRepository,
        onchainProvider: wallet.onchainProvider,
    };
}

/** One already-confirmed package step, so the executor completes on the first pass. */
const onePackageFor = (vtxo: string) =>
    ({
        version: 1,
        network: "regtest",
        createdAt: 1,
        feeRate: 2,
        sweepAddress: "bcrt1unused",
        totals: { txCount: 0, totalFeeSats: 0, fundingRequiredSats: 0, recoveredSats: 0 },
        vtxos: [],
        steps: [
            {
                kind: "package",
                parentTxid: "aa".repeat(32),
                parentHex: "parent-hex",
                childTxid: "bb".repeat(32),
                childHex: "child-hex",
                forVtxos: [vtxo],
            },
        ],
    }) as never;

const drain = async (iterable: AsyncIterable<unknown>) => {
    for await (const _ of iterable) {
        // drive to completion; the events themselves are the executor's own tests
    }
};

describe("Unroll.completeUnroll", () => {
    it("refreshes the outpoints the sweep just spent", async () => {
        const { wallet, refreshOutpoints, broadcastTransaction, getVtxos } = walletStub([
            exitedVtxo(),
        ]);

        const txid = await Unroll.completeUnroll(wallet, [EXITED], destAddress);

        expect(txid).toMatch(/^[0-9a-f]{64}$/);
        expect(broadcastTransaction).toHaveBeenCalledTimes(1);
        // The unrolled coin is only visible to a read that asks for it.
        expect(getVtxos).toHaveBeenCalledWith({ withUnrolled: true });
        expect(refreshOutpoints).toHaveBeenCalledTimes(1);
        expect(refreshOutpoints).toHaveBeenCalledWith([{ txid: EXITED, vout: 1 }]);
    });

    it("still returns the broadcast txid when the refresh fails", async () => {
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        const { wallet, refreshOutpoints, broadcastTransaction } = walletStub(
            [exitedVtxo()],
            async () => {
                throw new Error("repository is gone");
            },
        );

        await expect(Unroll.completeUnroll(wallet, [EXITED], destAddress)).resolves.toMatch(
            /^[0-9a-f]{64}$/,
        );
        expect(broadcastTransaction).toHaveBeenCalledTimes(1);
        expect(refreshOutpoints).toHaveBeenCalledTimes(1);
        errors.mockRestore();
    });
});

describe("Unroll.sessionFor", () => {
    // Thin by design, but it is the recommended entry point: everything the
    // wallet already holds, plus the one parameter a caller would forget.
    it("wires the wallet's providers and its exit observer", async () => {
        const stub = walletStub([]);
        const session = await Unroll.sessionFor(
            stub.wallet,
            { txid: EXITED, vout: 5 },
            {} as never,
        );

        expect(session.explorer).toBe(stub.onchainProvider);
        expect(session.indexer).toBe(stub.indexerProvider);
        expect(session.virtualTxRepository).toBe(stub.virtualTxRepository);

        // The assertion that matters: a hook that is present but unwired would
        // pass every check above and still leave the repository stale.
        await drain(session);
        expect(stub.refreshOutpoints).toHaveBeenCalledWith([{ txid: EXITED, vout: 5 }]);
    });
});

describe("UnilateralExit.execute", () => {
    it("wires the wallet's exit observer into the executor", async () => {
        const stub = walletStub([]);
        const executor = await UnilateralExit.execute(stub.wallet, onePackageFor(`${EXITED}:7`));

        expect(executor.provider).toBe(stub.onchainProvider);
        await drain(executor);
        expect(stub.refreshOutpoints).toHaveBeenCalledWith([{ txid: EXITED, vout: 7 }]);
    });

    it("lets an explicit observer win over the wallet's", async () => {
        const stub = walletStub([]);
        const mine = vi.fn();
        const executor = await UnilateralExit.execute(stub.wallet, onePackageFor(`${EXITED}:7`), {
            onExitObserved: mine,
        });

        await drain(executor);
        expect(mine).toHaveBeenCalledWith({ txid: EXITED, vout: 7 });
        expect(stub.refreshOutpoints).not.toHaveBeenCalled();
    });

    it("forwards the rest of the options, provider override included", async () => {
        const stub = walletStub([]);
        const provider = { ...stub.onchainProvider } as never;
        const signal = new AbortController().signal;
        const executor = await UnilateralExit.execute(stub.wallet, onePackageFor(`${EXITED}:7`), {
            provider,
            signal,
            pollIntervalMs: 1,
        });

        expect(executor.provider).toBe(provider);
        // `signal` reaches the executor: an already-aborted one would throw, so
        // assert on the live path instead — it drives to completion.
        await drain(executor);
        expect(stub.refreshOutpoints).toHaveBeenCalledTimes(1);
    });
});

describe("prepareUnrollTransaction exit gate", () => {
    it("refuses an unrolled coin whose exit output was already spent", async () => {
        const { wallet } = walletStub([exitedVtxo({ spentBy: "ff".repeat(32) })]);
        await expect(prepareUnrollTransaction(wallet, [EXITED], destAddress)).rejects.toThrow(
            /cannot be swept onchain/,
        );
    });

    it("accepts an unrolled coin that is past its batch expiry", async () => {
        // Expiry is the batch clock, not the exit's CSV — an exited coin is still sweepable.
        const { wallet } = walletStub([exitedVtxo({ expiresAtHeight: 1 })]);
        const tx = await prepareUnrollTransaction(wallet, [EXITED], destAddress);
        expect(tx.getInput(0).finalScriptWitness).toBeDefined();
    });
});
