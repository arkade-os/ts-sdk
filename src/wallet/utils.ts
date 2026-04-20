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
 * falling back to the wallet's default offchain tapscript.
 *
 * When the wallet owns multiple contracts (e.g. default + delegate, or
 * several active vHTLCs) a raw `extendVirtualCoin` call uses only the
 * default tapscript, which silently overwrites the correct forfeit/intent
 * data for any VTXO locked to a non-default contract. Resolving by
 * `vtxo.script` — now always populated by the indexer and persisted —
 * keeps the extension aligned with the contract that actually owns the
 * VTXO, which is a correctness requirement before the vtxo is used for
 * spending or saved back to the repository.
 */
export function extendVirtualCoinForContract(
    wallet: { offchainTapscript: ReadonlyWallet["offchainTapscript"] },
    vtxo: VirtualCoin,
    contractsByScript?: ReadonlyMap<string, Contract>
): ExtendedVirtualCoin {
    if (vtxo.script && contractsByScript) {
        const contract = contractsByScript.get(vtxo.script);
        if (contract) {
            return extendVtxoFromContract(vtxo, contract);
        }
    }
    return extendVirtualCoin(wallet, vtxo);
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
