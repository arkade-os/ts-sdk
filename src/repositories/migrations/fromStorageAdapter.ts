import { StorageAdapter } from "../../storage";
import { WalletRepository } from "../walletRepository";
import { WalletRepositoryImpl } from "./walletRepositoryImpl";

export const MIGRATION_KEY = (repoType: "wallet" | "contract") =>
    `migration-from-storage-adapter-${repoType}`;

export type MigrationStatus = "pending" | "in-progress" | "done" | "not-needed";

export async function getMigrationStatus(
    repoType: "wallet" | "contract",
    storageAdapter: StorageAdapter
): Promise<MigrationStatus> {
    try {
        const migration = await storageAdapter.getItem(MIGRATION_KEY(repoType));
        if (migration === "done") return "done";
        if (migration === "in-progress") return "in-progress";
        return "pending";
    } catch (e) {
        if (
            e instanceof Error &&
            e.message.includes(
                "One of the specified object stores was not found"
            )
        )
            return "not-needed";
        throw e;
    }
}

export async function requiresMigration(
    repoType: "wallet" | "contract",
    storageAdapter: StorageAdapter
): Promise<boolean> {
    const status = await getMigrationStatus(repoType, storageAdapter);
    return status === "pending" || status === "in-progress";
}

export async function rollbackMigration(
    repoType: "wallet" | "contract",
    storageAdapter: StorageAdapter
): Promise<void> {
    await storageAdapter.removeItem(MIGRATION_KEY(repoType));
}

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

    await storageAdapter.setItem(MIGRATION_KEY("wallet"), "in-progress");

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
