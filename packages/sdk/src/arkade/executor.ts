import { hex } from "@scure/base";
import { equalBytes } from "@scure/btc-signer/utils.js";
import { canSpendOffchain, type IWallet, normalizeVtxo } from "../wallet";
import { toXOnly } from "../utils/keys";
import { resolvePrevTxs } from "../utils/prevoutTx";
import { Transaction } from "../utils/transaction";
import {
    buildOffchainTx,
    submitViaEmulator,
    type EmulatorSubmitOptions,
    type OffchainTx,
} from "../utils/arkTransaction";
import {
    ConditionWitness,
    getArkPsbtFields,
    PrevArkTxField,
    setArkPsbtField,
    VtxoTaprootTree,
} from "../utils/unknownFields";
import type { CSVMultisigTapscript } from "../script/tapscript";
import { Extension } from "../extension";
import { vmExtensionCodec } from "../extension/vmCodec";
import { evenOwnerKey } from "../contracts/handlers/executor";
import {
    type ExecutorDelegation,
    type ExecutorProvider,
    ExecutorRequestError,
} from "../providers/executor";
import { programFromArtifact, type ContractArtifact } from "./artifact";
import { Arkade, ArkadeContract, type ArkadeParamValue, type ArkadeSpendResult } from "./contract";
import { ARKADE_TYPE_ENCODINGS } from "./program";
import * as BigNum from "./bignum";
import {
    type Action,
    compile,
    type ContractKeys,
    decode,
    decodeArtifact,
    type Document,
    type Instance,
    instantiate,
    type Template,
} from "./template";
import { seal } from "./template/ecies";
import { emulateOffchainTx, ExecutionError } from "./vm";

/** What a contract row persists to rebuild its template offline and delegate it. */
interface Saved {
    version: 2;
    /** The canonical template/v1 text. */
    document: string;
    /** The artifacts the document references, by id, as JSON text. */
    artifacts: Record<string, string>;
    /** Lowercase hex; a sealed variable holds its plaintext. */
    variables: Record<string, string>;
    templateId: string;
    spendId: string;
}

interface Prepared {
    doc: Document;
    template: Template;
    instance: Instance;
}

/** A coin a template spends; `tx` is the raw transaction that created it. */
export interface NativeCoin {
    txid: string;
    vout: number;
    value: number;
    tx: Uint8Array;
}

const executionTails = new WeakMap<IWallet, Promise<unknown>>();
const utf8 = new TextEncoder();
const text = new TextDecoder();
const HEX = /^(?:[0-9a-f]{2})*$/;
const ID = /^[0-9a-f]{64}$/;
const FUTURE = 2 ** 40;
const SAVED_KEYS = "artifacts,document,spendId,templateId,variables,version";

const isRecord = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);

const strings = (v: unknown): v is Record<string, string> =>
    isRecord(v) && Object.values(v).every((s) => typeof s === "string");

const isLegacy = (v: unknown): boolean => isRecord(v) && isRecord(v.plan) && v.plan.version === 1;

function jsonText(value: unknown, what: string): string {
    if (typeof value === "string") return value;
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string") throw new Error(`NativeExecutor: ${what} is not JSON`);
    return encoded;
}

function readSaved(value: unknown): Saved {
    if (value === undefined) throw new Error("NativeExecutor: no persisted native execution plan");
    if (isLegacy(value)) {
        throw new Error(
            "NativeExecutor: this contract holds a native execution plan in the unreleased pre-release format; re-import the template",
        );
    }
    if (
        !isRecord(value) ||
        Object.keys(value).sort().join() !== SAVED_KEYS ||
        value.version !== 2 ||
        typeof value.document !== "string" ||
        typeof value.templateId !== "string" ||
        !ID.test(value.templateId) ||
        typeof value.spendId !== "string" ||
        !ID.test(value.spendId) ||
        !strings(value.artifacts) ||
        !strings(value.variables)
    ) {
        throw new Error("NativeExecutor: unsupported native execution plan");
    }
    return value as unknown as Saved;
}

