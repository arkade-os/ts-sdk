/**
 * Arkade Contract — artifact-driven, high-level covenant API.
 *
 * Implements the Arkade contract model: a contract is a {@link Program} (a set of
 * named functions, each split into a `tapscript` segment enforced on-chain and an
 * `arkadeScript` segment emulated by the co-signing service). The same JS object
 * shape mirrors the compiler artifact, so a hand-written program today and the
 * compiler's JSON output later flow through the identical resolver.
 *
 * The SDK never interprets scripts: it resolves placeholders (`$param`,
 * `<SERVER_KEY>`, `<COSIGNER_KEY>`) into bytes, builds the taproot tree (with the
 * co-signer key tweaked by the arkade-script hash), and assembles the spend from
 * the per-segment witness layout. All key tweaking, packet encoding and PSBT
 * plumbing is internal — from the caller's side it is just Arkade.
 *
 * Contract functions are strongly typed from the program's literal shape: a
 * function declaring `inputs: [{ name: "preimage", type: "bytes" }]` produces a
 * `functions.claim(preimage: Uint8Array)` call signature. The type flows through
 * `arkade.contract(...)` automatically for inline literals; for a program stored
 * in a variable, annotate it with `satisfies Program` to preserve the literal
 * type (a plain `: Program` annotation would widen it away).
 *
 * @example
 * ```typescript
 * const htlcProgram = {
 *     params: ["hash", "receiver", "amount"],
 *     functions: {
 *         claim: {
 *             inputs: [{ name: "preimage", type: "bytes" }],
 *             tapscript: { signers: ["server"], asm: ["HASH160", "$hash", "EQUALVERIFY"], witness: ["preimage"] },
 *             arkadeScript: { asm: payTo, witness: [0] },
 *         },
 *     },
 * } satisfies Program;
 *
 * const arkade = await Arkade.connect({ arkade: ark, emulator, indexer, identity, network });
 * const htlc = arkade.contract(htlcProgram, { hash, receiver, amount: 10_000n });
 * // `preimage` is typed Uint8Array; calling `claim()` with no args is a type error.
 * const { txid } = await htlc.functions.claim(preimage).to(receiver, 10_000n).send();
 * ```
 *
 * @module arkade/contract
 */

import { base64, hex } from "@scure/base";
import { RawWitness, ScriptNum } from "@scure/btc-signer";
import type { TransactionOutput } from "@scure/btc-signer/psbt.js";

import type { Network } from "../networks";
import { DEFAULT_NETWORK } from "../networks";
import type { ArkProvider } from "../providers/ark";
import type { EmulatorProvider } from "../providers/emulator";
import type { IndexerProvider } from "../providers/indexer";
import type { Identity } from "../identity";
import type { VirtualCoin } from "../wallet";
import {
    MultisigTapscript,
    CSVMultisigTapscript,
    CLTVMultisigTapscript,
    ConditionMultisigTapscript,
    type ArkTapscript,
    type TapscriptType,
    type RelativeTimelock,
} from "../script/tapscript";
import { VtxoScript, type TapLeafScript } from "../script/base";
import { buildOffchainTx, type ArkTxInput } from "../utils/arkTransaction";
import { ConditionWitness, PrevArkTxField, setArkPsbtField } from "../utils/unknownFields";
import { Transaction } from "../utils/transaction";
import { ANCHOR_PKSCRIPT } from "../utils/anchor";
import { Extension } from "../extension";
import { EmulatorPacket } from "../extension/emulator";
import type { ExtensionPacket } from "../extension/packet";
import {
    Packet as AssetPacket,
    AssetGroup,
    AssetInput,
    AssetOutput,
    AssetId,
    Metadata,
} from "../extension/asset";
import { ArkadeScript } from "./script";
import { ARKADE_OP } from "./opcodes";
import { computeArkadeScriptPublicKey } from "./tweak";

const MinimalScriptNum = ScriptNum(undefined, true);

// --- Program model (mirrors the compiler artifact) -------------------------

/** A token in an `asm` array: an opcode name, a number/bigint push, raw bytes, or a `$param`/`<SERVER_KEY>` placeholder. */
export type AsmToken = string | number | bigint | Uint8Array;

/** A constructor argument or resolved value. */
export type ArkadeParamValue = Uint8Array | bigint | number;

/** A function call argument (function input). */
export type ArkadeArgValue = Uint8Array | bigint | number;

/**
 * The declared type of a function input, used to derive the static TS type of
 * the corresponding `functions.<name>(...)` argument. Byte-like types map to
 * `Uint8Array`; `int` maps to `bigint | number`.
 */
export type ArkadeArgType = "bytes" | "pubkey" | "sig" | "hash" | "int";

/**
 * Maps an {@link ArkadeArgType} to its TypeScript argument type.
 * @internal
 */
