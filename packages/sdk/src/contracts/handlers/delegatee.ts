import { hex } from "@scure/base";
import { VtxoScript } from "../../script/base";
import { defaultContract, type DelegateeDefault } from "../../script/delegateeTemplate";
import { CSVMultisigTapscript } from "../../script/tapscript";
import { timelockToSequence } from "../../utils/timelock";
import {
    Contract,
    ContractHandler,
    DerivedContractTapscripts,
    PathContext,
    PathSelection,
    TapscriptDeriving,
} from "../types";
import { isCsvSpendable } from "./helpers";

/**
 * Typed parameters for delegatee contracts: a default template's variables and the service's
 * keys. Keys are compressed, delays are BIP 68 sequences.
 */
export interface DelegateeContractParams {
    template: DelegateeDefault;
    owner: Uint8Array;
    exitDelay: number;
    renewalWindow: number;
    maxFee: number;
    /** boarding only */
    boardingExitDelay?: number;
    delegatePubKey: Uint8Array;
    serverPubKey: Uint8Array;
    emulatorPubKey: Uint8Array;
}

const TEMPLATES: readonly string[] = ["renewal", "boarding"];

function compressed(value: string | undefined, name: string): Uint8Array {
    const key = hex.decode(value ?? "");
    if (key.length !== 33) throw new Error(`${name} must be a compressed public key`);
    return key;
}

function integer(value: string | undefined, name: string): number {
    const n = Number(value);
    if (!/^[0-9]+$/.test(value ?? "") || !Number.isSafeInteger(n)) {
        throw new Error(`${name} must be a non-negative integer`);
    }
    return n;
}

/** forfeit (owner + server): the leaf the wallet signs with the server. */
function forfeitLeaf(script: VtxoScript) {
    return script.findLeaf(hex.encode(script.scripts[0]));
}

/** exit (owner after CSV): leaf 1 of both contracts. */
function exitPath(script: VtxoScript): PathSelection {
    const exit = CSVMultisigTapscript.decode(script.scripts[1]);
    return {
        leaf: script.findLeaf(hex.encode(exit.script)),
        sequence: Number(timelockToSequence(exit.params.timelock)),
    };
}

/** The covenant leaf is the service's and the server's to sign; it is never offered. */
function paths(script: VtxoScript, context: PathContext, checkTimelocks: boolean): PathSelection[] {
    const out: PathSelection[] = context.collaborative ? [{ leaf: forfeitLeaf(script) }] : [];
    const exit = exitPath(script);
    if (!checkTimelocks || isCsvSpendable(context, exit.sequence)) out.push(exit);
    return out;
}

/**
 * Handler for the coins a wallet delegated to a delegatee service under its default templates:
 * VTXOs at the renewal contract, which the service renews in place, and on-chain deposits at the
 * boarding contract, which it boards to the renewal contract. The scripts derive from the bundled
 * templates, the owner key, the params and the service's keys, so a restored wallet needs no
 * round-trip to the service.
 *
 * - forfeit: (Owner + Server) multisig, the wallet's collaborative path
 * - exit: (Owner) + CSV, the wallet's unilateral path
 * - renew/board: (Server + Emulator) covenant, the service's; never offered
 */
export const DelegateeContractHandler: ContractHandler<DelegateeContractParams, VtxoScript> &
    TapscriptDeriving<VtxoScript> = {
    type: "delegatee",

    createScript(params: Record<string, string>): VtxoScript {
        const p = this.deserializeParams(params);
        return defaultContract(
            p.template,
            {
                delegatePubkey: hex.encode(p.delegatePubKey),
                serverPubkey: hex.encode(p.serverPubKey),
                emulatorPubkey: hex.encode(p.emulatorPubKey),
            },
            p.owner,
            p,
        ).vtxoScript;
    },

    serializeParams(params: DelegateeContractParams): Record<string, string> {
        return {
            template: params.template,
            owner: hex.encode(params.owner),
            exitDelay: params.exitDelay.toString(),
            renewalWindow: params.renewalWindow.toString(),
            maxFee: params.maxFee.toString(),
            ...(params.boardingExitDelay !== undefined
                ? { boardingExitDelay: params.boardingExitDelay.toString() }
                : {}),
            delegatePubKey: hex.encode(params.delegatePubKey),
            serverPubKey: hex.encode(params.serverPubKey),
            emulatorPubKey: hex.encode(params.emulatorPubKey),
        };
    },

    deserializeParams(params: Record<string, string>): DelegateeContractParams {
        if (!TEMPLATES.includes(params.template)) {
            throw new Error(`unknown delegatee template ${params.template}`);
        }
        return {
            template: params.template as DelegateeDefault,
            owner: compressed(params.owner, "owner"),
            exitDelay: integer(params.exitDelay, "exitDelay"),
            renewalWindow: integer(params.renewalWindow, "renewalWindow"),
            maxFee: integer(params.maxFee, "maxFee"),
            ...(params.template === "boarding"
                ? { boardingExitDelay: integer(params.boardingExitDelay, "boardingExitDelay") }
                : {}),
            delegatePubKey: compressed(params.delegatePubKey, "delegatePubKey"),
            serverPubKey: compressed(params.serverPubKey, "serverPubKey"),
            emulatorPubKey: compressed(params.emulatorPubKey, "emulatorPubKey"),
        };
    },

    selectPath(
        script: VtxoScript,
        _contract: Contract,
        context: PathContext,
    ): PathSelection | null {
        return paths(script, context, true)[0] ?? null;
    },

    getAllSpendingPaths(
        script: VtxoScript,
        _contract: Contract,
        context: PathContext,
    ): PathSelection[] {
        return paths(script, context, false);
    },

    getSpendablePaths(
        script: VtxoScript,
        _contract: Contract,
        context: PathContext,
    ): PathSelection[] {
        return paths(script, context, true);
    },

    /** The wallet's own money, renewed by the service. */
    isGenericallySpendable: () => true,

    deriveTapscripts(script: VtxoScript): DerivedContractTapscripts {
        const leaf = forfeitLeaf(script);
        return { forfeitTapLeafScript: leaf, intentTapLeafScript: leaf, tapTree: script.encode() };
    },
};
