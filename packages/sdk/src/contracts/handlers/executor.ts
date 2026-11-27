import { hex } from "@scure/base";
import { equalBytes } from "@scure/btc-signer/utils.js";
import { deriveDescriptorLeafPubKey } from "../../identity/descriptor";
import { DefaultVtxo } from "../../script/default";
import {
    defaultContract,
    type DelegationParams,
    type ExecutorContractKeys,
    type ExecutorDefault,
    type ExecutorWatchTemplate,
} from "../../script/executor/executorTemplate";
import { sequenceToTimelock } from "../../utils/timelock";
import {
    Contract,
    ContractHandler,
    Discoverable,
    DiscoveredContract,
    DiscoveryDeps,
    PathContext,
    PathSelection,
} from "../types";
import {
    detectUsedScripts,
    discoverAtViaRange,
    selectForfeitOrExitPath,
    forfeitExitAllPaths,
    forfeitExitSpendablePaths,
} from "./helpers";

/**
 * Typed parameters for delegated contracts: a default template's variables and an executor's
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
    batchCosignerPubKey: Uint8Array;
    operatorPubKey: Uint8Array;
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

/** `xOnly` as a compressed key; the scripts take the x-only key, so the parity is arbitrary. */
export function evenOwnerKey(xOnly: Uint8Array): Uint8Array {
    const key = new Uint8Array(33);
    key[0] = 2;
    key.set(xOnly, 1);
    return key;
}

/** The serialized params of `owner`'s `template` contract under an executor's `keys`. */
export function executorContractParams(
    template: ExecutorDefault,
    owner: Uint8Array,
    keys: ExecutorContractKeys,
    params: DelegationParams,
): Record<string, string> {
    return ExecutorContractHandler.serializeParams({
        template,
        owner,
        exitDelay: params.exitDelay,
        renewalWindow: params.renewalWindow,
        maxFee: params.maxFee,
        ...(template === "boarding" ? { boardingExitDelay: params.boardingExitDelay } : {}),
        batchCosignerPubKey: hex.decode(keys.batchCosignerPubkey),
        operatorPubKey: hex.decode(keys.operatorPubkey),
        emulatorPubKey: hex.decode(keys.emulatorPubkey),
    });
}

/** The executor keys a contract's params were derived from. */
export function executorKeysOf(p: ExecutorContractParams): ExecutorContractKeys {
    return {
        batchCosignerPubkey: hex.encode(p.batchCosignerPubKey),
        operatorPubkey: hex.encode(p.operatorPubKey),
        emulatorPubkey: hex.encode(p.emulatorPubKey),
    };
}

/**
 * Handler for the coins a wallet delegated to an executor under its default templates:
 * virtual outputs at the renewal contract, which the executor renews in place, and onchain
 * deposits at the boarding contract, which it boards to the renewal contract. The scripts derive
 * from the bundled templates, the owner key, the params and the executor's keys, so a restored
 * wallet needs no round-trip to the executor.
 *
 * - forfeit: (Owner + Operator) multisig, the wallet's function that needs the operator's signature
 * - exit: (Owner) + CSV, the wallet's exit path
 * - renew/board: (Operator + Emulator) multisig with Arkade Script, the executor's; never offered
 *
 * Restore probes every index under each of `deps.executorWatches`: an HD wallet registers a watch
 * per boarding key it rotates to.
 */
