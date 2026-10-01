/**
 * Arkade Contract — artifact-driven, high-level covenant API.
 *
 * A contract is a {@link Program}: named functions, each split into a `tapscript` segment
 * enforced on-chain and an `arkadeScript` segment emulated by the co-signing service. The shape
 * mirrors the compiler artifact, so hand-written programs and compiler output share one resolver.
 * The SDK never interprets scripts; it resolves `$param` placeholders and signers, builds the
 * taproot tree (co-signer key tweaked by the arkade-script hash) and assembles the spend.
 *
 * Compilation lives in {@link ArkadeProgramScript} and is shared with the `"arkade"` contract
 * handler: pass a `contractManager` to {@link Arkade.connect} and call
 * {@link ArkadeContract.register} to persist and watch a contract.
 *
 * Functions are typed from the program's literal shape (`inputs: [{ name: "preimage", type:
 * "bytes" }]` → `functions.claim(preimage: Uint8Array)`). For a program stored in a variable use
 * `satisfies Program`; a `: Program` annotation widens the literal type away. Typed `params`
 * descriptors `{ name, type }` make the list authoritative (every param bound, every `$name`
 * declared, values type-checked); bare name strings are documentation only.
 *
 * A covenant spend needs an `indexer` as well as an `emulator`: the co-signer resolves each
 * input's prevout from the previous ark tx the PSBT carries. Pure tapscript spends need neither.
 *
 * @example
 * ```typescript
 * const htlcProgram = {
 *     version: 0,
 *     name: "htlc", // metadata only — round-tripped, never compiled
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

import type { Network, NetworkName } from "../networks";
import { DEFAULT_NETWORK, getNetwork, networks, resolveEmulatorPubkey } from "../networks";
import type { ArkProvider } from "../providers/ark";
import type { EmulatorProvider } from "../providers/emulator";
import type { IndexerProvider } from "../providers/indexer";
import type { Identity } from "../identity";
import type { ArkadeBroadcaster, VirtualCoin } from "../wallet";
import { getNormalizedVtxos, isVtxoSpent } from "../wallet";
import { CSVMultisigTapscript } from "../script/tapscript";
import type { TapLeafScript } from "../script/base";
import { toXOnly } from "../utils/keys";
import {
    assertSubmittedArkTxid,
    buildOffchainTx,
    matchServerCheckpoints,
    type ArkTxInput,
} from "../utils/arkTransaction";
import { ConditionWitness, PrevArkTxField, setArkPsbtField } from "../utils/unknownFields";
import { attachPrevArkTxs, PrevTxUnavailableError } from "../utils/prevoutTx";
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

// Re-exported so existing `from "./contract"` importers keep working.
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
    type TweakedSigner,
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
 * The statically-typed `functions` map of a contract: precisely typed per function for a literal
 * program, the loose {@link CallableFunctions} for the widened {@link Program}.
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
     * Raw bytes of the ark tx that created this VTXO, attached as input 0's PrevArkTx. Overrides
     * the indexer-resolved value; supply it when the tx isn't indexable yet (a recursive covenant
     * spending an ark tx the caller just built).
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

/** What {@link Arkade} needs from the Arkade server; see {@link ArkadeConnectOptions.arkade}. */
export type ArkadeServerProvider = Pick<ArkProvider, "getInfo"> & Partial<ArkadeBroadcaster>;

/** Options for {@link Arkade.connect}. */
export interface ArkadeConnectOptions {
    /**
     * The Arkade server provider. Only `getInfo` is required (enough to derive, register and
     * inspect contracts); without `submitTx`/`finalizeTx`, `.send()` throws. So a caller already
     * holding `wallet.getArkadeInfo()` can connect without a second `/v1/info` round-trip.
     */
    arkade: ArkadeServerProvider;
    /**
     * The co-signing (introspector/emulator) service. Required only for functions with an
     * `arkadeScript` (covenant paths).
     */
    emulator?: EmulatorProvider;
    /**
     * Indexer — enables `getUtxos`/`getBalance` and coin auto-selection, and
     * resolves the previous ark txs a covenant spend must carry (see
     * {@link attachPrevArkTxs}). Required for covenant spends.
     */
    indexer?: Pick<IndexerProvider, "getVtxos" | "getVirtualTxs">;
    /** Signer for paths that require a user signature; optional for watch-only. */
    identity?: Identity;
    /**
     * Network for address derivation. Defaults to the network the server
     * reports on `getInfo` — or the SDK default when the server names none.
     */
    network?: Network;
    /**
     * Co-sign with this emulator key (33-byte compressed hex) instead of the one pinned for
     * `network`. Needed after a key rotation ahead of this SDK, for a self-hosted emulator, or on
     * networks with no pinned key (signet, testnet, a hand-built `Network` — those throw without
     * it). Setting it means trusting that operator as co-signer.
     *
     * @see resolveEmulatorPubkey
     */
    emulatorPubkey?: string;
    /**
     * The wallet's contract manager (`wallet.getContractManager()`). Enables
     * {@link ArkadeContract.register}, and makes {@link ArkadeContract.getUtxos} read
     * repository-backed state for registered contracts instead of the indexer.
     */
    contractManager?: IContractManager;
}