interface ArkadeValueType {
    bytes: Uint8Array;
    pubkey: Uint8Array;
    sig: Uint8Array;
    hash: Uint8Array;
    int: bigint | number;
}

/** A typed function input: a name plus its {@link ArkadeArgType}. */
export interface InputDef {
    name: string;
    type: ArkadeArgType;
}

/**
 * A function input declaration: either a typed descriptor `{ name, type }` (the
 * argument is statically typed) or a bare name string (the argument falls back
 * to the loose {@link ArkadeArgValue}).
 */
export type InputRef = string | InputDef;

/** Reference to a signer key: `"server"`, `"user"`, a `"$param"`, or literal x-only bytes. */
export type SignerRef = "server" | "user" | string | Uint8Array;

/** A witness-stack item: a function-input name, a literal number/bigint (minimal script-num), or raw bytes. */
export type WitnessRef = string | number | bigint | Uint8Array;

/** Bitcoin Script segment of a spending path — enforced on-chain. */
export interface TapscriptSegment {
    /** Required signers. The tweaked co-signer is appended automatically when the path has an `arkadeScript`. */
    signers: SignerRef[];
    /** Optional standard-opcode condition (e.g. a hashlock), encoded into a ConditionMultisig leaf. */
    asm?: AsmToken[];
    /** Relative timelock (CSV). Mutually exclusive with `cltv`/`asm`. */
    csv?: RelativeTimelock;
    /** Absolute timelock (CLTV). Mutually exclusive with `csv`/`asm`. */
    cltv?: bigint;
    /** Items satisfying the condition (e.g. an HTLC preimage); set via the ConditionWitness PSBT field. */
    witness?: WitnessRef[];
}

/** Arkade Script segment of a spending path — emulated, bound via the key tweak. */
export interface ArkadeSegment {
    /** Raw Arkade opcodes with `$param` placeholders. */
    asm: AsmToken[];
    /** The arkade-script witness stack (e.g. an output index). */
    witness?: WitnessRef[];
}

/** One named spending path. */
export interface ArkadeFunction {
    /**
     * The function ABI: an ordered list of call arguments. Each entry is a typed
     * descriptor `{ name, type }` (which gives the matching `functions.<name>`
     * argument a precise static type) or a bare name string (loose
     * {@link ArkadeArgValue}). Absent for nullary paths (e.g. exit/cancel).
     */
    inputs?: readonly InputRef[];
    tapscript: TapscriptSegment;
    /** Present for covenant paths; absent for pure-tapscript paths (cancel/exit). */
    arkadeScript?: ArkadeSegment;
}

/** An Arkade contract program (hand-written or compiler-emitted). */
export interface Program {
    /** Ordered constructor parameter names (documentation/validation only). */
    params?: string[];
    functions: Record<string, ArkadeFunction>;
}

// --- Static typing of contract functions -----------------------------------

/** The TS type of a single call argument, derived from its {@link InputRef}. */
type ArgTsType<R> = R extends InputDef ? ArkadeValueType[R["type"]] : ArkadeArgValue;

/** The argument tuple of a function, derived from its declared `inputs`. */
type ArgsTuple<I extends readonly InputRef[]> = { [K in keyof I]: ArgTsType<I[K]> };

/** The call signature arguments for one function (nullary when `inputs` is absent). */
type FnArgs<F extends ArkadeFunction> = F extends {
    inputs: infer I extends readonly InputRef[];
}
    ? ArgsTuple<I>
    : [];

/**
 * The statically-typed `functions` map of a contract. When the program is a
 * concrete literal (specific function names), each entry is precisely typed from
 * its `inputs`. When the program is the widened {@link Program} (an index
 * signature), it falls back to the loose {@link CallableFunctions}.
 */
export type ContractFunctions<P extends Program> = string extends keyof P["functions"]
    ? CallableFunctions
    : {
          [K in keyof P["functions"]]: (
              ...args: FnArgs<P["functions"][K]>
          ) => ArkadeTransactionBuilder;
      };

// --- Spend types -----------------------------------------------------------

/** A spendable coin (VTXO) — outpoint + value. */
export interface Utxo {
    txid: string;
    vout: number;
    value: number;
    /**
     * The ark transaction that created this VTXO. Required only by continuation
     * /recursive covenants that inspect the input's provenance; the SDK attaches
     * it as the PrevArkTx field. Often populated automatically from the indexer.
     */
    sourceTx?: Uint8Array;
}

/**
 * An asset-group transfer attached to a spend: which inputs supply the asset and
 * which outputs receive it. Encoded into the asset Packet alongside the emulator
 * packet in the same OP_RETURN extension.
 */