const sameVariables = (a: Record<string, string>, b: Record<string, string>) =>
    JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** decode → compile → instantiate the watch, refusing what the wallet cannot spend alone. */
function prepare(saved: Saved, keys: ContractKeys): Prepared {
    const doc = decode(utf8.encode(saved.document));
    const given = doc.artifactIds.filter((id) => Object.hasOwn(saved.artifacts, id));
    const template = compile(
        doc,
        new Map(given.map((id) => [id, decodeArtifact(utf8.encode(saved.artifacts[id]))])),
    );
    if (template.type !== "virtual") {
        throw new Error(
            `NativeExecutor: ${template.type} templates are built by the template engine but not proven natively yet`,
        );
    }
    if (template.inputs.length !== 1) {
        throw new Error("NativeExecutor: exactly one input is supported");
    }
    const [input] = template.inputs;
    if (
        !input.selected.arkade ||
        !input.selectedLeaf.asm.some((token) => token.startsWith("<EMULATOR_KEY:"))
    ) {
        throw new Error(
            "NativeExecutor: the spent leaf has no covenant for the emulator to co-sign",
        );
    }
    // arkd rebuilds a virtual input's sequence as final, so it refuses a leaf with a relative
    // timelock; the engine and the dry run accept one, and funds would only unlock by exit.
    if (input.selectedLeaf.asm.some((t) => t === "OP_CHECKSEQUENCEVERIFY" || t === "OP_NOP3")) {
        throw new Error("NativeExecutor: arkd refuses a virtual spend through a CSV leaf");
    }
    if (template.requiredKeys.cosigner) {
        throw new Error("NativeExecutor: the template needs the Executor's cosigner key");
    }
    if (input.contract.taptree !== undefined) {
        throw new Error(
            "NativeExecutor: a supplied taptree cannot be stored as an arkade contract",
        );
    }
    const variables: Record<string, Uint8Array> = {};
    for (const [name, value] of Object.entries(saved.variables)) {
        if (typeof value !== "string" || !HEX.test(value)) {
            throw new Error(`NativeExecutor: variable '${name}' is not lowercase hex`);
        }
        variables[name] = hex.decode(value);
    }
    const instance = instantiate(template, { keys, variables });
    instance.offlineSpend(false);
    return { doc, template, instance };
}

// programFromArtifact wants each witness item's per-type encoding (raw-32 for bytes32) where
// template/v1 also allows raw; witness metadata never reaches the taproot tree.
function withoutEncodings(artifact: ContractArtifact): ContractArtifact {
    return {
        ...artifact,
        functions: artifact.functions.map((fn) => ({
            ...fn,
            leaves: fn.leaves.map((leaf) => ({
                ...leaf,
                witness: leaf.witness?.map(({ encoding: _, ...item }) => item),
            })),
        })),
    };
}

/** The input contract as the "arkade" handler re-derives it; it must lock the engine's script. */
function arkadeContract(arkade: Arkade, saved: Saved, { template, instance }: Prepared) {
    const name = template.inputs[0].name;
    const inputs = JSON.parse(saved.document).inputs as {
        name: string;
        contract: { definition: Record<string, unknown> };
    }[];
    const definition = inputs.find((i) => i.name === name)!.contract.definition;
    const artifact = Object.hasOwn(definition, "artifact")
        ? JSON.parse(saved.artifacts[definition.artifact as string])
        : definition;
    const bound: Record<string, ArkadeParamValue> = {};
    for (const { value: raw, ...field } of instance.contractArguments(0)) {
        const encoding = ARKADE_TYPE_ENCODINGS[field.type as keyof typeof ARKADE_TYPE_ENCODINGS];
        bound[field.name] =
            encoding === "scriptnum"
                ? BigNum.decode(raw)
                : field.type === "pubkey"
                  ? toXOnly(raw, field.name)
                  : raw;
    }
    const contract = arkade.contract(programFromArtifact(withoutEncodings(artifact)), bound);
    if (!equalBytes(contract.pkScript, instance.pkScript(0))) {
        throw new Error(
            "NativeExecutor: the template's contract does not derive as an arkade contract",
        );
    }
    return contract;
}