/**
 * A connected Arkade client holding the providers and resolved network constants (server key,
 * co-signer key, checkpoint closure), so creating contracts is synchronous.
 */
export class Arkade {
    readonly arkProvider: ArkadeServerProvider;
    /** The co-signing service, or undefined for emulator-less (pure tapscript) usage. */
    readonly emulator: EmulatorProvider | undefined;
    readonly network: Network;
    readonly serverKey: Uint8Array;
    /**
     * The co-signer key covenants are built against (33-byte compressed), present only when an
     * emulator is configured. Resolved from the network or `emulatorPubkey`, never the emulator's
     * own report. If a claim is refused, compare it with the emulator's `/v1/info` `signerPubkey`:
     * a difference means the network rotated and this SDK's pin is stale.
     */
    readonly emulatorKey: Uint8Array | undefined;
    readonly checkpoint: CSVMultisigTapscript.Type;
    readonly indexer?: Pick<IndexerProvider, "getVtxos" | "getVirtualTxs">;
    readonly identity?: Identity;
    /** The signing identity's x-only public key, resolved at connect — identifies which inputs the wallet signs. */
    readonly userKey?: Uint8Array;
    /** The wallet's contract manager, when contract persistence is wired up. */
    readonly contractManager?: IContractManager;

    private constructor(fields: {
        arkProvider: ArkadeServerProvider;
        emulator: EmulatorProvider | undefined;
        network: Network;
        serverKey: Uint8Array;
        emulatorKey: Uint8Array | undefined;
        checkpoint: CSVMultisigTapscript.Type;
        indexer?: Pick<IndexerProvider, "getVtxos" | "getVirtualTxs">;
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
        const serverKey = toXOnly(hex.decode(info.signerPubkey), "ark signer key");
        const checkpoint = CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript));
        // Server-reported network, so a test-network server doesn't yield mainnet addresses.
        const network =
            opts.network ??
            (Object.hasOwn(networks, info.network)
                ? getNetwork(info.network as NetworkName)
                : DEFAULT_NETWORK);

        // Pinned key, NOT the emulator's own /v1/info: otherwise whatever answers that URL picks
        // the key covenants commit to. A rotation is invisible until the pin ships;
        // `emulatorPubkey` covers that window.
        let emulatorKey: Uint8Array | undefined;
        if (opts.emulator) {
            emulatorKey = hex.decode(resolveEmulatorPubkey(network, opts.emulatorPubkey));
        }

        // Up-front so contract instantiation stays synchronous.
        let userKey: Uint8Array | undefined;
        if (opts.identity) {
            userKey = toXOnly(await opts.identity.xOnlyPublicKey(), "identity key");
        }

