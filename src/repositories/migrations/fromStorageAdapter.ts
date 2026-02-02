import { StorageAdapter } from "../../storage";
import { WalletRepository } from "../walletRepository";
import { WalletRepositoryImpl } from "./walletRepositoryImpl";

const MIGRATION_KEY = (repoType: "wallet" | "contract") =>
    `migration-from-storage-adapter-${repoType}`;

const requiresMigration = async (
    repoType: "wallet" | "contract",
    storageAdapter: StorageAdapter
): Promise<boolean> => {
    try {
        const migration = await storageAdapter.getItem(MIGRATION_KEY(repoType));
        return migration !== "done";
    } catch (e) {
        // failed because there is no legacy DB - no migation needed
        if (
            e instanceof Error &&
            e.message.includes(
                "One of the specified object stores was not found"
            )
        )
            return false;
        throw e;
    }
};

/**
 * Migrate wallet data from the legacy storage adapter to the new one.
 * It accepts both onchain and offchain addresses, make sure to pass both.
 *
 * @param storageAdapter
 * @param fresh
 * @param addresses
 */
export async function migrateWalletRepository(
    storageAdapter: StorageAdapter,
    fresh: WalletRepository,
    addresses: { onchain: string[]; offchain: string[] }
): Promise<void> {
    const migrate = await requiresMigration("wallet", storageAdapter);
    if (!migrate) return;

    const old = new WalletRepositoryImpl(storageAdapter);

    const walletData = await old.getWalletState();

    const onchainAddrData = await Promise.all(
        addresses.onchain.map(async (address) => {
            const utxos = await old.getUtxos(address);
            return { address, utxos };
        })
    );
    const offchainAddrData = await Promise.all(
        addresses.offchain.map(async (address) => {
            const vtxos = await old.getVtxos(address);
            const txs = await old.getTransactionHistory(address);
            return { address, vtxos, txs };
        })
    );

    await Promise.all([
        walletData && fresh.saveWalletState(walletData),
        ...offchainAddrData.map((addressData) =>
            Promise.all([
                fresh.saveVtxos(addressData.address, addressData.vtxos),
                fresh.saveTransactions(addressData.address, addressData.txs),
            ])
        ),
        ...onchainAddrData.map((addressData) =>
            fresh.saveUtxos(addressData.address, addressData.utxos)
        ),
    ]);

    await storageAdapter.setItem(MIGRATION_KEY("wallet"), "done");
}