/**
 * The executor's BuildOffchain + forEmulator: `action`'s outputs as they are, each input's leaf,
 * taptree and condition witness from the logical PSBT, and the transaction that created its coin.
 */
export function nativeOffchainTx(
    action: Action,
    coins: readonly NativeCoin[],
    checkpoint: CSVMultisigTapscript.Type,
): OffchainTx {
    const logical = Transaction.fromPSBT(action.psbt);
    const inputs = coins.map((coin, i) => {
        const leaf = logical.getInput(i).tapLeafScript?.[0];
        const [tapTree] = getArkPsbtFields(logical, i, VtxoTaprootTree);
        if (!leaf || !tapTree) {
            throw new Error(`NativeExecutor: template input ${i} lacks its leaf or taptree`);
        }
        return {
            txid: coin.txid,
            vout: coin.vout,
            value: coin.value,
            tapLeafScript: leaf,
            tapTree,
        };
    });
    const outputs = Array.from({ length: logical.outputsLength }, (_, k) => logical.getOutput(k));
    const spent = coins.reduce((sum, coin) => sum + BigInt(coin.value), 0n);
    const paid = outputs.reduce((sum, output) => sum + (output.amount ?? 0n), 0n);
    // offchain.BuildTxs, not BuildTxsWithFee
    if (paid !== spent) throw new Error(`NativeExecutor: the template pays ${paid} of ${spent}`);
    const offchain = buildOffchainTx(inputs, outputs, checkpoint);
    coins.forEach((coin, i) => {
        const [witness] = getArkPsbtFields(logical, i, ConditionWitness);
        if (witness) {
            setArkPsbtField(offchain.arkTx, i, ConditionWitness, witness);
            setArkPsbtField(offchain.checkpoints[i], 0, ConditionWitness, witness);
        }
        setArkPsbtField(offchain.arkTx, i, PrevArkTxField, coin.tx);
    });
    return offchain;
}

/** Builds the spend of `coin` and runs it as the emulator's EmulateOffchainTx would. */
function dryRun(
    { instance }: Prepared,
    coin: NativeCoin & { expiry?: number; createdAt?: number },
    dust: bigint,
    checkpoint: CSVMultisigTapscript.Type,
    now?: number,
): OffchainTx {
    const { txid, vout, tx, expiry, createdAt } = coin;
    const action = instance.build(
        [{ txid, vout, tx, amount: BigInt(coin.value), expiry, createdAt }],
        { dust },
    );
    const offchain = nativeOffchainTx(action, [coin], checkpoint);
    const requests = emulateOffchainTx({
        arkPsbt: offchain.arkTx.toPSBT(),
        checkpoints: offchain.checkpoints.map((c) => c.toPSBT()),
        vtxoExpiries: new Map(
            coin.expiry === undefined ? [] : [[`${coin.txid}:${coin.vout}`, BigInt(coin.expiry)]],
        ),
        codec: vmExtensionCodec,
        now: now === undefined ? undefined : BigInt(now),
    });
    if (requests.length === 0) throw new Error("the emulator has nothing to sign");
    return offchain;
}

function reason(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    for (let e: unknown = error; e instanceof Error; e = e.cause) {
        if (e instanceof ExecutionError) return `${e.opcode} at position ${e.position}: ${message}`;
    }
    return message;
}

