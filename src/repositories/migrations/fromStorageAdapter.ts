import { StorageAdapter } from "../../storage";
import { WalletRepository } from "../walletRepository";
import { ContractRepository } from "../contractRepository";
import { WalletRepositoryImpl } from "./walletRepositoryImpl";
import { ContractRepositoryImpl } from "./contractRepositoryImpl";

const MIGRATION_KEY = (repoType: "wallet" | "contract") =>
    `migration-from-storage-adapter-${repoType}`;

export async function migrateWalletRepository(
    storageAdapter: StorageAdapter,
    fresh: WalletRepository,
    addresses: string[]
): Promise<void> {
    const migration = await storageAdapter.getItem(MIGRATION_KEY("wallet"));
    if (migration == "done") return;

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

const COLLECTION_KEYS = [
    {
        collectionName: "reverseSwaps",
        idField: "id",
    },
    { collectionName: "submarineSwaps", idField: "id" },
    { collectionName: "commitmentTxs", idField: "txid" },
];

/**
 * It migrates only the default keys created by the legacy implementation:
 *  - "collection:reverseSwaps"
 *  - "collection:submarineSwaps"
 *  - "collection:commitmentTxs"
 *
 *  Any other key requires manual intervention.
 *
 * @param storageAdapter
 * @param fresh
 */
export async function migrateContractRepository(
    storageAdapter: StorageAdapter,
    fresh: ContractRepository
): Promise<void> {
    const migration = await storageAdapter.getItem(MIGRATION_KEY("contract"));
    if (migration == "done") return;

    const legacy = new ContractRepositoryImpl(storageAdapter);

    for (const { collectionName, idField } of COLLECTION_KEYS) {
        const collection =
            await legacy.getContractCollection<Record<string, unknown>>(
                collectionName
            );
        if (!collection.length) continue;
        for (const item of collection) {
            await fresh.saveToContractCollection(collectionName, item, idField);
        }
    }

    await storageAdapter.setItem(MIGRATION_KEY("contract"), "done");
}
