import {
    ContractManager,
    InMemoryContractRepository,
    InMemoryWalletRepository,
} from "../../src";
import type { DiscoveryDeps } from "../../src/contracts/types";

/**
 * Construct a fresh {@link ContractManager} backed by in-memory repositories
 * and a mock indexer that reports no VTXOs for any script. Used by the
 * `scanContracts` unit suite so the loop's behaviour is driven solely by the
 * fake `Discoverable` handlers registered by each test (the built-in
 * `default`/`delegate` handlers see no indexer history and contribute
 * nothing).
 */
export async function makeManagerForTest(): Promise<ContractManager> {
    return ContractManager.create({
        indexerProvider: makeDeps().indexerProvider,
        contractRepository: new InMemoryContractRepository(),
        walletRepository: new InMemoryWalletRepository(),
        watcherConfig: {
            failsafePollIntervalMs: 1000,
            reconnectDelayMs: 500,
        },
    });
}

/**
 * A {@link DiscoveryDeps} whose indexer always answers "no VTXOs". Lets the
 * `scanContracts` tests assert purely on the fake handler's contributions —
 * the built-in `default`/`delegate` handlers, also iterated by the scanner,
 * see an empty indexer and never hit, so they don't perturb the gap counter.
 */
export function makeDeps(): DiscoveryDeps {
    return {
        indexerProvider: {
            async getVtxos() {
                return { vtxos: [] };
            },
        } as unknown as DiscoveryDeps["indexerProvider"],
        onchainProvider: {} as unknown as DiscoveryDeps["onchainProvider"],
        network: { hrp: "ark" },
        serverPubKey: new Uint8Array(32),
        csvTimelocks: [],
    };
}