export interface AssetSpec {
    /** The asset id — serialized hex string or raw bytes. */
    assetId: string | Uint8Array;
    /** Inputs supplying the asset (by transaction input index). */
    inputs: { vin: number; amount: bigint | number }[];
    /** Outputs receiving the asset (by transaction output index). */
    outputs: { vout: number; amount: bigint | number }[];
    /** Optional metadata key/value entries. */
    metadata?: { key: Uint8Array; value: Uint8Array }[];
}

/** Result of a successful spend. */
export interface ArkadeSpendResult {
    txid: string;
    signedArkTx: string;
    signedCheckpointTxs: string[];
}

/** The callable spending paths of a contract. */
export type CallableFunctions = Record<
    string,
    (...args: ArkadeArgValue[]) => ArkadeTransactionBuilder
>;

// --- Arkade client ---------------------------------------------------------

/** Options for {@link Arkade.connect}. */
export interface ArkadeConnectOptions {
    /** The Ark/Arkade server provider. */
    arkade: Pick<ArkProvider, "getInfo" | "submitTx" | "finalizeTx">;
    /**
     * The co-signing (introspector/emulator) service. Optional: only required for
     * contracts whose functions have an `arkadeScript` (covenant paths). Pure
     * tapscript contracts (multisig/timelock/hashlock) don't need it.
     */
    emulator?: EmulatorProvider;
    /** Indexer — enables `getUtxos`/`getBalance` and coin auto-selection. */
    indexer?: Pick<IndexerProvider, "getVtxos">;
    /** Signer for paths that require a user signature; optional for watch-only. */
    identity?: Identity;
    /** Network for address derivation; defaults to the SDK default. */
    network?: Network;
}

/**
 * A connected Arkade client. Holds the providers/identity/network and the
 * resolved network constants (server key, co-signer key, checkpoint closure),
 * so spinning up contracts is synchronous.
 */
export class Arkade {
    readonly arkProvider: Pick<ArkProvider, "getInfo" | "submitTx" | "finalizeTx">;
    /** The co-signing service, or undefined for emulator-less (pure tapscript) usage. */
    readonly emulator: EmulatorProvider | undefined;
    readonly network: Network;
    readonly serverKey: Uint8Array;
    /** The co-signer's x-only key, present only when an emulator is configured. */
    readonly emulatorKey: Uint8Array | undefined;
    readonly checkpoint: CSVMultisigTapscript.Type;
    readonly indexer?: Pick<IndexerProvider, "getVtxos">;
    readonly identity?: Identity;
    /** The signing identity's x-only public key, resolved at connect for the `"user"` signer. */
    readonly userKey?: Uint8Array;

    private constructor(fields: {
        arkProvider: Pick<ArkProvider, "getInfo" | "submitTx" | "finalizeTx">;
        emulator: EmulatorProvider | undefined;
        network: Network;
        serverKey: Uint8Array;
        emulatorKey: Uint8Array | undefined;
        checkpoint: CSVMultisigTapscript.Type;
        indexer?: Pick<IndexerProvider, "getVtxos">;
        identity?: Identity;
        userKey?: Uint8Array;
    }) {
        this.arkProvider = fields.arkProvider;
        this.emulator = fields.emulator;
        this.network = fields.network;
        this.serverKey = fields.serverKey;
        this.emulatorKey = fields.emulatorKey;
        this.checkpoint = fields.checkpoint;
        this.indexer = fields.indexer;
        this.identity = fields.identity;
        this.userKey = fields.userKey;
    }

    /** Connect and resolve the server key, checkpoint closure and (if present) the co-signer key. */
    static async connect(opts: ArkadeConnectOptions): Promise<Arkade> {
        const info = await opts.arkade.getInfo();
        const serverKey = hex.decode(info.signerPubkey).slice(1);
        const checkpoint = CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript));

        // The emulator is optional — only covenant contracts need it.
        let emulatorKey: Uint8Array | undefined;
        if (opts.emulator) {
            const eInfo = await opts.emulator.getInfo();
            emulatorKey = hex.decode(eInfo.signerPubkey);
        }

        // Resolve the user key up-front so contract instantiation stays synchronous
        // and `signers: ["user"]` works without the caller passing a $param.
        let userKey: Uint8Array | undefined;
        if (opts.identity) {
            const pub = await opts.identity.xOnlyPublicKey();
            userKey = pub.length === 33 ? pub.slice(1) : pub;
        }

        return new Arkade({
            arkProvider: opts.arkade,
            emulator: opts.emulator,
            network: opts.network ?? DEFAULT_NETWORK,
            serverKey,
            emulatorKey,
            checkpoint,
            indexer: opts.indexer,
            identity: opts.identity,
            userKey,
        });
    }

    /**
     * Build a client from an existing wallet, reusing its identity, network and
     * indexer. The `arkade` provider must still be supplied (a `Wallet` does not
     * hold one); `emulator` is optional and only needed for covenant contracts.
     */
    static async fromWallet(
        wallet: {
            identity: Identity;
            network: Network;
            indexerProvider: Pick<IndexerProvider, "getVtxos">;
        },
        opts: {
            arkade: Pick<ArkProvider, "getInfo" | "submitTx" | "finalizeTx">;
            emulator?: EmulatorProvider;
        },
    ): Promise<Arkade> {
        return Arkade.connect({
            arkade: opts.arkade,
            emulator: opts.emulator,
            indexer: wallet.indexerProvider,
            identity: wallet.identity,
            network: wallet.network,
        });
    }

    /**
     * Instantiate a contract from a program and its constructor arguments. The
     * `program`'s literal type is preserved (`const` inference) so the resulting
     * contract's `functions` map is strongly typed — `functions.<name>(...)`
     * knows each argument's type from the function's `inputs` descriptors.
     */
    contract<const P extends Program>(
        program: P,
        args: Record<string, ArkadeParamValue> = {},
    ): ArkadeContract<P> {
        return new ArkadeContract(this, program, args);
    }
}

