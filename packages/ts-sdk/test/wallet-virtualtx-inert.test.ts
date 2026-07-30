import { describe, it, expect, vi } from "vitest";
import { Wallet } from "../src/wallet/wallet";
import { InMemoryWalletRepository } from "../src/repositories/inMemory/walletRepository";
import { InMemoryContractRepository } from "../src/repositories/inMemory/contractRepository";
import { SingleKey } from "../src/identity/singleKey";
import type { VirtualTxRepository } from "../src/repositories/virtualTxRepository";

// Guards the documented "experimental / inert" scope of virtualTxRepository:
// the wallet exposes it (so callers can hand it to Unroll.Session.create as a
// read cache) but no normal wallet/contract sync path writes it. If a future
// change starts populating branches during sync, these assertions must be
// revisited deliberately.

const SERVER_PUBKEY_HEX = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const CHECKPOINT_TAPSCRIPT =
    "5ab27520e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac";

const info = {
    signerPubkey: SERVER_PUBKEY_HEX,
    forfeitPubkey: SERVER_PUBKEY_HEX,
    network: "mutinynet",
    batchExpiry: 144n,
    unilateralExitDelay: 144n,
    boardingExitDelay: 604672n,
    roundInterval: 144n,
    dust: 1000n,
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    checkpointTapscript: CHECKPOINT_TAPSCRIPT,
};

function idleIndexer() {
    return {
        getVtxos: vi.fn(async () => ({ vtxos: [] })),
        subscribeForScripts: vi.fn(async () => "sub-id"),
        unsubscribeForScripts: vi.fn(async () => {}),
        getSubscription: vi.fn(async function* (_subId: string, abortSignal: AbortSignal) {
            await new Promise<void>((resolve) => {
                if (abortSignal?.aborted) return resolve();
                abortSignal?.addEventListener("abort", () => resolve(), { once: true });
            });
        }),
        watchAddresses: vi.fn(async () => () => {}),
    } as never;
}

function idleOnchain() {
    return {
        getCoins: vi.fn(async () => []),
        getTransactions: vi.fn(async () => []),
        getTxOutspends: vi.fn(async () => []),
        getTxStatus: vi.fn(async () => ({ confirmed: false })),
        getChainTip: vi.fn(async () => ({ height: 0, hash: "", time: 0 })),
        broadcastTransaction: vi.fn(async () => "txid"),
        watchAddresses: vi.fn(async () => () => {}),
    } as never;
}

function spyVirtualTxRepository() {
    return {
        version: 1,
        clear: vi.fn(async () => {}),
        upsertVirtualTxs: vi.fn(async () => {}),
        getVirtualTx: vi.fn(async () => null),
        setBranch: vi.fn(async () => {}),
        getBranch: vi.fn(async () => []),
        hasBranch: vi.fn(async () => false),
        pruneForSpentVtxo: vi.fn(async () => {}),
        [Symbol.asyncDispose]: vi.fn(async () => {}),
    } as unknown as VirtualTxRepository & {
        upsertVirtualTxs: ReturnType<typeof vi.fn>;
        setBranch: ReturnType<typeof vi.fn>;
        pruneForSpentVtxo: ReturnType<typeof vi.fn>;
        clear: ReturnType<typeof vi.fn>;
    };
}

async function makeWallet(virtualTxRepository: VirtualTxRepository) {
    const contractRepository = new InMemoryContractRepository();
    const wallet = await Wallet.create({
        identity: SingleKey.fromHex("1".repeat(64)),
        settlementConfig: false,
        arkProvider: { getInfo: vi.fn(async () => info) } as never,
        indexerProvider: idleIndexer(),
        onchainProvider: idleOnchain(),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository,
            virtualTxRepository,
        },
    });
    return { wallet, contractRepository };
}

describe("virtualTxRepository is exposed but inert", () => {
    it("exposes the configured repository on the wallet", async () => {
        const repo = spyVirtualTxRepository();
        const { wallet } = await makeWallet(repo);
        expect(wallet.virtualTxRepository).toBe(repo);
    });

    it("is never written by wallet creation or contract sync", async () => {
        const repo = spyVirtualTxRepository();
        const { wallet } = await makeWallet(repo);

        // Drive the sync/lifecycle paths that DO populate the normal repos.
        const manager = await wallet.getContractManager();
        const contracts = await manager.getContracts();
        await wallet.getVtxos();

        // Sanity: the manager ran and registered baseline contracts.
        expect(contracts.length).toBeGreaterThan(0);

        // ...but nothing touched the virtual-tx store.
        expect(repo.upsertVirtualTxs).not.toHaveBeenCalled();
        expect(repo.setBranch).not.toHaveBeenCalled();
        expect(repo.pruneForSpentVtxo).not.toHaveBeenCalled();
        expect(repo.clear).not.toHaveBeenCalled();
    });
});