export const ExecutorContractHandler: ContractHandler<ExecutorContractParams, DefaultVtxo.Script> &
    Discoverable = {
    type: "executor",

    /** The owner's forfeit and exit functions, then the executor's function with Arkade Script. */
    createScript(params: Record<string, string>): DefaultVtxo.Script {
        const p = this.deserializeParams(params);
        const derived = defaultContract(p.template, executorKeysOf(p), p.owner, p);
        const script = new DefaultVtxo.Script(
            {
                pubKey: p.owner.subarray(1),
                serverPubKey: p.operatorPubKey.subarray(1),
                csvTimelock: sequenceToTimelock(p.boardingExitDelay ?? p.exitDelay),
            },
            derived.scripts.slice(2),
        );
        if (!equalBytes(script.pkScript, derived.pkScript)) {
            throw new Error(
                `delegated ${p.template} contract is not forfeit, exit and a function with Arkade Script`,
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
            batchCosignerPubKey: hex.encode(params.batchCosignerPubKey),
            // stored as serverPubKey, the name every contract type stores the operator pubkey under
            serverPubKey: hex.encode(params.operatorPubKey),
            emulatorPubKey: hex.encode(params.emulatorPubKey),
        };
    },

    deserializeParams(params: Record<string, string>): ExecutorContractParams {
        if (!TEMPLATES.includes(params.template)) {
            throw new Error(`unknown executor template ${params.template}`);
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
            // rows stored before the key rename in 0.5.15 hold it as cosignerPubKey
            batchCosignerPubKey: compressed(
                params.batchCosignerPubKey ?? params.cosignerPubKey,
                "batchCosignerPubKey",
            ),
            operatorPubKey: compressed(params.serverPubKey, "serverPubKey"),
            emulatorPubKey: compressed(params.emulatorPubKey, "emulatorPubKey"),
        };
    },

    selectPath(
        script: DefaultVtxo.Script,
        contract: Contract,
        context: PathContext,
    ): PathSelection | null {
        return selectForfeitOrExitPath(script, contract, context);
    },

    getAllSpendingPaths(
        script: DefaultVtxo.Script,
        contract: Contract,
        context: PathContext,
    ): PathSelection[] {
        return forfeitExitAllPaths(script, contract, context);
    },

    getSpendablePaths(
        script: DefaultVtxo.Script,
        contract: Contract,
        context: PathContext,
    ): PathSelection[] {
        return forfeitExitSpendablePaths(script, contract, context);
    },

    /** The wallet's own money, renewed by the service. */
    isGenericallySpendable: () => true,

    discoverAt: discoverAtViaRange(discoverExecutorRange),

    discoverRange: discoverExecutorRange,
};

/**
 * Both contracts of a watch at every index where either is used: its renewal contract holds
 * boarded coins, its boarding contract coins not boarded yet.
 */
async function discoverExecutorRange(
    entries: readonly { index: number; descriptor: string }[],
    deps: DiscoveryDeps,
): Promise<Map<number, DiscoveredContract[]>> {
    const out = new Map<number, DiscoveredContract[]>(entries.map((e) => [e.index, []]));
    const watches = deps.executorWatches ?? [];
    if (watches.length === 0) return out;
    const pairs = entries.flatMap(({ index, descriptor }) =>
        watches.map((watch) => ({
            index,
            renewal: discovered("renewal", descriptor, watch, deps),
            boarding:
                watch.params.boardingExitDelay === undefined
                    ? undefined
                    : discovered("boarding", descriptor, watch, deps),
        })),
    );
    const onchain = deps.onchainNetwork;
    const [used, funded] = await Promise.all([
        detectUsedScripts(
            deps.indexerProvider,
            pairs.map((p) => p.renewal.contract.script),
        ),
        Promise.all(
            pairs.map(async ({ boarding }) =>
                boarding && onchain
                    ? (await deps.onchainProvider.getCoins(boarding.script.onchainAddress(onchain)))
                          .length > 0
                    : false,
            ),
        ),
    ]);
    pairs.forEach(({ index, renewal, boarding }, i) => {
        if (!used.has(renewal.contract.script) && !funded[i]) return;
        out.get(index)!.push(renewal.contract, ...(boarding ? [boarding.contract] : []));
    });
    return out;
}

function discovered(
    template: ExecutorDefault,
    descriptor: string,
    { keys, params }: ExecutorWatchTemplate,
    deps: DiscoveryDeps,
): { contract: DiscoveredContract; script: DefaultVtxo.Script } {
    const owner = evenOwnerKey(deriveDescriptorLeafPubKey(descriptor));
    const serialized = executorContractParams(template, owner, keys, params);
    const script = ExecutorContractHandler.createScript(serialized);
    return {
        script,
        contract: {
            type: ExecutorContractHandler.type,
            params: serialized,
            script: hex.encode(script.pkScript),
            address: script
                .address(deps.network.hrp, hex.decode(keys.operatorPubkey).subarray(1))
                .encode(),
            scope: template === "boarding" ? "onchain" : "offchain",
            label: template === "renewal" ? "Delegated renewal" : "Delegated boarding",
            metadata: { signingDescriptor: descriptor },
        },
    };
}
