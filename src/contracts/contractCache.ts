import { IndexerProvider } from "../providers/indexer";
import { WalletRepository } from "../repositories/walletRepository";
import { ExtendedVirtualCoin, VirtualCoin } from "../wallet";
import { Contract, ContractVtxo } from "./types";

/**
 * Options for querying contract VTXOs.
 */
export interface GetContractVtxosOptions {
    /** Include spent VTXOs */
    includeSpent?: boolean;

    /** Force refresh from API instead of using cached data */
    refresh?: boolean;
}

/**
 * Cache abstraction for contract VTXO data.
 *
 * This decouples VTXO retrieval (indexer + repository) from the rest of the
 * contracts subsystem so the access policy can be centralized.
 */
export interface ContractVtxoCache {
    /**
     * Get VTXOs for the provided contracts with optional filtering/caching.
     */
    getContractVtxos(
        contracts: Contract[],
        options?: GetContractVtxosOptions,
        extendVtxo?: (vtxo: VirtualCoin) => ExtendedVirtualCoin
    ): Promise<Map<string, ContractVtxo[]>>;

    invalidateCache(): void;
}

/**
 * Default cache implementation backed by IndexerProvider and WalletRepository.
 */
export class IndexerContractVtxoCache implements ContractVtxoCache {
    private cachedAt = 0;
    /**
     *
     * @param indexerProvider
     * @param walletRepository
     * @param ttl cache duration, in milliseconds. Defaults to 10 minutes.
     */
    constructor(
        private readonly indexerProvider: IndexerProvider,
        private readonly walletRepository: WalletRepository,
        private ttl: number = 10_000 * 60 * 10
    ) {}

    invalidateCache() {
        this.cachedAt = 0;
    }

    async getContractVtxos(
        contracts: Contract[],
        options: GetContractVtxosOptions = {},
        extendVtxo?: (vtxo: VirtualCoin) => ExtendedVirtualCoin
    ): Promise<Map<string, ContractVtxo[]>> {
        const { includeSpent = false, refresh = false } = options;

        if (refresh) {
            this.invalidateCache();
        }

        if (contracts.length === 0) {
            return new Map();
        }

        const result = new Map<string, ContractVtxo[]>();
        const repo = this.walletRepository;
        if (Date.now() - this.cachedAt > this.ttl) {
            return await this.fetchContractVxosFromIndexer(
                contracts,
                includeSpent,
                extendVtxo
            );
        }

        // contracts for which the cache has zero VTXOs - we'll fetch them from the indexer
        const contractsNeedingFetch: Contract[] = [];

        for (const contract of contracts) {
            const cached = await repo.getVtxos(contract.address);
            if (cached.length > 0) {
                const contractVtxos: ContractVtxo[] = cached.map((v) => ({
                    ...v,
                    contractId: contract.id,
                }));
                const filtered = includeSpent
                    ? contractVtxos
                    : contractVtxos.filter((v) => !v.isSpent);
                result.set(contract.id, filtered);
            } else {
                contractsNeedingFetch.push(contract);
            }
        }

        if (contractsNeedingFetch.length > 0) {
            const vtxosFromRemote = await this.fetchContractVxosFromIndexer(
                contractsNeedingFetch,
                includeSpent,
                extendVtxo
            );
            for (const [contractId, vtxos] of vtxosFromRemote) {
                result.set(contractId, vtxos);
            }
        }

        return result;
    }

    private async fetchContractVxosFromIndexer(
        contracts: Contract[],
        includeSpent: boolean,
        extendVtxo?: (vtxo: VirtualCoin) => ExtendedVirtualCoin
    ): Promise<Map<string, ContractVtxo[]>> {
        const fetched = await this.fetchContractVtxosBulk(
            contracts,
            includeSpent,
            extendVtxo
        );
        const result = new Map<string, ContractVtxo[]>();
        for (const [contractId, vtxos] of fetched) {
            result.set(contractId, vtxos);
            const contract = contracts.find((c) => c.id === contractId);
            if (contract) {
                await this.walletRepository.saveVtxos(contract.address, vtxos);
            }
        }
        this.cachedAt = Date.now();
        return result;
    }

    private async fetchContractVtxosBulk(
        contracts: Contract[],
        includeSpent: boolean,
        extendVtxo?: (vtxo: VirtualCoin) => ExtendedVirtualCoin
    ): Promise<Map<string, ContractVtxo[]>> {
        const result = new Map<string, ContractVtxo[]>();

        await Promise.all(
            contracts.map(async (contract) => {
                const vtxos = await this.fetchContractVtxosPaginated(
                    contract,
                    includeSpent,
                    extendVtxo
                );
                result.set(contract.id, vtxos);
            })
        );

        return result;
    }

    private async fetchContractVtxosPaginated(
        contract: Contract,
        includeSpent: boolean,
        extendVtxo?: (vtxo: VirtualCoin) => ExtendedVirtualCoin
    ): Promise<ContractVtxo[]> {
        const pageSize = 100;
        const allVtxos: ContractVtxo[] = [];
        let pageIndex = 0;
        let hasMore = true;

        const opts = includeSpent ? {} : { spendableOnly: true };

        while (hasMore) {
            const { vtxos, page } = await this.indexerProvider.getVtxos({
                scripts: [contract.script],
                ...opts,
                pageIndex,
                pageSize,
            });

            for (const vtxo of vtxos) {
                const ext = extendVtxo
                    ? extendVtxo(vtxo)
                    : (vtxo as ExtendedVirtualCoin);

                allVtxos.push({
                    ...ext,
                    contractId: contract.id,
                });
            }

            hasMore = page ? vtxos.length === pageSize : false;
            pageIndex++;
        }

        return allVtxos;
    }
}
