import type { Coin, ExtendedVirtualCoin, VirtualCoin } from "../wallet";
import type { Network } from "../networks";
import type { VtxoScript } from "../script/base";
import { collectContracts, type ContractRepository } from "../repositories/contractRepository";
import { collectUtxos, type WalletRepository } from "../repositories/walletRepository";
import { extendVirtualCoinForContract } from "../wallet/utils";
import { contractHandlers } from "./handlers";
import { isOnchainScoped, scopeOf } from "./scope";
import type { Contract } from "./types";
import { saveVtxosForContract } from "./vtxoOwnership";
import { updateWalletState } from "../utils/syncCursors";

const MIGRATED_KEY = "legacyUtxosMigrated";

function createScript(contract: Contract): VtxoScript {
    const handler = contractHandlers.get(contract.type);
    if (!handler) throw new Error(`No handler for contract type '${contract.type}'`);
    return handler.createScript(contract.params);
}

export function onchainAddressOf(contract: Contract, network: Network): string {
    return createScript(contract).onchainAddress(network);
}

/**
 * A contract's onchain coins. A `both` contract's unrolled rows also include unrolled VTXOs,
 * which stay offchain, so only the coins the onchain sync stored count there.
 */
export function onchainRows<T extends Pick<VirtualCoin, "isUnrolled" | "status">>(
    contract: Pick<Contract, "type" | "scope">,
    vtxos: T[],
): T[] {
    switch (scopeOf(contract)) {
        case "offchain":
            return [];
        case "both":
            return vtxos.filter((v) => v.isUnrolled && isExplorerCoin(v));
        default:
            return vtxos.filter((v) => v.isUnrolled);
    }
}

/** A contract's rows minus its onchain coins, which the offchain readers report elsewhere. */
export function offchainRows<T extends Pick<VirtualCoin, "isUnrolled" | "status">>(
    contract: Pick<Contract, "type" | "scope">,
    vtxos: T[],
): T[] {
    const onchain = new Set(onchainRows(contract, vtxos));
    return onchain.size === 0 ? vtxos : vtxos.filter((v) => !onchain.has(v));
}

export function offchainSnapshot<T extends { contract: Contract; vtxos: VirtualCoin[] }>(
    snapshot: T[],
): T[] {
    return snapshot.map((entry) => ({
        ...entry,
        vtxos: offchainRows(entry.contract, entry.vtxos),
    }));
}

/** A row {@link toOnchainCoinRow} wrote, as opposed to an unrolled VTXO the indexer reported. */
export function isExplorerCoin(row: Pick<VirtualCoin, "status">): boolean {
    return row.status.fromExplorer === true;
}

/** Same shape as the boarding rows `getBoardingTxs` synthesizes for history. */
export function toOnchainCoinRow(
    coin: Coin,
    contract: Contract,
    _tapscript: VtxoScript,
): ExtendedVirtualCoin {
    const facts = {
        isSpent: false,
        isSwept: false,
        isPreconfirmed: false,
        commitmentTxIds: [],
    };
    return extendVirtualCoinForContract(
        {
            txid: coin.txid,
            vout: coin.vout,
            value: coin.value,
            status: { ...coin.status, fromExplorer: true },
            isUnrolled: true,
            ...facts,
            spentBy: "",
            createdAt: coin.status.block_time
                ? new Date(coin.status.block_time * 1000)
                : new Date(0),
            script: contract.script,
        },
        contract,
    );
}

/** One-shot copy of the legacy `utxos` table into the VTXO store; the legacy table is left as is. */
export async function migrateLegacyUtxos(deps: {
    walletRepository: WalletRepository;
    contractRepository: ContractRepository;
    network: Network;
}): Promise<number> {
    const { walletRepository, contractRepository, network } = deps;
    const state = (await walletRepository.getWalletState()) ?? {};
    if (state.settings?.[MIGRATED_KEY]) return 0;

    let migrated = 0;
    for (const contract of await collectContracts(contractRepository)) {
        if (!isOnchainScoped(contract)) continue;
        if (!contractHandlers.has(contract.type)) {
            console.warn("Skipping legacy utxos of a contract with no handler", contract.type);
            continue;
        }
        const tapscript = createScript(contract);
        const legacy = await collectUtxos(walletRepository, tapscript.onchainAddress(network));
        if (legacy.length === 0) continue;
        await saveVtxosForContract(
            walletRepository,
            contract,
            legacy.map((u) => toOnchainCoinRow(u, contract, tapscript)),
        );
        migrated += legacy.length;
    }
    await updateWalletState(walletRepository, (latest) => ({
        ...latest,
        settings: { ...latest.settings, [MIGRATED_KEY]: true },
    }));
    return migrated;
}
