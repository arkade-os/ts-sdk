import { hex } from "@scure/base";
import { ScriptNum } from "@scure/btc-signer";
import { canSpendOffchain, type IWallet } from "../wallet";
import { toXOnly } from "../utils/keys";
import { resolvePrevTxs } from "../utils/prevoutTx";
import { Transaction } from "../utils/transaction";
import { Extension } from "../extension";
import { Packet as AssetPacket } from "../extension/asset";
import type { DelegateeProvider, DelegateeDelegation } from "../providers/delegatee";
import { programFromArtifact, type ContractArtifact } from "./artifact";
import { Arkade, ArkadeContract, type ArkadeParamValue, type ArkadeSpendResult } from "./contract";
import { resolveAsm, resolveTimelockValue, type ArkadeFunction, type Program } from "./program";
import { ArkadeScript, type ArkadeScriptOP } from "./script";
import * as BigNum from "./bignum";
import type { EmulatorSubmitOptions } from "../utils/arkTransaction";

type ObjectValue = Record<string, unknown>;
type DelegationBinding = {
    document: string;
    artifact: string;
    artifactReference: boolean;
    variables: Readonly<Record<string, string>>;
};
const scriptNum = ScriptNum(undefined, true);
const executionTails = new WeakMap<IWallet, Promise<unknown>>();

function object(value: unknown, allowed: string[], required: string[] = []): ObjectValue {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("NativeExecutor: expected an object");
    }
    const result = value as ObjectValue;
    for (const key of Object.keys(result)) {
        if (!allowed.includes(key)) throw new Error(`NativeExecutor: unsupported field '${key}'`);
    }
    for (const key of required) {
        if (!Object.hasOwn(result, key)) throw new Error(`NativeExecutor: missing '${key}'`);
    }
    return result;
}

function bytes(value: unknown, variables: Record<string, string>): Uint8Array {
    if (typeof value !== "string") throw new Error("NativeExecutor: expected a hex binding");
    const match = /^<([a-zA-Z_][a-zA-Z0-9_]*)>$/.exec(value);
    const encoded = match ? variables[match[1]] : value;
    if (encoded === undefined || !/^(?:[0-9a-f]{2})*$/.test(encoded)) {
        throw new Error(`NativeExecutor: invalid or unbound hex '${value}'`);
    }
    return hex.decode(encoded);
}

function taproot(destination: Uint8Array): Uint8Array {
    if (destination.length !== 34 || destination[0] !== 0x51 || destination[1] !== 0x20) {
        throw new Error("NativeExecutor: destination must be a Taproot output script");
    }
    return destination;
}

const comparisons: Record<string, (actual: bigint, bound: bigint) => boolean> = {
    NUMEQUAL: (a, b) => a === b,
    NUMEQUALVERIFY: (a, b) => a === b,
    NUMNOTEQUAL: (a, b) => a !== b,
    LESSTHAN: (a, b) => a < b,
    LESSTHANOREQUAL: (a, b) => a <= b,
    GREATERTHAN: (a, b) => a > b,
    GREATERTHANOREQUAL: (a, b) => a >= b,
};

function scriptNumber(op: ArkadeScriptOP | undefined): bigint | undefined {
    if (typeof op === "number") return BigInt(op);
    if (!(op instanceof Uint8Array)) return undefined;
    try {
        return BigNum.decode(op);
    } catch {
        return undefined;
    }
}

/**
 * The SDK cannot evaluate a covenant, so a check on a transaction field the executor fixes is
 * accepted only as `<field> <number> <comparison>` whose result must hold; any other use rejects.
 */
function covenantShape(fn: ArkadeFunction, args: Record<string, ArkadeParamValue>): void {
    // What buildOffchainTx produces for one input paying payout + extension + anchor.
    const fields: Record<string, bigint> = {
        INSPECTVERSION: 3n,
        INSPECTLOCKTIME:
            fn.tapscript.cltv === undefined ? 0n : resolveTimelockValue(fn.tapscript.cltv, args),
        INSPECTNUMINPUTS: 1n,
        INSPECTNUMOUTPUTS: 3n,
    };
    const ops = ArkadeScript.decode(resolveAsm(fn.arkadeScript!.asm, args));
    for (const [i, op] of ops.entries()) {
        if (typeof op !== "string" || !Object.hasOwn(fields, op)) continue;
        const bound = scriptNumber(ops[i + 1]);
        const compare = ops[i + 2];
        const enforced =
            compare === "NUMEQUALVERIFY" || ops[i + 3] === "VERIFY" || i + 3 === ops.length;
        if (
            bound === undefined ||
            typeof compare !== "string" ||
            !Object.hasOwn(comparisons, compare) ||
            !enforced ||
            !comparisons[compare](fields[op], bound)
        ) {
            throw new Error(
                "NativeExecutor: the covenant checks the transaction version, locktime or input/output count in a form the executor cannot satisfy",
            );
        }
    }
}

