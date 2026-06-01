import type { IWallet, Recipient } from ".";
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
import type { ReadonlyWallet } from "./wallet";
import { hex } from "@scure/base";
import { Bytes } from "@scure/btc-signer/utils.js";

export const DUST_AMOUNT = 546; // sats

/** Fallback dust threshold used when the wallet doesn't expose `dustAmount`. */
export const FALLBACK_WALLET_DUST_AMOUNT = 330n;

/** Extracts the dust amount from the wallet, defaulting to the fallback dust threshold. */
export function getDustAmount(wallet: IWallet): bigint {
    return "dustAmount" in wallet ? (wallet.dustAmount as bigint) : FALLBACK_WALLET_DUST_AMOUNT;
}

export function extendCoin(
    wallet: { boardingTapscript: ReadonlyWallet["boardingTapscript"] },
    utxo: Coin,
): ExtendedCoin {
    return {
        ...utxo,
        forfeitTapLeafScript: wallet.boardingTapscript.forfeit(),
        intentTapLeafScript: wallet.boardingTapscript.forfeit(),
        tapTree: wallet.boardingTapscript.encode(),
    };
}

/**
 * Tapscript fields derived purely from a contract's params. They are identical
 * for every VTXO locked to the same contract, so they can be memoized per
 * contract (see {@link ContractTapscriptCache}).
 */
export type ContractTapscripts = Pick<
    ExtendedVirtualCoin,
    "forfeitTapLeafScript" | "intentTapLeafScript" | "tapTree"
>;

/**
 * Cache of per-contract tapscript data, keyed by `contract.script`. Building
 * the taproot tree via `handler.createScript(contract.params)` is the dominant
 * cost when annotating large VTXO sets; passing a shared cache across an
 * annotation batch rebuilds it once per distinct contract instead of once per
 * VTXO (see #521).
 */
export type ContractTapscriptCache = Map<string, ContractTapscripts>;

function deriveContractTapscripts(contract: Contract): ContractTapscripts {
    const handler = contractHandlers.get(contract.type);
    if (!handler) {
        throw new Error(`No handler for contract type '${contract.type}'`);
    }
    const script = handler.createScript(contract.params) as
        | DefaultVtxo.Script
        | DelegateVtxo.Script;
    return {
        forfeitTapLeafScript: script.forfeit(),
        intentTapLeafScript: script.forfeit(),
        tapTree: script.encode(),
    };
}

function cloneTapLeafScript([
    controlBlock,
    script,
]: ContractTapscripts["forfeitTapLeafScript"]): ContractTapscripts["forfeitTapLeafScript"] {
    return [
        {
            version: controlBlock.version,
            internalKey: new Uint8Array(controlBlock.internalKey),
            merklePath: controlBlock.merklePath.map((hash) => new Uint8Array(hash)),
        },
        new Uint8Array(script),
    ];
}

function cloneContractTapscripts(tapscripts: ContractTapscripts): ContractTapscripts {
    return {
        forfeitTapLeafScript: cloneTapLeafScript(tapscripts.forfeitTapLeafScript),
        intentTapLeafScript: cloneTapLeafScript(tapscripts.intentTapLeafScript),
        tapTree: new Uint8Array(tapscripts.tapTree),
    };
}

function extendVtxoFromContract(
    vtxo: VirtualCoin,
    contract: Contract,
    cache?: ContractTapscriptCache,
): ExtendedVirtualCoin {
    if (!cache) {
        return { ...vtxo, ...deriveContractTapscripts(contract) };
    }

    let tapscripts = cache.get(contract.script);
    if (!tapscripts) {
        tapscripts = deriveContractTapscripts(contract);
        cache.set(contract.script, tapscripts);
    }

    return { ...vtxo, ...cloneContractTapscripts(tapscripts) };
}

/**
 * Extend a VirtualCoin with the tap scripts of whichever contract locks it.
 *
 * The second argument accepts either form, so each callsite passes what it
 * already has:
 * - a single `Contract` (when the caller already knows the owning contract,
 *   e.g. the contract manager iterating its own `scriptToContract` map), or
 * - a `ReadonlyMap<script, Contract>` (when the caller resolves by
 *   `vtxo.script`, populated by the indexer).
 *
 * Throws when no contract can be resolved — there is intentionally no
 * default-tapscript fallback. When the wallet owns multiple contracts
 * (default + delegate, several active vHTLCs, etc.) a default-tapscript path
 * silently stamps every VTXO with the same forfeit/intent data, overwriting
 * the correct data for any VTXO locked to a non-default contract. Callers
 * must feed a Contract or a populated script→Contract map; otherwise the
 * caller (typically `ContractManager.annotateVtxos`) should fetch the owning
 * contract first.
 */
export function extendVirtualCoinForContract(
    vtxo: VirtualCoin,
    contractOrMap?: Contract | ReadonlyMap<string, Contract>,
    cache?: ContractTapscriptCache,
): ExtendedVirtualCoin {
    const contract = resolveContract(vtxo, contractOrMap);
    if (!contract) {
        throw new Error(
            "extendVirtualCoinForContract: no contract matched vtxo.script — callers must resolve the owning contract before annotating",
        );
    }
    return extendVtxoFromContract(vtxo, contract, cache);
}

function isContractMap(
    value: Contract | ReadonlyMap<string, Contract>,
): value is ReadonlyMap<string, Contract> {
    // A `Contract` is a plain object with a string `type`. `ReadonlyMap` is
    // an interface so `instanceof Map` is not enough to narrow it — but a
    // contract has no `get` method, so duck-typing on that is unambiguous.
    return typeof (value as { get?: unknown }).get === "function";
}

function resolveContract(
    vtxo: VirtualCoin,
    contractOrMap?: Contract | ReadonlyMap<string, Contract>,
): Contract | undefined {
    if (!contractOrMap) return undefined;
    if (isContractMap(contractOrMap)) {
        return contractOrMap.get(vtxo.script);
    }
    return contractOrMap;
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

type ValidatedRecipient = Required<Omit<Recipient, "extensions">> & {
    script: Bytes;
    extensions?: Recipient["extensions"];
};

export function validateRecipients(
    recipients: Recipient[],
    dustAmount: number,
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
            script: amount < dustAmount ? address.subdustPkScript : address.pkScript,
        });
    }

    return validatedRecipients;
}