// --- Contract --------------------------------------------------------------

/**
 * A single spending path, fully resolved at construction: its definition, the
 * committed leaf body, the per-path arkade-script bytes (covenant paths only),
 * and the {@link TapLeafScript} (control block) for spending it.
 */
interface CompiledFunction {
    name: string;
    def: ArkadeFunction;
    /** The committed leaf script (body). */
    leafScript: Uint8Array;
    /** Resolved arkade-script bytes; undefined for pure-tapscript paths. */
    arkadeScript?: Uint8Array;
    /** Resolved once — the taproot leaf + control block for this path. */
    tapLeafScript: TapLeafScript;
}

/** A resolved, instantiated Arkade contract. */
export class ArkadeContract<P extends Program = Program> {
    /** The taproot tree of spending-path leaves. */
    readonly vtxoScript: VtxoScript;
    /** Encoded taproot tree (shared spend context for every path). */
    readonly tapTree: Uint8Array;
    /** Spending paths in declaration order. */
    private readonly compiled: CompiledFunction[];

    constructor(
        readonly client: Arkade,
        readonly program: P,
        readonly args: Record<string, ArkadeParamValue>,
    ) {
        const functions: Record<string, ArkadeFunction> = program.functions;
        const names = Object.keys(functions);
        if (names.length === 0) {
            throw new Error("ArkadeContract: program has no functions");
        }
        const defs = names.map((n) => functions[n]);

        // Covenant functions need the emulator's co-signer key for the tweak.
        const covenant = names.find((_, i) => defs[i].arkadeScript);
        if (covenant && !client.emulatorKey) {
            throw new Error(
                `ArkadeContract: function '${covenant}' has an arkadeScript but no emulator is configured — pass an \`emulator\` to Arkade.connect`,
            );
        }

        // First pass: resolve each leaf body (and arkade bytes) so the tree can
        // be built. Second pass resolves each path's TapLeafScript once the tree
        // (and thus the control blocks) exists.
        const partial = defs.map((def, i) => {
            validateTapscript(def.tapscript);
            const pubkeys = def.tapscript.signers.map((s) => this.resolveSigner(s));

            if (def.arkadeScript) {
                // Covenant leaf: bind the emulator's co-signer key to the arkade
                // script via the tagged-hash tweak, then append it to the leaf's
                // signer set (equivalent to the former ArkadeVtxoScript).
                const arkadeScript = resolveAsm(def.arkadeScript.asm, args);
                const tweaked = computeArkadeScriptPublicKey(client.emulatorKey!, arkadeScript);
                const leafScript = this.encodeTapscript(def.tapscript, [
                    ...pubkeys,
                    tweaked,
                ]).script;
                return { name: names[i], def, leafScript, arkadeScript };
            }
            const leafScript = this.encodeTapscript(def.tapscript, pubkeys).script;
            return { name: names[i], def, leafScript, arkadeScript: undefined };
        });

        this.vtxoScript = new VtxoScript(partial.map((p) => p.leafScript));
        this.tapTree = this.vtxoScript.encode();
        this.compiled = partial.map((p) => ({
            ...p,
            tapLeafScript: this.vtxoScript.findLeaf(hex.encode(p.leafScript)),
        }));
    }

    /** Resolve the {@link TapLeafScript} for a spending path by its index. */
    leafScript(index: number): TapLeafScript {
        const fn = this.compiled[index];
        if (!fn) throw new Error(`leaf index ${index} out of range`);
        return fn.tapLeafScript;
    }

    /** Arkade funding address. */
    get address(): string {
        return this.vtxoScript.address(this.client.network.hrp, this.client.serverKey).encode();
    }

    /** Taproot output script. */
    get pkScript(): Uint8Array {
        return this.vtxoScript.pkScript;
    }