function nativeFunction(
    program: Program,
    name: string,
    args: Record<string, ArkadeParamValue>,
): void {
    const fn = Object.hasOwn(program.functions, name) ? program.functions[name] : undefined;
    if (
        !fn?.arkadeScript ||
        fn.group !== name ||
        Object.values(program.functions).filter((f) => f.group === name).length !== 1 ||
        fn.inputs?.length ||
        fn.arkadeScript.witness?.length ||
        fn.tapscript.witness?.length ||
        fn.tapscript.signatures?.length ||
        fn.tapscript.asm?.length ||
        fn.tapscript.csv ||
        fn.tapscript.emulator !== name ||
        fn.tapscript.signers.some((s) => s !== "$server")
    ) {
        throw new Error(
            "NativeExecutor: the selected leaf requires unsupported conditions, witnesses, signers or CSV",
        );
    }
    covenantShape(fn, args);
}

function hasPlan(saved: unknown): saved is { plan: unknown } {
    return !!saved && typeof saved === "object" && Object.hasOwn(saved, "plan");
}

function readPlan(value: unknown): { functionName: string; destination: Uint8Array } {
    const plan = object(
        value,
        ["version", "functionName", "destinationHex"],
        ["version", "functionName", "destinationHex"],
    );
    if (plan.version !== 1)
        throw new Error("NativeExecutor: unsupported native execution plan version");
    if (typeof plan.functionName !== "string" || !plan.functionName) {
        throw new Error("NativeExecutor: invalid native execution function");
    }
    return {
        functionName: plan.functionName,
        destination: taproot(bytes(plan.destinationHex, {})),
    };
}

/** An imported template, persisted with its existing Arkade contract. */
export interface NativeExecution {
    readonly contract: ArkadeContract;
    readonly functionName: string;
    readonly destination: Uint8Array;
}

/**
 * SDK-native execution of a deliberately bounded delegateed-template/v1 subset:
 * one offchain input, a zero-argument covenant, and one full-value output.
 * Unsupported schedules, secrets, asset routes, expressions and packet policies
 * fail closed. Batch intents continue to use Wallet.settle/Batch and its durable
 * intent repository. No second wallet, repository, scheduler or daemon is created.
 */
export class NativeExecutor {
    private readonly imported = new WeakMap<
        NativeExecution,
        { destination: Uint8Array; delegation?: DelegationBinding }
    >();

    constructor(
        readonly arkade: Arkade,
        readonly wallet: IWallet,
    ) {}

    private async manager() {
        const manager = await this.wallet.getContractManager();
        if (manager !== this.arkade.contractManager) {
            throw new Error(
                "NativeExecutor: connect Arkade with the wallet's existing contract manager",
            );
        }
        return manager;
    }