/** Whether the Executor already holds the template, active; a template id names one document. */
async function installed(remote: Required<ExecutorProvider>, id: string): Promise<boolean> {
    try {
        const found = await remote.getTemplate(id);
        if (found.id !== id) {
            throw new Error(`NativeExecutor: the Executor returned template ${found.id} for ${id}`);
        }
        if (found.status !== "active") {
            throw new Error(`NativeExecutor: template ${id} is ${found.status} on the Executor`);
        }
        return true;
    } catch (error) {
        if (error instanceof ExecutorRequestError && error.status === 404) return false;
        throw error;
    }
}

/** An imported template, persisted with its Arkade contract. */
export interface NativeExecution {
    readonly contract: ArkadeContract;
    /** The function whose leaf the template spends. */
    readonly functionName: string;
    readonly templateId: string;
    readonly spendId: string;
    readonly type: "virtual";
}

/**
 * Runs a template/v1 `virtual` spend of one coin in the wallet, as the Executor would build it,
 * after a dry run of its covenant; or hands the same template to an Executor. Funding goes through
 * the wallet and the contract through its existing contract manager.
 */
export class NativeExecutor {
    private readonly imported = new WeakMap<NativeExecution, Prepared & { saved: Saved }>();

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

    /**
     * `document` is template/v1 JSON, as an object or text; `variables` are lowercase hex, a sealed
     * one as its plaintext. Refuses anything but a one-input `virtual` spend the server and the
     * emulator sign alone.
     */
    async importTemplate(
        document: unknown,
        opts: {
            artifacts?: Readonly<Record<string, string | object>>;
            variables: Readonly<Record<string, string>>;
        },
    ): Promise<NativeExecution> {
        if (!this.arkade.indexer) throw new Error("NativeExecutor: an indexer is required");
        const emulator = this.arkade.emulatorKey;
        if (!emulator) throw new Error("NativeExecutor: an emulator is required");
        const doc = decode(utf8.encode(jsonText(document, "the template")));
        const given = opts?.artifacts ?? {};
        const saved: Saved = {
            version: 2,
            document: text.decode(doc.canonical),
            artifacts: Object.fromEntries(
                doc.artifactIds
                    .filter((id) => Object.hasOwn(given, id))
                    .map((id) => [id, jsonText(given[id], `artifact ${id}`)]),
            ),
            variables: { ...opts?.variables },
            templateId: doc.id,
            spendId: doc.spendId,
        };
        const prepared = prepare(saved, { server: evenOwnerKey(this.arkade.serverKey), emulator });
        const contract = arkadeContract(this.arkade, saved, prepared);
        const metadata = () => ({
            genericallySpendable: false,
            nativeExecution: {
                ...saved,
                artifacts: { ...saved.artifacts },
                variables: { ...saved.variables },
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
            const stored = registered.metadata?.nativeExecution;
            if (stored === undefined || isLegacy(stored)) {
                // A row from register() or on() has no plan; a pre-release one restore() refuses.
                registered = await manager.updateContract(registered.script, {
                    metadata: { ...registered.metadata, ...metadata() },
                });
            }
            const plan = readSaved(registered.metadata?.nativeExecution);
            if (
                plan.templateId !== saved.templateId ||
                !sameVariables(plan.variables, saved.variables)
            ) {
                throw new Error(
                    "NativeExecutor: conflicting native execution plan for existing contract",
                );
            }
            return this.own(contract, saved, prepared);
        });
    }

    /** Rebuild an imported template from its contract row, under the keys stored with it. */
    async restore(script: string): Promise<NativeExecution> {
        const manager = await this.manager();
        if (typeof script !== "string" || !/^5120[0-9a-f]{64}$/.test(script)) {
            throw new Error("NativeExecutor: expected a Taproot output script");
        }
        const [stored] = await manager.getContracts({ script });
        if (!stored || stored.script !== script) {
            throw new Error("NativeExecutor: contract not found");
        }
        if (stored.type !== "arkade") {
            throw new Error("NativeExecutor: expected an arkade contract");
        }
        if (stored.metadata?.genericallySpendable === true) {
            throw new Error("NativeExecutor: existing contract permits generic spending");
        }
        const saved = readSaved(stored.metadata?.nativeExecution);
        const contract = ArkadeContract.fromContract(this.arkade, stored);
        if (hex.encode(contract.pkScript) !== script || contract.address !== stored.address) {
            throw new Error(
                "NativeExecutor: restored contract does not match stored script or address",
            );
        }
        const { serverKey, emulatorKey } = contract.keys;
        if (!emulatorKey)
            throw new Error("NativeExecutor: the stored contract has no emulator key");
        const prepared = prepare(saved, { server: evenOwnerKey(serverKey), emulator: emulatorKey });
        if (
            prepared.doc.id !== saved.templateId ||
            prepared.doc.spendId !== saved.spendId ||
            hex.encode(prepared.instance.pkScript(0)) !== script
        ) {
            throw new Error(
                "NativeExecutor: the stored template does not derive the stored contract",
            );
        }
        return this.own(contract, saved, prepared);
    }

    private own(contract: ArkadeContract, saved: Saved, prepared: Prepared): NativeExecution {
        const execution: NativeExecution = Object.freeze({
            contract,
            functionName: prepared.template.inputs[0].function,
            templateId: saved.templateId,
            spendId: saved.spendId,
            type: "virtual",
        });
        this.imported.set(execution, { ...prepared, saved });
        return execution;
    }

    /**
     * Dry-runs the covenant against a coin of exactly `amount` at the current time and at 2^40, each
     * with a near and a far expiry, and refuses when every probe fails; then pays through the wallet.
     */
    async fund(execution: NativeExecution, amount: number): Promise<string> {
        await this.manager();
        const prepared = this.check(execution);
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            throw new Error("NativeExecutor: invalid amount");
        }
        const { dust } = await this.arkade.arkProvider.getInfo();
        const source = new Transaction({ version: 3 });
        source.addInput({ txid: new Uint8Array(32), index: 0 });
        source.addOutput({ script: prepared.instance.pkScript(0), amount: BigInt(amount) });
        const coin = { txid: source.id, vout: 0, value: amount, tx: source.toBytes() };
        const now = Math.floor(Date.now() / 1000);
        let failure: unknown;
        for (const clock of [now, FUTURE]) {
            for (const expiry of [now, FUTURE]) {
                try {
                    dryRun(
                        prepared,
                        { ...coin, expiry, createdAt: now },
                        dust,
                        this.arkade.checkpoint,
                        clock,
                    );
                } catch (error) {
                    failure ??= error;
                    continue;
                }
                return this.wallet.send({ address: execution.contract.address, amount });
            }
        }
        throw new Error(
            `NativeExecutor: no probed time or expiry lets the covenant pass: ${reason(failure)}`,
            { cause: failure },
        );
    }

