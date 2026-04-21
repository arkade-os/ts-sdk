import { Recipient } from ".";
import {
    ArkAddress,
    type Coin,
    type ExtendedCoin,
    type ExtendedVirtualCoin,
    type VirtualCoin,
} from "..";
import type { Contract } from "../contracts/types";
import { contractHandlers } from "../contracts/handlers";
import { DefaultVtxo } from "../script/default";
import { DelegateVtxo } from "../script/delegate";
import { ReadonlyWallet } from "./wallet";
import { hex } from "@scure/base";
import { Bytes } from "@scure/btc-signer/utils";

export const DUST_AMOUNT = 546; // sats

/**
 * @deprecated Prefer {@link extendVirtualCoinForContract}, which resolves the
 * owning contract's tapscripts when the wallet holds VTXOs from multiple
 * contracts. This helper unconditionally stamps the wallet's default
 * tapscript onto every VTXO and is only safe for wallets whose VTXOs all
 * belong to the default contract.
 */
export function extendVirtualCoin(
    wallet: { offchainTapscript: ReadonlyWallet["offchainTapscript"] },
    vtxo: VirtualCoin
): ExtendedVirtualCoin {
    return {
        ...vtxo,
        forfeitTapLeafScript: wallet.offchainTapscript.forfeit(),
        intentTapLeafScript: wallet.offchainTapscript.forfeit(),
        tapTree: wallet.offchainTapscript.encode(),
    };
}

export function extendCoin(
    wallet: { boardingTapscript: ReadonlyWallet["boardingTapscript"] },
    utxo: Coin
): ExtendedCoin {
    return {
        ...utxo,
        forfeitTapLeafScript: wallet.boardingTapscript.forfeit(),
        intentTapLeafScript: wallet.boardingTapscript.forfeit(),
        tapTree: wallet.boardingTapscript.encode(),
    };
}

/**
 * @deprecated Internal primitive — call {@link extendVirtualCoinForContract}
 * and pass the `Contract` (or a `ReadonlyMap<script, Contract>`) as the third
 * argument instead. The unified helper routes through this primitive when a
 * contract resolves and falls back to the wallet's default tapscript
 * otherwise.
 */
export function extendVtxoFromContract(
    vtxo: VirtualCoin,
    contract: Contract
): ExtendedVirtualCoin {
    const handler = contractHandlers.get(contract.type);
    if (!handler) {
        throw new Error(`No handler for contract type '${contract.type}'`);
    }
    const script = handler.createScript(contract.params) as
        | DefaultVtxo.Script
        | DelegateVtxo.Script;
    return {
        ...vtxo,
        forfeitTapLeafScript: script.forfeit(),
        intentTapLeafScript: script.forfeit(),
        tapTree: script.encode(),
    };
}

/**
 * Extend a VirtualCoin with the tap scripts of whichever contract locks it,
 * falling back to the wallet's default offchain tapscript when no contract
 * can be resolved.
 *
 * The third argument accepts either form, so each callsite passes what it
 * already has:
 * - a single `Contract` (when the caller already knows the owning contract,
 *   e.g. the contract manager iterating its own `scriptToContract` map), or
 * - a `ReadonlyMap<script, Contract>` (when the caller resolves by
 *   `vtxo.script`, populated by the indexer).
 *
 * `wallet` may be `undefined` when the caller guarantees a contract always
 * resolves (no need for the default-tapscript fallback). When both no
 * contract resolves and no wallet is provided, this throws rather than
 * returning a silently-defaulted extension.
 *
 * When the wallet owns multiple contracts (default + delegate, several active
 * vHTLCs, etc.), a raw {@link extendVirtualCoin} call uses only the default
 * tapscript, which silently overwrites the correct forfeit/intent data for
 * any VTXO locked to a non-default contract. Resolving by `vtxo.script` keeps
 * the extension aligned with the owning contract, which is a correctness
 * requirement before the vtxo is used for spending or saved back to the
 * repository.
 */
export function extendVirtualCoinForContract(
    wallet:
        | { offchainTapscript: ReadonlyWallet["offchainTapscript"] }
        | undefined,
    vtxo: VirtualCoin,
    contractOrMap?: Contract | ReadonlyMap<string, Contract>
): ExtendedVirtualCoin {
    const contract = resolveContract(vtxo, contractOrMap);
    if (contract) {
        return extendVtxoFromContract(vtxo, contract);
    }
    if (!wallet) {
        throw new Error(
            "extendVirtualCoinForContract: no contract matched vtxo.script and no wallet fallback was provided"
        );
    }
    return extendVirtualCoin(wallet, vtxo);
}

function isContractMap(
    value: Contract | ReadonlyMap<string, Contract>
): value is ReadonlyMap<string, Contract> {
    // A `Contract` is a plain object with a string `type`. `ReadonlyMap` is
    // an interface so `instanceof Map` is not enough to narrow it — but a
    // contract has no `get` method, so duck-typing on that is unambiguous.
    return typeof (value as { get?: unknown }).get === "function";
}

function resolveContract(
    vtxo: VirtualCoin,
    contractOrMap?: Contract | ReadonlyMap<string, Contract>
): Contract | undefined {
    if (!contractOrMap) return undefined;
    if (isContractMap(contractOrMap)) {
        return vtxo.script ? contractOrMap.get(vtxo.script) : undefined;
    }
    return contractOrMap;
}

/**
 * Collect the unique, defined `script` values from one or more batches of
 * virtual outputs. Callers pass the result to `getContractsByScript` so the
 * contract lookup is scoped to the scripts actually being processed rather
 * than every contract the wallet has ever created.
 */
export function collectVtxoScripts(
    ...batches: readonly (readonly { script?: string }[])[]
): string[] {
    const scripts = new Set<string>();
    for (const batch of batches) {
        for (const vtxo of batch) {
            if (vtxo.script) scripts.add(vtxo.script);
        }
    }
    return [...scripts];
}

export function getRandomId(): string {
    const randomValue = crypto.getRandomValues(new Uint8Array(16));
    return hex.encode(randomValue);
}

export function isValidArkAddress(address: string): boolean {
    try {
        ArkAddress.decode(address);
        return true;
    } catch (e) {
        return false;
    }
}

type ValidatedRecipient = Required<Recipient> & { script: Bytes };

export function validateRecipients(
    recipients: Recipient[],
    dustAmount: number
): ValidatedRecipient[] {
    const validatedRecipients: ValidatedRecipient[] = [];

    for (const recipient of recipients) {
        let address: ArkAddress;
        try {
            address = ArkAddress.decode(recipient.address);
        } catch (e) {
            throw new Error(`Invalid Arkade address: ${recipient.address}`);
        }

        const amount = recipient.amount || dustAmount;
        if (amount <= 0) {
            throw new Error("Amount must be positive");
        }

        validatedRecipients.push({
            address: recipient.address,
            assets: recipient.assets ?? [],
            amount,
            script:
                amount < dustAmount
                    ? address.subdustPkScript
                    : address.pkScript,
        });
    }

    return validatedRecipients;
}
