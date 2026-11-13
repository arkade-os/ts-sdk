import { hex } from "@scure/base";
import { equalBytes } from "@scure/btc-signer/utils.js";
import { DefaultVtxo } from "../../script/default";
import { defaultContract, type ExecutorDefault } from "../../script/executor/executorTemplate";
import { sequenceToTimelock, timelockToSequence } from "../../utils/timelock";
import { Contract, ContractHandler, PathContext, PathSelection } from "../types";
import { isCsvSpendable } from "./helpers";

/**
 * Typed parameters for delegated contracts: a default template's variables and the Executor's
 * keys. Keys are compressed, delays are BIP 68 sequences.
 */
export interface ExecutorContractParams {
    template: ExecutorDefault;
    owner: Uint8Array;
    exitDelay: number;
    renewalWindow: number;
    maxFee: number;
    /** boarding only */
    boardingExitDelay?: number;
    cosignerPubKey: Uint8Array;
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

/** The emulator-enforced leaf is the Executor's to use; it is never offered. */
function paths(
    script: DefaultVtxo.Script,
    context: PathContext,
    checkTimelocks: boolean,
): PathSelection[] {
    const out: PathSelection[] = context.collaborative ? [{ leaf: script.forfeit() }] : [];
    const sequence = Number(timelockToSequence(script.options.csvTimelock));
    if (!checkTimelocks || isCsvSpendable(context, sequence)) {
        out.push({ leaf: script.exit(), sequence });
    }
    return out;
}

/**
 * Handler for the coins a wallet delegated to the Executor under its default templates:
 * virtual outputs at the renewal contract, which the Executor renews in place, and onchain
 * deposits at the boarding contract, which it boards to the renewal contract. The scripts derive
 * from the bundled templates, the owner key, the params and the Executor's keys, so a restored
 * wallet needs no round-trip to the Executor.
 *
 * - forfeit: (Owner + Operator) multisig, the wallet's collaborative path
 * - exit: (Owner) + CSV, the wallet's unilateral path
 * - renew/board: (Operator + Emulator), emulator-enforced, the Executor's; never offered
 */
export const ExecutorContractHandler: ContractHandler<ExecutorContractParams, DefaultVtxo.Script> =
    {
        type: "executor",

        /** The default script of the owner with the emulator-enforced leaf after forfeit and exit. */
        createScript(params: Record<string, string>): DefaultVtxo.Script {
            const p = this.deserializeParams(params);
            const derived = defaultContract(
                p.template,
                {
                    cosignerPubkey: hex.encode(p.cosignerPubKey),
                    serverPubkey: hex.encode(p.serverPubKey),
                    emulatorPubkey: hex.encode(p.emulatorPubKey),
                },
                p.owner,
                p,
            );
            const script = new DefaultVtxo.Script(
                {
                    pubKey: p.owner.subarray(1),
                    serverPubKey: p.serverPubKey.subarray(1),
                    csvTimelock: sequenceToTimelock(p.boardingExitDelay ?? p.exitDelay),
                },
                derived.scripts.slice(2),
            );
            if (!equalBytes(script.pkScript, derived.pkScript)) {
                throw new Error(
                    `delegated ${p.template} contract is not forfeit, exit and an emulator-enforced leaf`,
                );
            }
            return script;
        },

        serializeParams(params: ExecutorContractParams): Record<string, string> {
            return {
                template: params.template,
                owner: hex.encode(params.owner),
                exitDelay: params.exitDelay.toString(),
                renewalWindow: params.renewalWindow.toString(),
                maxFee: params.maxFee.toString(),
                ...(params.boardingExitDelay !== undefined
                    ? { boardingExitDelay: params.boardingExitDelay.toString() }
                    : {}),
                cosignerPubKey: hex.encode(params.cosignerPubKey),
                serverPubKey: hex.encode(params.serverPubKey),
                emulatorPubKey: hex.encode(params.emulatorPubKey),
            };
        },

        deserializeParams(params: Record<string, string>): ExecutorContractParams {
            if (!TEMPLATES.includes(params.template)) {
                throw new Error(`unknown Executor template ${params.template}`);
            }
            return {
                template: params.template as ExecutorDefault,
                owner: compressed(params.owner, "owner"),
                exitDelay: integer(params.exitDelay, "exitDelay"),
                renewalWindow: integer(params.renewalWindow, "renewalWindow"),
                maxFee: integer(params.maxFee, "maxFee"),
                ...(params.template === "boarding"
                    ? { boardingExitDelay: integer(params.boardingExitDelay, "boardingExitDelay") }
                    : {}),
                cosignerPubKey: compressed(params.cosignerPubKey, "cosignerPubKey"),
                serverPubKey: compressed(params.serverPubKey, "serverPubKey"),
                emulatorPubKey: compressed(params.emulatorPubKey, "emulatorPubKey"),
            };
        },

        selectPath(
            script: DefaultVtxo.Script,
            _contract: Contract,
            context: PathContext,
        ): PathSelection | null {
            return paths(script, context, true)[0] ?? null;
        },

        getAllSpendingPaths(
            script: DefaultVtxo.Script,
            _contract: Contract,
            context: PathContext,
        ): PathSelection[] {
            return paths(script, context, false);
        },

        getSpendablePaths(
            script: DefaultVtxo.Script,
            _contract: Contract,
            context: PathContext,
        ): PathSelection[] {
            return paths(script, context, true);
        },

        /** The wallet's own money, renewed by the service. */
        isGenericallySpendable: () => true,
    };