    /** Registers the template's artifacts, the template and a delegation of it with `provider`. */
    async delegate(
        execution: NativeExecution,
        provider: ExecutorProvider,
        expiresAt?: number,
    ): Promise<ExecutorDelegation> {
        if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt < 0)) {
            throw new Error("NativeExecutor: invalid expiry");
        }
        const { saved, doc, template } = this.check(execution);
        if (!provider.getTemplate) {
            throw new Error("NativeExecutor: the Executor provider cannot look up templates");
        }
        const remote = provider as Required<ExecutorProvider>;
        await this.manager();
        const info = await remote.getInfo();
        const xOnly = (key: string | Uint8Array, label: string) =>
            hex.encode(toXOnly(typeof key === "string" ? hex.decode(key) : key, label));
        const { serverKey, emulatorKey } = execution.contract.keys;
        if (
            !emulatorKey ||
            xOnly(info.serverPubkey, "Executor server key") !== xOnly(serverKey, "server key") ||
            xOnly(info.emulatorPubkey, "Executor emulator key") !==
                xOnly(emulatorKey, "emulator key")
        ) {
            throw new Error("NativeExecutor: the Executor's keys differ from the contract's");
        }
        const variables = { ...saved.variables };
        if (template.sealed.size > 0) {
            if (!info.encryptionPubkey) {
                throw new Error("NativeExecutor: the Executor cannot receive sealed variables");
            }
            const recipient = hex.decode(info.encryptionPubkey);
            for (const name of template.sealed) {
                const plaintext = hex.decode(variables[name]);
                variables[name] = hex.encode(seal(recipient, plaintext, saved.templateId));
            }
        }
        if (!(await installed(remote, saved.templateId))) {
            if (!provider.registerArtifact || !provider.registerTemplate) {
                throw new Error("NativeExecutor: the Executor provider cannot register templates");
            }
            try {
                for (const id of doc.artifactIds) {
                    const artifact = await remote.registerArtifact(saved.artifacts[id]);
                    if (artifact.id !== id) {
                        throw new Error(
                            `NativeExecutor: the Executor registered artifact ${id} as ${artifact.id}`,
                        );
                    }
                }
                const registered = await remote.registerTemplate(saved.document);
                if (registered.id !== saved.templateId) {
                    throw new Error(
                        `NativeExecutor: the Executor registered template ${saved.templateId} as ${registered.id}`,
                    );
                }
            } catch (error) {
                // Executors from v0.0.5 register templates on their admin port only by default.
                if (error instanceof ExecutorRequestError && error.status === 403) {
                    throw new Error(
                        `NativeExecutor: template ${saved.templateId} is not installed on the Executor, which does not accept uploads; its operator must install it`,
                        { cause: error },
                    );
                }
                throw error;
            }
        }
        const delegation = await remote.registerDelegation(saved.templateId, variables, {
            expiresAt,
        });
        const [input, ...more] = delegation.inputs;
        if (
            delegation.templateId !== saved.templateId ||
            more.length > 0 ||
            input?.script !== hex.encode(execution.contract.pkScript) ||
            input.address !== execution.contract.address ||
            delegation.status !== "active"
        ) {
            throw new Error(
                "NativeExecutor: the Executor returned another template, script or address, or an inactive delegation",
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
            const prepared = this.check(execution);
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
            const { indexer, emulator } = this.arkade;
            if (!indexer) throw new Error("NativeExecutor: an indexer is required");
            if (!emulator) throw new Error("NativeExecutor: an emulator is required");
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
                const assets = Extension.fromBytes(script).getAssetPacket();
                if (assets?.groups.some((g) => g.outputs.some((o) => o.vout === coin.vout))) {
                    throw new Error("NativeExecutor: position carries assets");
                }
            }
            const { dust } = await this.arkade.arkProvider.getInfo();
            const { expiresAt, expiresAtHeight, createdAt } = normalizeVtxo(coin);
            // the indexer's one expiry scalar, as the emulator reads it: seconds, else a height
            const expiry = expiresAt ? Math.floor(expiresAt.getTime() / 1000) : expiresAtHeight;
            const born = new Date(createdAt).getTime();
            let offchain: OffchainTx;
            try {
                offchain = dryRun(
                    prepared,
                    {
                        txid: coin.txid,
                        vout: coin.vout,
                        value: coin.value,
                        tx: sourceTx,
                        expiry,
                        createdAt: Number.isNaN(born) ? undefined : Math.floor(born / 1000),
                    },
                    dust,
                    this.arkade.checkpoint,
                );
            } catch (error) {
                throw new Error(`NativeExecutor: the spend fails its dry run: ${reason(error)}`, {
                    cause: error,
                });
            }
            const result = await submitViaEmulator(emulator, offchain, undefined, {
                inputIndexes: [],
                beforeEmulatorSubmit,
            });
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

    private check(execution: NativeExecution): Prepared & { saved: Saved } {
        const state = this.imported.get(execution);
        if (!state) throw new Error("NativeExecutor: template belongs to another executor");
        return state;
    }
}