    async importTemplate(
        document: unknown,
        artifacts: Readonly<Record<string, ContractArtifact>> = {},
        variables: Record<string, string> = {},
    ): Promise<NativeExecution> {
        if (!this.arkade.indexer) throw new Error("NativeExecutor: an indexer is required");
        const t = object(
            document,
            ["format", "type", "variables", "inputs", "outputs", "fees", "packets"],
            ["format", "type", "inputs", "outputs", "packets"],
        );
        if (t.format !== "delegateed-template/v1" || t.type !== "offchain") {
            throw new Error(
                "NativeExecutor: only delegateed-template/v1 offchain templates are supported",
            );
        }
        const declarations = object(t.variables ?? {}, Object.keys((t.variables ?? {}) as object));
        for (const [name, type] of Object.entries(declarations)) {
            if (!["pubkey", "bytes", "bytes20", "bytes32", "int", "bool"].includes(String(type))) {
                throw new Error(`NativeExecutor: unsupported variable type '${type}'`);
            }
            bytes(`<${name}>`, variables);
        }
        for (const name of Object.keys(variables)) {
            if (!Object.hasOwn(declarations, name))
                throw new Error(`NativeExecutor: undeclared variable '${name}'`);
        }
        if (
            !Array.isArray(t.inputs) ||
            t.inputs.length !== 1 ||
            !Array.isArray(t.outputs) ||
            t.outputs.length !== 1
        ) {
            throw new Error("NativeExecutor: exactly one input and one output are supported");
        }
        const input = object(
            t.inputs[0],
            ["name", "contract", "spend", "schedule"],
            ["name", "contract", "spend"],
        );
        if (typeof input.name !== "string" || !input.name)
            throw new Error("NativeExecutor: invalid input name");
        if (input.schedule !== undefined) {
            const schedule = object(input.schedule, ["immediate"], ["immediate"]);
            if (schedule.immediate !== true)
                throw new Error("NativeExecutor: only immediate execution is supported");
        }
        const construction = object(input.contract, ["definition", "arguments"], ["definition"]);
        const definition = construction.definition as ObjectValue;
        const artifact =
            definition && Object.hasOwn(definition, "artifact")
                ? artifacts[String(object(definition, ["artifact"], ["artifact"]).artifact)]
                : (construction.definition as ContractArtifact);
        if (!artifact) throw new Error("NativeExecutor: missing compiler artifact");
        const program = programFromArtifact(artifact);
        const bindings = object(
            construction.arguments ?? {},
            artifact.constructorInputs.map((p) => p.name),
        );
        const args: Record<string, ArkadeParamValue> = {};
        for (const param of artifact.constructorInputs) {
            const raw = bytes(bindings[param.name], variables);
            if (param.type === "int" || param.type === "bool")
                args[param.name] = scriptNum.decode(raw);
            else if (param.type === "pubkey") args[param.name] = toXOnly(raw, param.name);
            else if (["bytes", "bytes20", "bytes32"].includes(param.type)) args[param.name] = raw;
            else throw new Error(`NativeExecutor: unsupported constructor type '${param.type}'`);
        }
        const spend = object(input.spend, ["function", "leaf"], ["function", "leaf"]);
        const group = artifact.functions.find((f) => f.name === spend.function);
        if (
            !group?.arkade ||
            group.arkade.inputs.length ||
            group.leaves.length !== 1 ||
            group.leaves[0].name !== spend.leaf
        ) {
            throw new Error("NativeExecutor: expected one zero-argument covenant leaf");
        }
        const functionName = String(spend.function);
        nativeFunction(program, functionName, args);
        const contract = this.arkade.contract(program, args);
        const output = object(
            t.outputs[0],
            ["name", "index", "value", "locking"],
            ["name", "index", "value", "locking"],
        );
        if (typeof output.name !== "string" || output.index !== 0)
            throw new Error("NativeExecutor: expected output index 0");
        const value = object(output.value, ["from"], ["from"]);
        if (value.from !== input.name)
            throw new Error("NativeExecutor: output must preserve the input's full value");
        let destination: Uint8Array;
        if (typeof output.locking === "string") destination = bytes(output.locking, variables);
        else {
            const locking = object(output.locking, ["from"], ["from"]);
            if (locking.from !== input.name)
                throw new Error("NativeExecutor: unknown locking source");
            destination = contract.pkScript;
        }
        taproot(destination);
        if (t.fees !== undefined) {
            const fees = object(t.fees, ["from", "max"], ["from", "max"]);
            if (fees.from !== input.name || fees.max !== 0)
                throw new Error("NativeExecutor: only zero-fee offchain execution is supported");
        }
        const packets = object(t.packets, ["output_index"], ["output_index"]);
        if (packets.output_index !== 1)
            throw new Error("NativeExecutor: emulator extension must be output 1");
        const delegation: DelegationBinding = {
            document: JSON.stringify(document),
            artifact: JSON.stringify(artifact),
            artifactReference: Object.hasOwn(definition, "artifact"),
            variables: Object.freeze({ ...variables }),
        };
        destination = destination.slice();
        const metadata = () => ({
            genericallySpendable: false,
            nativeExecution: {
                document: JSON.parse(delegation.document),
                variables: { ...delegation.variables },
                plan: { version: 1, functionName, destinationHex: hex.encode(destination) },
            },
        });
        return this.serialize(async () => {
            const manager = await this.manager();
            let registered = await contract.register({ metadata: metadata() });
            if (
                registered.script !== hex.encode(contract.pkScript) ||
                registered.address !== contract.address
            ) {
                throw new Error(
                    "NativeExecutor: registered contract does not match derived script or address",
                );
            }
            if (registered.metadata?.genericallySpendable === true) {
                throw new Error("NativeExecutor: existing contract permits generic spending");
            }
            if (!hasPlan(registered.metadata?.nativeExecution)) {
                // An earlier register() or on() saved the row without a plan; restore() needs one.
                registered = await manager.updateContract(registered.script, {
                    metadata: { ...registered.metadata, ...metadata() },
                });
            }
            const saved = registered.metadata?.nativeExecution;
            if (!hasPlan(saved)) {
                throw new Error("NativeExecutor: native execution plan was not persisted");
            }
            const plan = readPlan(saved.plan);
            if (
                plan.functionName !== functionName ||
                hex.encode(plan.destination) !== hex.encode(destination)
            ) {
                throw new Error(
                    "NativeExecutor: conflicting native execution plan for existing contract",
                );
            }
            return this.own(contract, functionName, destination, delegation);
        });
    }

