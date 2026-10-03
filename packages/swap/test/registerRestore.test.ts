import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IWallet } from "@arkade-os/sdk";

const restoreAssetSwapRepository = vi.hoisted(() => vi.fn());
const hooks = vi.hoisted(
    () => new WeakMap<object, Map<string, { restore(wallet: IWallet): Promise<void> }>>(),
);

vi.mock("@arkade-os/sdk", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@arkade-os/sdk")>()),
    registerWalletRestoreHook: (
        wallet: IWallet,
        hook: { id: string; restore(wallet: IWallet): Promise<void> },
    ) => {
        const registered = hooks.get(wallet) ?? new Map();
        registered.set(hook.id, hook);
        hooks.set(wallet, registered);
        return () => {
            if (registered.get(hook.id) === hook) registered.delete(hook.id);
        };
    },
}));

vi.mock("../src/restoreRepository", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/restoreRepository")>()),
    restoreAssetSwapRepository,
}));

import { registerAssetSwapRestore } from "../src/registerRestore";

const runRegisteredHooks = async (wallet: IWallet): Promise<void> => {
    const errors: unknown[] = [];
    for (const hook of [...(hooks.get(wallet)?.values() ?? [])]) {
        try {
            await hook.restore(wallet);
        } catch (error) {
            errors.push(error);
        }
    }
    if (errors.length > 0) throw new AggregateError(errors);
};

const result = {
    swaps: [],
    changes: [],
    scannedTxids: ["funding-txid"],
    aborted: false,
    coverageError: new Error("coverage incomplete"),
};

const makeWallet = () => {
    const history = [
        {
            key: {
                arkTxid: "funding-txid",
                commitmentTxid: "round-txid",
                boardingTxid: "boarding-txid",
            },
            type: "SENT",
            amount: -1_000,
            settled: true,
            createdAt: 1_750_000_000_000,
        },
    ];
    const indexerProvider = { getVtxos: vi.fn() };
    const arkServerPublicKey = new Uint8Array(32).fill(0xab);
    const wallet = {
        getArkadeReader: vi.fn(() => indexerProvider),
        getArkadeInfo: vi.fn(async () => ({ signerPubkey: `02${"ab".repeat(32)}` })),
        getTransactionHistory: vi.fn(async () => history),
    } as unknown as IWallet & {
        getArkadeReader: () => typeof indexerProvider;
        getArkadeInfo: () => Promise<{ signerPubkey: string }>;
    };
    return { wallet, history, indexerProvider, arkServerPublicKey };
};

describe("registerAssetSwapRestore", () => {
    beforeEach(() => {
        restoreAssetSwapRepository.mockReset().mockResolvedValue(result);
    });

    it("restores repository state from recovered wallet history and reports the result", async () => {
        const { wallet, indexerProvider, arkServerPublicKey } = makeWallet();
        const repository = { name: "repository" };
        const prepareNew = vi.fn((swap) => swap);
        const onResult = vi.fn(async () => undefined);
        registerAssetSwapRestore(wallet, {
            repository: repository as never,
            prepareNew,
            onResult,
        });

        await runRegisteredHooks(wallet);

        expect(restoreAssetSwapRepository).toHaveBeenCalledWith({
            wallet,
            indexer: indexerProvider,
            repository,
            txs: [
                {
                    type: "sent",
                    redeemTxid: "funding-txid",
                    roundTxid: "round-txid",
                    boardingTxid: "boarding-txid",
                    createdAt: 1_750_000_000,
                },
            ],
            operatorPubkey: arkServerPublicKey,
            prepareNew,
        });
        expect(onResult).toHaveBeenCalledWith(result);
    });

    it("uses explicit recovery dependencies for proxy and custom wallets", async () => {
        const { wallet } = makeWallet();
        const indexer = { getVtxos: vi.fn() };
        const operatorPubkey = new Uint8Array(32).fill(0xcd);
        registerAssetSwapRestore(wallet, {
            repository: {} as never,
            indexer: indexer as never,
            operatorPubkey,
        });

        await runRegisteredHooks(wallet);

        expect(restoreAssetSwapRepository).toHaveBeenCalledWith(
            expect.objectContaining({ indexer, operatorPubkey }),
        );
    });

    it("replaces an earlier registration for the same wallet", async () => {
        const { wallet } = makeWallet();
        const first = vi.fn();
        const second = vi.fn();
        registerAssetSwapRestore(wallet, {
            repository: {} as never,
            onResult: first,
        });
        registerAssetSwapRestore(wallet, {
            repository: {} as never,
            onResult: second,
        });

        await runRegisteredHooks(wallet);

        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledWith(result);
        expect(restoreAssetSwapRepository).toHaveBeenCalledOnce();
        expect(restoreAssetSwapRepository).toHaveBeenCalledWith(
            expect.objectContaining({ wallet }),
        );
    });

    it("propagates an onResult failure from the restore hook", async () => {
        const { wallet } = makeWallet();
        registerAssetSwapRestore(wallet, {
            repository: {} as never,
            onResult: async () => {
                throw new Error("presentation failed");
            },
        });

        const failure = await runRegisteredHooks(wallet).catch((error) => error);

        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure.errors).toEqual([
            expect.objectContaining({ message: "presentation failed" }),
        ]);
    });
});
