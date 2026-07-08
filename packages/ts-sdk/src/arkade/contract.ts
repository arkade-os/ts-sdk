/**
 * Arkade Contract — artifact-driven, high-level covenant API.
 *
 * Implements the Arkade contract model: a contract is a {@link Program} (a set of
 * named functions, each split into a `tapscript` segment enforced on-chain and an
 * `arkadeScript` segment emulated by the co-signing service). The same JS object
 * shape mirrors the compiler artifact, so a hand-written program today and the
 * compiler's JSON output later flow through the identical resolver.
 *
 * The SDK never interprets scripts: it resolves `$param` placeholders into bytes,
 * builds the taproot tree (resolving `$param` signers such as `$server`/`$user` from
 * the constructor args, plus the co-signer key tweaked by the arkade-script hash),
 * and assembles the spend from the per-segment witness layout. All key tweaking,
 * packet encoding and PSBT plumbing is internal — from the caller's side it is just
 * Arkade.
 *
 * Program → script compilation lives in {@link ArkadeProgramScript}
 * (./program.ts) and is shared with the generic `"arkade"` contract handler,
 * so a contract created here can be persisted, watched and re-derived through
 * the standard `src/contracts` pipeline: pass a `contractManager` to
 * {@link Arkade.connect} and call {@link ArkadeContract.register}.
 *
 * Contract functions are strongly typed from the program's literal shape: a
 * function declaring `inputs: [{ name: "preimage", type: "bytes" }]` produces a
 * `functions.claim(preimage: Uint8Array)` call signature. The type flows through
 * `arkade.contract(...)` automatically for inline literals; for a program stored
 * in a variable, annotate it with `satisfies Program` to preserve the literal
 * type (a plain `: Program` annotation would widen it away).
 *
 * Constructor `params` follow the same convention: bare name strings are
 * documentation only, while typed descriptors `{ name, type }` (the form the
 * ArkadeScript compiler emits) make the list authoritative — every declared
 * param must be bound, every `$name` reference must be declared, and bound
 * values are validated against their type at compilation.
 *
 * @example
 * ```typescript
 * const htlcProgram = {
 *     version: 0,
 *     params: [
 *         { name: "hash", type: "hash" },
 *         { name: "receiver", type: "pubkey" },
 *         { name: "amount", type: "int" },
 *         { name: "server", type: "pubkey" },
 *     ],
 *     functions: {
 *         claim: {
 *             inputs: [{ name: "preimage", type: "bytes" }],
 *             tapscript: { signers: ["$server"], asm: ["HASH160", "$hash", "EQUAL"], witness: ["preimage"] },
 *             arkadeScript: { asm: payTo, witness: [0] },
 *         },
 *     },
 * } satisfies Program;
 *
 * const arkade = await Arkade.connect({ arkade: ark, emulator, indexer, identity, network });
 * // `server` is declared in `params`, so it defaults to the client's server key.
 * const htlc = arkade.contract(htlcProgram, { hash, receiver, amount: 10_000n });
 * // `preimage` is typed Uint8Array; calling `claim()` with no args is a type error.
 * const { txid } = await htlc.functions.claim(preimage).to(receiver, 10_000n).send();
 * ```
 *
 * @module arkade/contract
 */

import { base64, hex } from "@scure/base";
import { RawWitness } from "@scure/btc-signer";
import type { TransactionOutput } from "@scure/btc-signer/psbt.js";
import { equalBytes } from "@scure/btc-signer/utils.js";

import type { Network } from "../networks";
import { DEFAULT_NETWORK } from "../networks";
import type { ArkProvider } from "../providers/ark";
import type { EmulatorProvider } from "../providers/emulator";
import type { IndexerProvider } from "../providers/indexer";
import type { Identity } from "../identity";
import type { VirtualCoin } from "../wallet";
import { isSpendable } from "../wallet";
import { CSVMultisigTapscript } from "../script/tapscript";
import type { TapLeafScript } from "../script/base";
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
import type { IContractManager } from "../contracts/contractManager";
import type { Contract } from "../contracts/types";
import {
    ArkadeProgramScript,
    deserializeArkadeContractParams,
    inputName,
    serializeArkadeContractParams,
    witnessRefToBytes,
    type ArkadeArgValue,
    type ArkadeFunction,
    type ArkadeParamValue,
    type ArkadeValueType,
    type CompiledProgramFunction,
    type InputDef,
    type InputRef,
    type Program,
    type ProgramKeys,
    type WitnessRef,
} from "./program";

