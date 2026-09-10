import { hex } from "@scure/base";
import {
    registerWalletRestoreHook,
    toXOnlySignerHex,
    type ArkTransaction,
    type IWallet,
} from "@arkade-os/sdk";
import type { AssetSwapRepository } from "./repository";
import type { RestoreIndexer, Tx } from "./restore";
import {
    restoreAssetSwapRepository,
    type RestoreAssetSwapRepositoryOptions,
    type RestoreAssetSwapRepositoryResult,
} from "./restoreRepository";

export interface RegisterAssetSwapRestoreOptions {
    repository: AssetSwapRepository;
    indexer?: RestoreIndexer;
    operatorPubkey?: Uint8Array;
    prepareNew?: RestoreAssetSwapRepositoryOptions["prepareNew"];
    onResult?: (result: RestoreAssetSwapRepositoryResult) => void | Promise<void>;
}

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
            const [history, indexer, info] = await Promise.all([
                restoredWallet.getTransactionHistory(),
                options.indexer ?? restoredWallet.getArkadeReader(),
                options.operatorPubkey
                    ? undefined
                    : restoredWallet.getArkadeInfo({ requireLive: true }),
            ]);
            const operatorPubkey =
                options.operatorPubkey ?? hex.decode(toXOnlySignerHex(info!.signerPubkey));
            const result = await restoreAssetSwapRepository({
                wallet: restoredWallet,
                indexer,
                repository: options.repository,
                txs: history.map(toRestoreTx),
                operatorPubkey,
                prepareNew: options.prepareNew,
            });
            await options.onResult?.(result);
        },
    });
}