    /**
     * Callable spending paths: `contract.functions.<name>(...args)`. Strongly
     * typed from the program's literal type — each function's argument types are
     * derived from its `inputs` descriptors (see {@link ContractFunctions}).
     */
    get functions(): ContractFunctions<P> {
        const out: CallableFunctions = {};
        for (const fn of this.compiled) {
            out[fn.name] = (...callArgs: ArkadeArgValue[]) =>
                new ArkadeTransactionBuilder(this, fn, bindInputs(fn, callArgs));
        }
        return out as unknown as ContractFunctions<P>;
    }

    /** Spendable VTXOs locked by this contract (requires an indexer). */
    async getUtxos(): Promise<VirtualCoin[]> {
        if (!this.client.indexer) {
            throw new Error("ArkadeContract.getUtxos: an indexer is required");
        }
        const { vtxos } = await this.client.indexer.getVtxos({
            scripts: [hex.encode(this.pkScript)],
            spendableOnly: true,
        });
        return vtxos;
    }

    /** Total spendable balance (requires an indexer). */
    async getBalance(): Promise<bigint> {
        const utxos = await this.getUtxos();
        return utxos.reduce((sum, u) => sum + BigInt(u.value), 0n);
    }

    private resolveSigner(ref: SignerRef): Uint8Array {
        if (ref instanceof Uint8Array) return ref;
        if (ref === "server") return this.client.serverKey;
        if (ref === "user") {
            if (!this.client.userKey) {
                throw new Error("signer 'user' requires an `identity` on the Arkade client");
            }
            return this.client.userKey;
        }
        if (ref.startsWith("$")) {
            const v = bindValue(this.args, ref.slice(1));
            if (!(v instanceof Uint8Array)) {
                throw new Error(`signer ${ref} must be a pubkey (bytes)`);
            }
            return v;
        }
        throw new Error(`unknown signer reference '${ref}'`);
    }

    private encodeTapscript(
        seg: TapscriptSegment,
        pubkeys: Uint8Array[],
    ): ArkTapscript<TapscriptType, any> {
        if (seg.csv) return CSVMultisigTapscript.encode({ timelock: seg.csv, pubkeys });
        if (seg.cltv !== undefined) {
            return CLTVMultisigTapscript.encode({ absoluteTimelock: seg.cltv, pubkeys });
        }
        if (seg.asm) {
            return ConditionMultisigTapscript.encode({
                conditionScript: resolveAsm(seg.asm, this.args),
                pubkeys,
            });
        }
        return MultisigTapscript.encode({ pubkeys });
    }
}

// --- Transaction builder ---------------------------------------------------

/**
 * Fluent builder for a single spend. Obtained from `contract.functions.<name>(...)`;
 * chain `.from()`/`.to()` then `.send()` (broadcast) or `.build()` (assemble only).
 */
export class ArkadeTransactionBuilder {
    private readonly outputs: TransactionOutput[] = [];
    private readonly fundingCoins: ArkTxInput[] = [];
    private readonly assetSpecs: AssetSpec[] = [];
    private coin?: Utxo;
    private changeScript?: Uint8Array;

    /** @internal */
    constructor(
        // `<any>`: the builder only reads `client`/`tapTree` (program-independent),
        // and the concrete `P` would otherwise make `this` unassignable here.
        private readonly contract: ArkadeContract<any>,
        private readonly fn: CompiledFunction,
        private readonly args: Record<string, ArkadeArgValue>,
    ) {}

    /** Spend a specific contract coin. Defaults to auto-selecting one from the contract. */
    from(coin: Utxo): this {
        this.coin = coin;
        return this;
    }

    /**
     * Add extra inputs the caller funds (e.g. a taker's own coins in a swap).
     * These become inputs 1..n and are signed with the client identity.
     */
    fund(coins: ArkTxInput[]): this {
        this.fundingCoins.push(...coins);
        return this;
    }

    /** Transfer an asset group: which inputs supply it and which outputs receive it. */
    withAsset(spec: AssetSpec): this {
        this.assetSpecs.push(spec);
        return this;
    }

    /** Destination for any surplus (inputs − outputs). Required when the spend is not exact. */
    change(script: Uint8Array): this {
        this.changeScript = script;
        return this;
    }

    /** Add an output — `(script, amount)` or a list of outputs. */
    to(script: Uint8Array, amount: bigint): this;
    to(outputs: TransactionOutput[]): this;
    to(scriptOrOutputs: Uint8Array | TransactionOutput[], amount?: bigint): this {
        if (Array.isArray(scriptOrOutputs)) {
            this.outputs.push(...scriptOrOutputs);
        } else {
            if (amount === undefined) throw new Error("to(script, amount): amount is required");
            this.outputs.push({ script: scriptOrOutputs, amount });
        }
        return this;
    }