    /**
     * Restore the authoritative versioned plan using the contract's stored keys.
     * The original template is inspection data; no registration or refresh occurs.
     * Re-import the original template, artifacts and variables before remote delegation.
     */
    async restore(script: string): Promise<NativeExecution> {
        const manager = await this.manager();
        const lookup = hex.encode(taproot(bytes(script, {})));
        const [stored] = await manager.getContracts({ script: lookup });
        if (!stored || stored.script !== lookup)
            throw new Error("NativeExecutor: contract not found");
        if (stored.type !== "arkade")
            throw new Error("NativeExecutor: expected an arkade contract");
        if (stored.metadata?.genericallySpendable === true) {
            throw new Error("NativeExecutor: existing contract permits generic spending");
        }
        const saved = stored.metadata?.nativeExecution;
        if (!hasPlan(saved)) throw new Error("NativeExecutor: no persisted native execution plan");
        const { functionName, destination } = readPlan(saved.plan);
        const contract = ArkadeContract.fromContract(this.arkade, stored);
        if (hex.encode(contract.pkScript) !== lookup || contract.address !== stored.address) {
            throw new Error(
                "NativeExecutor: restored contract does not match stored script or address",
            );
        }
        nativeFunction(contract.program, functionName, contract.args);
        return this.own(contract, functionName, destination);
    }

    private own(
        contract: ArkadeContract,
        functionName: string,
        destination: Uint8Array,
        delegation?: DelegationBinding,
    ): NativeExecution {
        const execution = Object.freeze({
            contract,
            functionName,
            destination: destination.slice(),
        });
        this.imported.set(execution, { destination: destination.slice(), delegation });
        return execution;
    }

    /** Preserve Wallet.send's coin selection, reservations, signing and recovery. */
    async fund(execution: NativeExecution, amount: number): Promise<string> {
        await this.manager();
        this.check(execution);
        return this.wallet.send({ address: execution.contract.address, amount });
    }

    /** Delegate the template and variables captured at import; restored handles require re-import. */
    async delegate(
        execution: NativeExecution,
        provider: DelegateeProvider,
        expiresAt = 0,
    ): Promise<DelegateeDelegation> {
        if (!Number.isSafeInteger(expiresAt) || expiresAt < 0)
            throw new Error("NativeExecutor: invalid expiry");
        this.check(execution);
        const binding = this.imported.get(execution)!.delegation;
        if (!binding) throw new Error("NativeExecutor: re-import the template before delegation");
        await this.manager();
        const info = await provider.getInfo();
        const key = (encoded: string) => hex.encode(toXOnly(hex.decode(encoded), "delegatee key"));
        const { serverKey, emulatorKey } = execution.contract.keys;
        if (
            key(info.serverPubkey) !== hex.encode(toXOnly(serverKey, "contract server key")) ||
            !emulatorKey ||
            key(info.emulatorPubkey) !== hex.encode(toXOnly(emulatorKey, "contract emulator key"))
        ) {
            throw new Error(
                "NativeExecutor: delegatee keys differ from the contract's stored keys",
            );
        }
        const document = JSON.parse(binding.document);
        if (binding.artifactReference) {
            const artifact = await provider.registerArtifact(JSON.parse(binding.artifact));
            if (typeof artifact.id !== "string" || !artifact.id)
                throw new Error("NativeExecutor: invalid registered artifact ID");
            document.inputs[0].contract.definition = { artifact: artifact.id };
        }
        const template = await provider.registerTemplate(document);
        if (typeof template.id !== "string" || !template.id)
            throw new Error("NativeExecutor: invalid registered template ID");
        const delegation = await provider.registerDelegation(
            template.id,
            { ...binding.variables },
            expiresAt,
        );
        if (delegation.address !== execution.contract.address || delegation.status !== "active") {
            throw new Error(
                "NativeExecutor: delegatee returned a different address or an inactive watch",
            );
        }
        return delegation;
    }