        return new Arkade({
            arkProvider: opts.arkade,
            emulator: opts.emulator,
            network,
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
     * Instantiate a contract from a program and its constructor arguments. `const` inference keeps
     * the program's literal type, so `functions` is strongly typed.
     *
     * Unbound declared `server`/`user` params default to the client's server key / identity key;
     * explicit args win.
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
     * Rebuild a callable contract from a persisted `"arkade"` row. Compiles with the stored keys,
     * not the client's current ones, so script and address survive a server signer rotation.
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

    /** Callable spending paths: `functions.<name>(...args)` (see {@link ContractFunctions}). */
    get functions(): ContractFunctions<P> {
        const out: CallableFunctions = {};
        for (const fn of this.compiled) {
            out[fn.name] = (...callArgs: ArkadeArgValue[]) =>
                new ArkadeTransactionBuilder(this, fn, bindInputs(fn, callArgs));
        }
        return out as unknown as ContractFunctions<P>;
    }

    /**
     * The `createContract` payload (serialized program, args, keys, script, address), for
     * registering through a manager the client does not hold.
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
     * Persist this contract through the wallet's {@link IContractManager} (stored, watched,
     * counted in balances, re-derivable via the `"arkade"` handler). Idempotent per script.
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
     * Spendable VTXOs locked by this contract: repository-backed when registered with a
     * `contractManager`, otherwise a direct indexer query. Both drop spent and unrolled outputs;
     * only the indexer branch (`spendableOnly`) also drops swept coins.
     */
    async getUtxos(): Promise<VirtualCoin[]> {
        const manager = this.client.contractManager;
        const scriptHex = hex.encode(this.pkScript);
        if (manager) {
            const [registered] = await manager.getContracts({ script: scriptHex });
            if (registered) {
                const [withVtxos] = await manager.getContractsWithVtxos({ script: scriptHex });
                // Not `canSpendOffchain`: that would also drop swept coins, which this returns.
                return (withVtxos?.vtxos ?? []).filter((v) => !isVtxoSpent(v) && !v.isUnrolled);
            }
        }
        if (!this.client.indexer) {
            throw new Error("ArkadeContract.getUtxos: an indexer is required");
        }
        const { vtxos } = await getNormalizedVtxos(this.client.indexer, {
            scripts: [scriptHex],
            spendableOnly: true,
        });
        // Re-checked locally: the server's `spendableOnly` is not a fact to lean on.
        return vtxos.filter((v) => !isVtxoSpent(v) && !v.isUnrolled);
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
                // scure's `amount` is optional; a missing one would silently skew the balance math.
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

        // Inputs must equal outputs; change takes any surplus (copy keeps `build()` idempotent).
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

        // Set first: the resolver below skips inputs already carrying the field (the emulator
        // refuses an input bearing two).
        if (coin.sourceTx) {
            setArkPsbtField(arkTx, 0, PrevArkTxField, coin.sourceTx);
        }

        // Emulator v0.0.7+ requires PrevArkTx on every input. Ark input i spends checkpoint i,
        // which spends inputs[i], so carry the coin's own creating tx, not the checkpoint.
        // arkd-direct spends stay byte-identical.
        if (this.fn.arkadeScript) {
            const indexer = this.contract.client.indexer;
            if (!indexer) {
                throw new PrevTxUnavailableError(
                    "covenant spends require an `indexer` on the Arkade client to resolve the previous ark tx of each input",
                );
            }
            await attachPrevArkTxs(
                arkTx,
                [coin.txid, ...this.fundingCoins.map((c) => c.txid)],
                indexer,
            );
        }

        const condition = (def.tapscript.witness ?? []).map((w) => this.witnessBytes(w));
        if (condition.length > 0) {
            setArkPsbtField(arkTx, 0, ConditionWitness, condition);
            setArkPsbtField(checkpoints[0], 0, ConditionWitness, condition);
        }

        // Asset packet (type 0) then emulator packet (type 1), in one OP_RETURN extension.
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

        const userInputs = this.userInputIndexes();

        if (this.fn.arkadeScript) {
            // Covenant path: the emulator runs the arkade script, adds the remaining
            // co-signatures (incl. the contract checkpoint) and finalizes with arkd.
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

        // Pure-tapscript path → arkd directly: sign the ark tx, submit UNSIGNED checkpoints, then
        // sign the server-returned checkpoints and finalize.
        // NOTE: not yet covered by integration tests.
        if (!client.identity) {
            throw new Error("a signing identity is required for non-covenant spends");
        }
        // Checked before anything is signed.
        const ark = client.arkProvider;
        if (!ark.submitTx || !ark.finalizeTx) {
            throw new Error(
                "broadcasting requires an `arkade` provider with `submitTx`/`finalizeTx` on the Arkade client",
            );
        }
        const signedArk = await this.signArk(arkTx, userInputs);
        const res = await ark.submitTx(
            base64.encode(signedArk.toPSBT()),
            checkpoints.map((c) => base64.encode(c.toPSBT())),
        );
        assertSubmittedArkTxid(res, signedArk, "submitTx");
        const matched = matchServerCheckpoints(res.signedCheckpointTxs, checkpoints, "submitTx");
        const finalCps = await Promise.all(
            matched.map(async ({ server }) =>
                base64.encode((await client.identity!.sign(server, [0])).toPSBT()),
            ),
        );
        await ark.finalizeTx(res.arkTxid, finalCps);
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
        // Smallest covering coin, else the largest (the rest may come via `.fund()`).
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
 * Attach packets as an Extension OP_RETURN, mutating `tx`. Placement per the on-chain rules:
 * merge into an existing extension, else insert before the P2A anchor, else append.
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
    if (lastOut?.script && equalBytes(lastOut.script, ANCHOR_PKSCRIPT)) {
        tx.updateOutput(lastIdx, { script: newOut.script, amount: newOut.amount });
        tx.addOutput({ script: lastOut.script, amount: lastOut.amount ?? 0n });
        return;
    }

    tx.addOutput({ script: newOut.script, amount: newOut.amount });
}