    /** Assemble the unsigned ark transaction and its checkpoints. */
    async build(): Promise<{ arkTx: Transaction; checkpoints: Transaction[] }> {
        if (this.outputs.length === 0) {
            throw new Error("ArkadeTransactionBuilder: at least one output is required");
        }
        const outputsSum = this.outputs.reduce((s, o) => s + (o.amount ?? 0n), 0n);
        const coin = this.coin ?? (await this.selectCoin(outputsSum));
        const def = this.fn.def;

        // Balance the spend: inputs must equal outputs. Append a change output
        // for any surplus (a local copy keeps `build()` idempotent).
        const outputs = [...this.outputs];
        const fundingSum = this.fundingCoins.reduce((s, f) => s + BigInt(f.value), 0n);
        const surplus = BigInt(coin.value) + fundingSum - outputsSum;
        if (surplus < 0n) {
            throw new Error(
                `ArkadeTransactionBuilder: insufficient inputs — outputs ${outputsSum} exceed inputs ${BigInt(coin.value) + fundingSum}`,
            );
        }
        if (surplus > 0n) {
            if (!this.changeScript) {
                throw new Error(
                    `ArkadeTransactionBuilder: ${surplus} sats surplus with no change output — call .change(script)`,
                );
            }
            outputs.push({ script: this.changeScript, amount: surplus });
        }

        const { arkTx, checkpoints } = buildOffchainTx(
            [
                {
                    txid: coin.txid,
                    vout: coin.vout,
                    value: coin.value,
                    tapLeafScript: this.fn.tapLeafScript,
                    tapTree: this.contract.tapTree,
                },
                ...this.fundingCoins,
            ],
            outputs,
            this.contract.client.checkpoint,
        );

        // Continuation context for recursive covenants — the parent ark tx that
        // created the spent coin.
        if (coin.sourceTx) {
            setArkPsbtField(arkTx, 0, PrevArkTxField, coin.sourceTx);
        }

        // tapscript witness → ConditionWitness on the ark tx and every checkpoint.
        const condition = (def.tapscript.witness ?? []).map((w) => this.witnessBytes(w));
        if (condition.length > 0) {
            setArkPsbtField(arkTx, 0, ConditionWitness, condition);
            for (const cp of checkpoints) {
                setArkPsbtField(cp, 0, ConditionWitness, condition);
            }
        }

        // Collect extension packets — asset groups (type 0) then the emulator
        // packet (type 1) — into a single OP_RETURN extension.
        const packets: ExtensionPacket[] = [];
        if (this.assetSpecs.length > 0) {
            packets.push(this.buildAssetPacket());
        }
        const arkadeScript = this.fn.arkadeScript;
        if (arkadeScript) {
            const stack = (def.arkadeScript?.witness ?? []).map((w) => this.witnessBytes(w));
            packets.push(
                EmulatorPacket.create([
                    { vin: 0, script: arkadeScript, witness: RawWitness.encode(stack) },
                ]) as ExtensionPacket,
            );
        }
        if (packets.length > 0) {
            attachExtension(arkTx, packets);
        }

        return { arkTx, checkpoints };
    }

    /** Build, submit and return the finalized transaction. */
    async send(): Promise<ArkadeSpendResult> {
        const { arkTx, checkpoints } = await this.build();
        const client = this.contract.client;

        // Inputs the client must sign: the contract input (0) when "user" is one
        // of its signers, plus every funded input (1..n).
        const userInputs = this.userInputIndexes();

        if (this.fn.arkadeScript) {
            // Covenant path → the emulator executes the arkade script and finalizes
            // with arkd. We sign the client's inputs (the emulator/server add the
            // remaining co-signatures, including for the contract checkpoint).
            if (!client.emulator) {
                throw new Error("covenant spends require an `emulator` on the Arkade client");
            }
            const signedArk = await this.signArk(arkTx, userInputs);
            const signedCps =
                userInputs.length > 0
                    ? await Promise.all(
                          checkpoints.map((c, i) =>
                              userInputs.includes(i) ? client.identity!.sign(c, [0]) : c,
                          ),
                      )
                    : checkpoints;
            const res = await client.emulator.submitTx(
                base64.encode(signedArk.toPSBT()),
                signedCps.map((c) => base64.encode(c.toPSBT())),
            );
            const txid = Transaction.fromPSBT(base64.decode(res.signedArkTx)).id;
            return {
                txid,
                signedArkTx: res.signedArkTx,
                signedCheckpointTxs: res.signedCheckpointTxs,
            };
        }

        // Pure-tapscript cooperative path → arkd directly. Mirrors the canonical
        // offchain-send flow: sign the virtual tx inputs, submit UNSIGNED
        // checkpoints, then sign the server-returned checkpoints and finalize.
        // NOTE: not yet covered by integration tests.
        if (!client.identity) {
            throw new Error("a signing identity is required for non-covenant spends");
        }
        const signedArk = await this.signArk(arkTx, userInputs);
        const res = await client.arkProvider.submitTx(
            base64.encode(signedArk.toPSBT()),
            checkpoints.map((c) => base64.encode(c.toPSBT())),
        );
        const finalCps = await Promise.all(
            res.signedCheckpointTxs.map(async (b) =>
                base64.encode(
                    (
                        await client.identity!.sign(Transaction.fromPSBT(base64.decode(b)), [0])
                    ).toPSBT(),
                ),
            ),
        );
        await client.arkProvider.finalizeTx(res.arkTxid, finalCps);
        return {
            txid: res.arkTxid,
            signedArkTx: res.finalArkTx,
            signedCheckpointTxs: res.signedCheckpointTxs,
        };
    }