    /** Re-read the specified coin; never auto-select a different position on retry. */
    async execute(
        execution: NativeExecution,
        outpoint: { txid: string; vout: number },
        options?: EmulatorSubmitOptions,
    ): Promise<ArkadeSpendResult> {
        const sourceOutpoint = Object.freeze({ txid: outpoint?.txid, vout: outpoint?.vout });
        if (
            typeof sourceOutpoint.txid !== "string" ||
            !/^[0-9a-f]{64}$/.test(sourceOutpoint.txid) ||
            !Number.isInteger(sourceOutpoint.vout) ||
            sourceOutpoint.vout < 0 ||
            sourceOutpoint.vout > 0xffffffff
        ) {
            throw new Error("NativeExecutor: invalid source outpoint");
        }
        const beforeEmulatorSubmit = options?.beforeEmulatorSubmit;
        return this.serialize(async () => {
            const manager = await this.manager();
            this.check(execution);
            await manager.refreshOutpoints([sourceOutpoint]);
            const coin = (await execution.contract.getUtxos()).find(
                (v) => v.txid === sourceOutpoint.txid && v.vout === sourceOutpoint.vout,
            );
            if (
                !coin ||
                !canSpendOffchain(coin, { timestamp: new Date() }) ||
                (coin.assets?.length ?? 0) > 0
            ) {
                throw new Error(
                    "NativeExecutor: position is missing, spent, expired, swept, unrolled or contains assets",
                );
            }
            const indexer = this.arkade.indexer;
            if (!indexer) throw new Error("NativeExecutor: an indexer is required");
            const sourceTx = (await resolvePrevTxs([coin.txid], indexer)).get(coin.txid)!;
            const source = Transaction.fromRaw(sourceTx);
            const output = source.getOutput(coin.vout);
            if (
                source.id !== coin.txid ||
                output.amount !== BigInt(coin.value) ||
                !output.script ||
                hex.encode(output.script) !== hex.encode(execution.contract.pkScript)
            ) {
                throw new Error(
                    "NativeExecutor: creating transaction does not match the tracked position",
                );
            }
            let extensions = 0;
            for (let i = 0; i < source.outputsLength; i++) {
                const script = source.getOutput(i).script;
                if (!script || !Extension.isExtension(script)) continue;
                if (++extensions > 1) throw new Error("NativeExecutor: multiple source extensions");
                for (const packet of Extension.fromBytes(script).getPackets()) {
                    // Wallet.send may put asset change beside a BTC-only position.
                    if (packet instanceof AssetPacket) {
                        if (packet.groups.some((g) => g.outputs.some((o) => o.vout === coin.vout)))
                            throw new Error("NativeExecutor: position carries assets");
                        continue;
                    }
                    // Delegatee regenerates emulator (1) and consumes advertisement (5).
                    // This subset cannot route assets or application packets.
                    if (packet.type() !== 1 && packet.type() !== 5) {
                        throw new Error(
                            `NativeExecutor: source carries unsupported packet ${packet.type()}`,
                        );
                    }
                }
            }
            const result = await execution.contract.functions[execution.functionName]()
                .from({ ...coin, sourceTx })
                .to(this.imported.get(execution)!.destination.slice(), BigInt(coin.value))
                .send({ beforeEmulatorSubmit });
            try {
                await manager.refreshOutpoints([sourceOutpoint]);
                await manager.refreshVtxos();
            } catch (error) {
                console.warn("NativeExecutor: refresh after accepted spend failed", error);
            }
            return result;
        });
    }

    /** Native imports and executions sharing one wallet object run one at a time. */
    private serialize<T>(task: () => Promise<T>): Promise<T> {
        const run = (executionTails.get(this.wallet) ?? Promise.resolve()).then(task);
        executionTails.set(
            this.wallet,
            run.catch(() => undefined),
        );
        return run;
    }

    private check(execution: NativeExecution): void {
        if (!this.imported.has(execution))
            throw new Error("NativeExecutor: template belongs to another executor");
    }
}
