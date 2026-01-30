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

export async function migrateWalletRepository(
    storageAdapter: StorageAdapter,
    fresh: WalletRepository,
    addresses: string[]
): Promise<void> {
    const migrate = await requiresMigration("wallet", storageAdapter);
    if (!migrate) return;

    const old = new WalletRepositoryImpl(storageAdapter);

    const walletData = await old.getWalletState();

    const addressesData = await Promise.all(
        addresses.map(async (address) => {
            const vtxos = await old.getVtxos(address);
            const utxos = await old.getUtxos(address);
            const txs = await old.getTransactionHistory(address);
            return { address, vtxos, utxos, txs };
        })
    );

    await Promise.all([
        walletData && fresh.saveWalletState(walletData),
        ...addressesData.map((addressData) => {
            return Promise.all([
                fresh.saveVtxos(addressData.address, addressData.vtxos),
                fresh.saveUtxos(addressData.address, addressData.utxos),
                fresh.saveTransactions(addressData.address, addressData.txs),
            ]);
        }),
    ]);

    await storageAdapter.setItem(MIGRATION_KEY("wallet"), "done");
}