    /** Sign the client-owned inputs of the ark tx (no-op when there are none). */
    private async signArk(arkTx: Transaction, userInputs: number[]): Promise<Transaction> {
        if (userInputs.length === 0) return arkTx;
        const { identity } = this.contract.client;
        if (!identity) {
            throw new Error("this spend requires an `identity` to sign its user/funding inputs");
        }
        return identity.sign(arkTx, userInputs);
    }

    /** Indexes of inputs the client owns and must sign (contract input + funded inputs). */
    private userInputIndexes(): number[] {
        const idxs: number[] = [];
        if (this.fn.def.tapscript.signers.includes("user")) {
            idxs.push(0);
        }
        for (let i = 0; i < this.fundingCoins.length; i++) {
            idxs.push(i + 1);
        }
        return idxs;
    }

    private async selectCoin(amount: bigint): Promise<Utxo> {
        const utxos = await this.contract.getUtxos();
        if (utxos.length === 0) throw new Error("no spendable coins for this contract");
        // Prefer the smallest single coin that covers the outputs; otherwise the
        // largest (the rest may be supplied via `.fund()`).
        const covering = utxos
            .filter((u) => BigInt(u.value) >= amount)
            .sort((a, b) => a.value - b.value);
        if (covering.length > 0) return covering[0];
        return [...utxos].sort((a, b) => b.value - a.value)[0];
    }

    private buildAssetPacket(): ExtensionPacket {
        const groups = this.assetSpecs.map((s) => {
            const id =
                typeof s.assetId === "string"
                    ? AssetId.fromString(s.assetId)
                    : AssetId.fromBytes(s.assetId);
            return AssetGroup.create(
                id,
                null,
                s.inputs.map((i) => AssetInput.create(i.vin, i.amount)),
                s.outputs.map((o) => AssetOutput.create(o.vout, o.amount)),
                (s.metadata ?? []).map((m) => Metadata.create(m.key, m.value)),
            );
        });
        return AssetPacket.create(groups) as ExtensionPacket;
    }

    private witnessBytes(ref: WitnessRef): Uint8Array {
        if (ref instanceof Uint8Array) return ref;
        if (typeof ref === "number" || typeof ref === "bigint") {
            return MinimalScriptNum.encode(BigInt(ref));
        }
        const v = bindValue(this.args, ref);
        if (v instanceof Uint8Array) return v;
        return MinimalScriptNum.encode(BigInt(v));
    }
}

// --- helpers ---------------------------------------------------------------

/** The declared name of a function input, whether typed descriptor or bare string. */
function inputName(ref: InputRef): string {
    return typeof ref === "string" ? ref : ref.name;
}

/** Bind positional call arguments to a function's declared input names. */
function bindInputs(
    fn: CompiledFunction,
    callArgs: ArkadeArgValue[],
): Record<string, ArkadeArgValue> {
    const names = (fn.def.inputs ?? []).map(inputName);
    if (callArgs.length !== names.length) {
        throw new Error(`${fn.name}: expected ${names.length} argument(s), got ${callArgs.length}`);
    }
    const bound: Record<string, ArkadeArgValue> = {};
    names.forEach((n, i) => (bound[n] = callArgs[i]));
    return bound;
}

/** Look up a `$param` / function-input value in a bind map; throws when unbound. */
function bindValue(bind: Record<string, ArkadeParamValue>, name: string): ArkadeParamValue {
    const v = bind[name];
    if (v === undefined) throw new Error(`unbound parameter '${name}'`);
    return v;
}

/**
 * Resolve an `asm` array to bytes: substitute `$param` / `<SERVER_KEY>` /
 * `<COSIGNER_KEY>` placeholders from `bind`, pass everything else through to the
 * Arkade script encoder. The SDK does not interpret opcodes — this is pure
 * substitution + encoding.
 */
