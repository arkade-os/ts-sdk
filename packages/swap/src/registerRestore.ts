import { registerWalletRestoreHook, type ArkTransaction, type IWallet } from "@arkade-os/sdk";
import type { AssetSwapRepository } from "./repository";
import type { RestoreIndexer, Tx } from "./restore";
import {
    restoreAssetSwapRepository,
    type RestoreAssetSwapRepositoryOptions,
    type RestoreAssetSwapRepositoryResult,
} from "./restoreRepository";

export interface RegisterAssetSwapRestoreOptions {
    arkServerUrl: string;
    repository: AssetSwapRepository;
    indexer?: RestoreIndexer;
    serverPubkey?: Uint8Array;
    prepareNew?: RestoreAssetSwapRepositoryOptions["prepareNew"];
    onResult?: (result: RestoreAssetSwapRepositoryResult) => void | Promise<void>;
}

type WalletRestoreDependencies = {
    indexerProvider?: RestoreIndexer;
    arkServerPublicKey?: Uint8Array;
};

const toRestoreTx = (tx: ArkTransaction): Tx => ({
    type: tx.type.toLowerCase(),
    redeemTxid: tx.key.arkTxid,
    boardingTxid: tx.key.boardingTxid,
    roundTxid: tx.key.commitmentTxid,
    createdAt: Math.floor(tx.createdAt / 1_000),
});

export function registerAssetSwapRestore(
    wallet: IWallet,
    options: RegisterAssetSwapRestoreOptions,
): () => void {
    return registerWalletRestoreHook(wallet, {
        id: "arkade-os:asset-swap",
        restore: async (restoredWallet) => {
            const dependencies = restoredWallet as IWallet & WalletRestoreDependencies;
            const indexer = options.indexer ?? dependencies.indexerProvider;
            const serverPubkey = options.serverPubkey ?? dependencies.arkServerPublicKey;
            if (!indexer) {
                throw new Error("asset-swap restore requires an indexer");
            }
            if (!serverPubkey) {
                throw new Error("asset-swap restore requires an Ark server public key");
            }
            const history = await restoredWallet.getTransactionHistory();
            const result = await restoreAssetSwapRepository({
                wallet: restoredWallet,
                arkServerUrl: options.arkServerUrl,
                indexer,
                repository: options.repository,
                txs: history.map(toRestoreTx),
                serverPubkey,
                prepareNew: options.prepareNew,
            });
            await options.onResult?.(result);
        },
    });
}