// Program model & artifact helpers moved to ./program — re-exported here so
// existing `from "./contract"` importers keep working.
export {
    parseArtifact,
    resolveAsm,
    stringifyArtifact,
    validateProgram,
    SUPPORTED_PROGRAM_VERSION,
    ArkadeProgramScript,
    type ArkadeContractParams,
    type AsmToken,
    type ArkadeParamValue,
    type ArkadeArgValue,
    type ArkadeArgType,
    type ArkadeFunction,
    type ArkadeSegment,
    type CompiledProgramFunction,
    type InputDef,
    type InputRef,
    type Program,
    type ProgramKeys,
    type SignerRef,
    type TapscriptSegment,
    type WitnessRef,
} from "./program";

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
     * /recursive covenants that inspect the input's provenance; when set, the SDK
     * attaches it as the PrevArkTx field.
     *
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
    /**
     * The wallet's contract manager. When set, contracts created from this
     * client can {@link ArkadeContract.register} themselves into the standard
     * contract pipeline (persistence, watching, events), and
     * {@link ArkadeContract.getUtxos} reads repository-backed state
     * (offline-first) for registered contracts instead of querying the
     * indexer directly. Obtain it via `wallet.getContractManager()`.
     */
    contractManager?: IContractManager;
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
    /** The signing identity's x-only public key, resolved at connect — identifies which inputs the wallet signs. */
    readonly userKey?: Uint8Array;
    /** The wallet's contract manager, when contract persistence is wired up. */
    readonly contractManager?: IContractManager;

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
        contractManager?: IContractManager;
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
        this.contractManager = fields.contractManager;
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
        // and the builder can identify which inputs the wallet signs.
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
            contractManager: opts.contractManager,
        });
    }

    /**
     * Instantiate a contract from a program and its constructor arguments. The
     * `program`'s literal type is preserved (`const` inference) so the resulting
     * contract's `functions` map is strongly typed — `functions.<name>(...)`
     * knows each argument's type from the function's `inputs` descriptors.
     *
     * When the program declares a `server` or `user` param and the caller does
     * not bind it, it defaults to the client's server key or the identity's
     * key respectively; explicit args always win.
     */
    contract<const P extends Program>(
        program: P,
        args: Record<string, ArkadeParamValue> = {},
    ): ArkadeContract<P> {
        const declared = (program.params ?? []).map(inputName);
        if (declared.includes("server") && args.server === undefined) {
            args = { ...args, server: this.serverKey };
        }
        if (declared.includes("user") && args.user === undefined && this.userKey) {
            args = { ...args, user: this.userKey };
        }
        return new ArkadeContract(this, program, args);
    }
}

// --- Contract --------------------------------------------------------------

/** A resolved, instantiated Arkade contract. */
export class ArkadeContract<P extends Program = Program> {
    /** The compiled taproot tree of spending-path leaves. */
    readonly vtxoScript: ArkadeProgramScript;
    /** Encoded taproot tree (shared spend context for every path). */
    readonly tapTree: Uint8Array;
    /** The signer keys the program was compiled against. */
    readonly keys: ProgramKeys;
    /** Spending paths in declaration order. */
    private readonly compiled: CompiledProgramFunction[];

    constructor(
        readonly client: Arkade,
        readonly program: P,
        readonly args: Record<string, ArkadeParamValue> = {},
        keys?: ProgramKeys,
    ) {
        this.keys = keys ?? {
            serverKey: client.serverKey,
            userKey: client.userKey,
            emulatorKey: client.emulatorKey,
        };
        this.vtxoScript = new ArkadeProgramScript(program, args, this.keys);
        this.tapTree = this.vtxoScript.encode();
        this.compiled = this.vtxoScript.compiled;
    }

    /**
     * Rebuild a callable contract from a persisted `"arkade"` contract row
     * (see {@link ArkadeContract.register}). The stored keys are used for
     * compilation — not the client's current ones — so the derived script and
     * address stay identical to the registered contract even after a server
     * signer rotation.
     */
    static fromContract(client: Arkade, contract: Contract): ArkadeContract {
        if (contract.type !== "arkade") {
            throw new Error(
                `ArkadeContract.fromContract: expected contract type 'arkade', got '${contract.type}'`,
            );
        }
        const typed = deserializeArkadeContractParams(contract.params);
        return new ArkadeContract(client, typed.program, typed.args, {
            serverKey: typed.serverKey,
            userKey: typed.userKey,
            emulatorKey: typed.emulatorKey,
        });
    }