export function resolveAsm(asm: AsmToken[], bind: Record<string, ArkadeParamValue>): Uint8Array {
    const tokens = asm.map((t) => {
        if (typeof t === "string" && t.startsWith("$")) {
            return bindValue(bind, t.slice(1));
        }
        if (t === "<SELF>") {
            // Continuation covenants don't hard-code their own address (that would
            // be a non-converging fixpoint); express them with input introspection
            // (PUSHCURRENTINPUTINDEX + INSPECTINPUTSCRIPTPUBKEY) instead.
            throw new Error(
                "<SELF> is not a placeholder; use INSPECTINPUTSCRIPTPUBKEY for continuation covenants",
            );
        }
        return t;
    });
    return ArkadeScript.encode(tokens as never);
}

/**
 * Validate a tapscript segment: it must have signers, may use at most one of
 * `asm`/`csv`/`cltv`, and may not contain Arkade opcodes (those are `OP_SUCCESS`
 * on-chain and belong in the `arkadeScript` segment).
 */
function validateTapscript(seg: TapscriptSegment): void {
    if (!seg.signers || seg.signers.length === 0) {
        throw new Error("tapscript: at least one signer is required");
    }
    const forms = [seg.asm !== undefined, seg.csv !== undefined, seg.cltv !== undefined].filter(
        Boolean,
    ).length;
    if (forms > 1) {
        throw new Error("tapscript: `asm`, `csv` and `cltv` conflict — use at most one");
    }
    for (const t of seg.asm ?? []) {
        if (typeof t === "string" && t in ARKADE_OP) {
            throw new Error(
                `tapscript: arkade opcode '${t}' is not enforceable on-chain — move it to arkadeScript`,
            );
        }
    }
}

/**
 * Convert a compiler-style JSON artifact into a {@link Program}. Byte values are
 * encoded as `0x`-prefixed hex strings in `asm`/`witness`/`signers`; opcode names,
 * `$param` placeholders and numbers pass through unchanged.
 */
export function parseArtifact(artifact: {
    params?: string[];
    functions: Record<string, any>;
}): Program {
    const hexToken = (t: unknown): any =>
        typeof t === "string" && t.startsWith("0x") ? hex.decode(t.slice(2)) : t;

    const functions: Record<string, ArkadeFunction> = {};
    for (const [name, fn] of Object.entries(artifact.functions)) {
        const tap = fn.tapscript ?? {};
        const tapscript: TapscriptSegment = {
            signers: (tap.signers ?? []).map(hexToken),
            ...(tap.asm ? { asm: tap.asm.map(hexToken) } : {}),
            ...(tap.witness ? { witness: tap.witness.map(hexToken) } : {}),
            ...(tap.csv ? { csv: { type: tap.csv.type, value: BigInt(tap.csv.value) } } : {}),
            ...(tap.cltv !== undefined ? { cltv: BigInt(tap.cltv) } : {}),
        };
        const arkadeScript = fn.arkadeScript
            ? {
                  asm: fn.arkadeScript.asm.map(hexToken),
                  ...(fn.arkadeScript.witness
                      ? { witness: fn.arkadeScript.witness.map(hexToken) }
                      : {}),
              }
            : undefined;
        functions[name] = {
            ...(fn.inputs ? { inputs: fn.inputs } : {}),
            tapscript,
            ...(arkadeScript ? { arkadeScript } : {}),
        };
    }
    return { ...(artifact.params ? { params: artifact.params } : {}), functions };
}

/**
 * Insert (or merge into an existing) Extension OP_RETURN carrying the given
 * packets, mutating `tx` in place. Placement matches the on-chain rules: merge
 * into an existing extension, otherwise insert before the P2A anchor (if any),
 * otherwise append.
 */
function attachExtension(tx: Transaction, newPackets: ExtensionPacket[]): void {
    for (let i = 0; i < tx.outputsLength; i++) {
        const out = tx.getOutput(i);
        if (!out?.script || !Extension.isExtension(out.script)) continue;
        const existing = Extension.fromBytes(out.script);
        const merged = Extension.create([...existing.getPackets(), ...newPackets]);
        tx.updateOutput(i, { script: merged.serialize(), amount: 0n });
        return;
    }

    const ext = Extension.create(newPackets);
    const newOut = ext.txOut();

    const lastIdx = tx.outputsLength - 1;
    const lastOut = tx.getOutput(lastIdx);
    if (
        lastOut?.script &&
        lastOut.script.length === ANCHOR_PKSCRIPT.length &&
        lastOut.script.every((b, j) => b === ANCHOR_PKSCRIPT[j])
    ) {
        tx.updateOutput(lastIdx, { script: newOut.script, amount: newOut.amount });
        tx.addOutput({ script: lastOut.script, amount: lastOut.amount ?? 0n });
        return;
    }

    tx.addOutput({ script: newOut.script, amount: newOut.amount });
}
