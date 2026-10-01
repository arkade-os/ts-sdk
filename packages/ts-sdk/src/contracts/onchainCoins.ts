import type { Coin, ExtendedVirtualCoin, VirtualCoin } from "../wallet";
import type { Network } from "../networks";
import type { VtxoScript } from "../script/base";
import type { ContractRepository } from "../repositories/contractRepository";
import type { WalletRepository } from "../repositories/walletRepository";
import { extendVirtualCoinForContract } from "../wallet/utils";
import { toVirtualStatus } from "../wallet/vtxo";
import { contractHandlers } from "./handlers";
import { isOnchainScoped } from "./scope";
import type { Contract } from "./types";
import { saveVtxosForContract } from "./vtxoOwnership";

const MIGRATED_KEY = "legacyUtxosMigrated";

function createScript(contract: Contract): VtxoScript {
    const handler = contractHandlers.get(contract.type);
    if (!handler) throw new Error(`No handler for contract type '${contract.type}'`);
    return handler.createScript(contract.params);
}

export function onchainAddressOf(contract: Contract, network: Network): string {
    return createScript(contract).onchainAddress(network);
}

/** A contract's rows minus its onchain coins, which the offchain readers report elsewhere. */
export function offchainRows<T extends Pick<VirtualCoin, "isUnrolled">>(
    contract: Pick<Contract, "type" | "scope">,
    vtxos: T[],
): T[] {
    return isOnchainScoped(contract) ? vtxos.filter((v) => !v.isUnrolled) : vtxos;
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
            status: coin.status,
            isUnrolled: true,
            ...facts,
            virtualStatus: toVirtualStatus(facts),
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
    for (const contract of await contractRepository.getContracts()) {
        if (!isOnchainScoped(contract)) continue;
        if (!contractHandlers.has(contract.type)) {
            console.warn("Skipping legacy utxos of a contract with no handler", contract.type);
            continue;
        }
        const tapscript = createScript(contract);
        const legacy = await walletRepository.getUtxos(tapscript.onchainAddress(network));
        if (legacy.length === 0) continue;
        await saveVtxosForContract(
            walletRepository,
            contract,
            legacy.map((u) => toOnchainCoinRow(u, contract, tapscript)),
        );
        migrated += legacy.length;
    }
    await walletRepository.saveWalletState({
        ...state,
        settings: { ...state.settings, [MIGRATED_KEY]: true },
    });
    return migrated;
}