    /** Resolve the {@link TapLeafScript} for a spending path by its index. */
    leafScript(index: number): TapLeafScript {
        const fn = this.compiled[index];
        if (!fn) throw new Error(`leaf index ${index} out of range`);
        return fn.tapLeafScript;
    }

    /** Arkade funding address. */
    get address(): string {
        return this.vtxoScript.address(this.client.network.hrp, this.keys.serverKey).encode();
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

    /**
     * The `createContract` payload for this contract — the serialized program,
     * args and keys plus the derived script/address. Useful when registering
     * through a manager the client does not hold.
     */
    toContractParams(): {
        type: string;
        params: Record<string, string>;
        script: string;
        address: string;
    } {
        return {
            type: "arkade",
            params: serializeArkadeContractParams({
                program: this.program,
                args: this.args,
                serverKey: this.keys.serverKey,
                userKey: this.keys.userKey,
                emulatorKey: this.keys.emulatorKey,
            }),
            script: hex.encode(this.pkScript),
            address: this.address,
        };
    }

    /**
     * Persist this contract through the wallet's {@link IContractManager} so it
     * is tracked like any other contract type: stored in the contract
     * repository, watched for VTXO events, counted in repository-backed
     * balances, and re-derivable offline via the `"arkade"` contract handler.
     * Idempotent — re-registering the same script is a no-op.
     */
    async register(options?: {
        label?: string;
        metadata?: Record<string, unknown>;
    }): Promise<Contract> {
        const manager = this.client.contractManager;
        if (!manager) {
            throw new Error(
                "ArkadeContract.register requires a `contractManager` on the Arkade client — pass one to Arkade.connect",
            );
        }
        return manager.createContract({
            ...this.toContractParams(),
            label: options?.label,
            metadata: options?.metadata,
        });
    }

    /**
     * Spendable VTXOs locked by this contract.
     *
     * When a `contractManager` is configured and this contract is registered,
     * reads the repository-backed state (offline-first, kept fresh by the
     * contract watcher). Otherwise falls back to a direct indexer query.
     */
    async getUtxos(): Promise<VirtualCoin[]> {
        const manager = this.client.contractManager;
        const scriptHex = hex.encode(this.pkScript);
        if (manager) {
            const [registered] = await manager.getContracts({ script: scriptHex });
            if (registered) {
                const [withVtxos] = await manager.getContractsWithVtxos({ script: scriptHex });
                return (withVtxos?.vtxos ?? []).filter(isSpendable);
            }
        }
        if (!this.client.indexer) {
            throw new Error("ArkadeContract.getUtxos: an indexer is required");
        }
        const { vtxos } = await this.client.indexer.getVtxos({
            scripts: [scriptHex],
            spendableOnly: true,
        });
        return vtxos;
    }

    /** Total spendable balance (requires an indexer). */
    async getBalance(): Promise<bigint> {
        const utxos = await this.getUtxos();
        return utxos.reduce((sum, u) => sum + BigInt(u.value), 0n);
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
        private readonly fn: CompiledProgramFunction,
        private readonly args: Record<string, ArkadeArgValue>,
    ) {}

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
            for (const [i, out] of scriptOrOutputs.entries()) {
                // `TransactionOutput` fields are all optional in scure's PSBT
                // types; an amount-less output would silently skew the balance
                // math below, so reject it here like the single-output form.
                if (out.amount === undefined) {
                    throw new Error(`to(outputs): output ${i} is missing an amount`);
                }
            }
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

        const condition = (def.tapscript.witness ?? []).map((w) => this.witnessBytes(w));
        if (condition.length > 0) {
            setArkPsbtField(arkTx, 0, ConditionWitness, condition);
            setArkPsbtField(checkpoints[0], 0, ConditionWitness, condition);
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

        // Inputs the client must sign: the contract input (0) when the user key is one
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
        const userKey = this.contract.keys.userKey;
        if (userKey && this.fn.signerKeys.some((k) => equalBytes(k, userKey))) {
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
        return witnessRefToBytes(ref, this.args, this.contract.args);
    }
}

// --- helpers ---------------------------------------------------------------

/** Bind positional call arguments to a function's declared input names. */
function bindInputs(
    fn: CompiledProgramFunction,
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
