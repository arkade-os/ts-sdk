import type { IWallet, Recipient } from ".";
import {
    ArkAddress,
    type Coin,
    type ExtendedCoin,
    type ExtendedVirtualCoin,
    type VirtualCoin,
} from "..";
import type { Contract } from "../contracts/types";
import { isTapscriptDeriving } from "../contracts/types";
import { contractHandlers } from "../contracts/handlers";
import { DefaultVtxo } from "../script/default";
import { DelegateVtxo } from "../script/delegate";
import { VtxoScript, type TapLeafScript } from "../script/base";
import type { ReadonlyWallet } from "./wallet";
import { classifyAgainstSignerSet, type SignerSet } from "./signerRotation";
import { hex } from "@scure/base";
import { Bytes } from "@scure/btc-signer/utils.js";

export const DUST_AMOUNT = 546; // sats

/** Fallback dust threshold used when the wallet doesn't expose `dustAmount`. */
export const FALLBACK_WALLET_DUST_AMOUNT = 330n;

/** Extracts the dust amount from the wallet, defaulting to the fallback dust threshold. */
export function getDustAmount(wallet: IWallet): bigint {
    return "dustAmount" in wallet ? (wallet.dustAmount as bigint) : FALLBACK_WALLET_DUST_AMOUNT;
}

/**
 * Annotate an on-chain boarding {@link Coin} with the forfeit/intent leaves
 * and tap tree of a *specific* boarding tapscript — the one the UTXO actually
 * sits on, resolved by scriptPubKey.
 *
 * Under per-derivation boarding rotation (plan §6-II) a wallet can hold
 * unspent boarding UTXOs at several historical boarding addresses at once, so
 * the spending path must NOT assume the single current `boardingTapscript`;
 * each UTXO is extended with the tapscript of its own address (plan §6-III.2).
 */
export function extendCoinWithTapscript(
    boardingTapscript: VtxoScript & { forfeit(): TapLeafScript },
    utxo: Coin,
): ExtendedCoin {
    return {
        ...utxo,
        forfeitTapLeafScript: boardingTapscript.forfeit(),
        intentTapLeafScript: boardingTapscript.forfeit(),
        tapTree: boardingTapscript.encode(),
    };
}

/**
 * Annotate a boarding {@link Coin} with the wallet's *current* boarding
 * tapscript. Kept for callers that only ever deal with the current boarding
 * address; the multi-address spending path uses {@link extendCoinWithTapscript}
 * with the per-UTXO tapscript instead.
 */
export function extendCoin(
    wallet: { boardingTapscript: ReadonlyWallet["boardingTapscript"] },
    utxo: Coin,
): ExtendedCoin {
    return extendCoinWithTapscript(wallet.boardingTapscript, utxo);
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

/**
 * Build a contract's annotation tapscripts, or throw. Exported so callers that
 * must know *whether* a contract can still be annotated — the bulk sync, the
 * pre-spend check — can ask without annotating a VTXO, and can keep the result
 * in a {@link ContractTapscriptCache} so nothing is built twice.
 */
export function deriveContractTapscripts(contract: Contract): ContractTapscripts {
    const handler = contractHandlers.get(contract.type);
    if (!handler) {
        throw new Error(`No handler for contract type '${contract.type}'`);
    }
    const script = handler.createScript(contract.params);
    // Handlers whose script shape has no `forfeit()` (e.g. program-compiled
    // arkade contracts) provide the annotation tapscripts themselves.
    if (isTapscriptDeriving(handler)) {
        return handler.deriveTapscripts(script, contract);
    }
    const legacy = script as DefaultVtxo.Script | DelegateVtxo.Script;
    return {
        forfeitTapLeafScript: legacy.forfeit(),
        intentTapLeafScript: legacy.forfeit(),
        tapTree: legacy.encode(),
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

function extendVtxoFromContract<T extends VirtualCoin>(
    vtxo: T,
    contract: Contract,
    cache?: ContractTapscriptCache,
): T & ExtendedVirtualCoin {
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
export function extendVirtualCoinForContract<T extends VirtualCoin>(
    vtxo: T,
    contractOrMap?: Contract | ReadonlyMap<string, Contract>,
    cache?: ContractTapscriptCache,
): T & ExtendedVirtualCoin {
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

type ValidatedRecipient = Required<Omit<Recipient, "extensions" | "tapTree">> & {
    script: Bytes;
    extensions?: Recipient["extensions"];
    tapTree?: Recipient["tapTree"];
};

/**
 * What a recipient Arkade address must match. An address failing either check
 * belongs to another network or operator, so this wallet's operator cannot
 * create the VTXO where the recipient's wallet expects it.
 */
export type RecipientAddressContext = {
    hrp: string;
    signerSet: SignerSet;
};

/**
 * The embedded server key may be the current signer or a deprecated signer
 * whose rotation cutoff has not passed.
 */
export function assertRecipientArkAddress(
    encoded: string,
    address: ArkAddress,
    context: RecipientAddressContext,
): void {
    if (address.hrp !== context.hrp) {
        throw new Error(
            `Invalid Arkade address ${encoded}: expected prefix "${context.hrp}", got "${address.hrp}"`,
        );
    }
    const { status } = classifyAgainstSignerSet(
        hex.encode(address.serverPubKey),
        context.signerSet,
    );
    if (status === "UNKNOWN_SIGNER") {
        throw new Error(`Invalid Arkade address ${encoded}: unknown operator signer key`);
    }
    if (status === "EXPIRED") {
        throw new Error(
            `Invalid Arkade address ${encoded}: operator signer key is past its rotation cutoff`,
        );
    }
}

/**
 * A published taptree must derive the address it is published against — nothing
 * downstream re-derives it, so a mismatched tree fails only in whatever later
 * tries to spend.
 *
 * Compared against `pkScript`, not the output script: a sub-dust output pays the
 * `RETURN` form of the same key.
 */
function assertTapTreeDerivesAddress(encoded: string, tapTree: Bytes, address: ArkAddress): void {
    let derived: Bytes;
    try {
        derived = VtxoScript.decode(tapTree).pkScript;
    } catch (e) {
        throw new Error(
            `Invalid tapTree for ${encoded}: ${e instanceof Error ? e.message : String(e)}`,
        );
    }
    if (hex.encode(derived) !== hex.encode(address.pkScript)) {
        throw new Error(
            `Invalid tapTree for ${encoded}: derives ${hex.encode(derived)}, ` +
                `address is ${hex.encode(address.pkScript)}. Expected VtxoScript.encode() form: ` +
                `leaf depths are ignored and the tree is rebuilt in arkd's canonical shape.`,
        );
    }
}

export function validateRecipients(
    recipients: Recipient[],
    dustAmount: number,
    context: RecipientAddressContext,
): ValidatedRecipient[] {
    const validatedRecipients: ValidatedRecipient[] = [];

    for (const recipient of recipients) {
        let address: ArkAddress;
        try {
            address = ArkAddress.decode(recipient.address);
        } catch (e) {
            throw new Error(`Invalid Arkade address: ${recipient.address}`);
        }

        assertRecipientArkAddress(recipient.address, address, context);

        const amount = recipient.amount || dustAmount;
        if (amount <= 0) {
            throw new Error("Amount must be positive");
        }

        if (recipient.tapTree) {
            assertTapTreeDerivesAddress(recipient.address, recipient.tapTree, address);
        }

        validatedRecipients.push({
            address: recipient.address,
            assets: recipient.assets ?? [],
            amount,
            script: amount < dustAmount ? address.subdustPkScript : address.pkScript,
            tapTree: recipient.tapTree,
        });
    }

    return validatedRecipients;
}
