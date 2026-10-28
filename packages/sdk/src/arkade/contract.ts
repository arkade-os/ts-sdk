/**
 * Arkade Contract — artifact-driven, high-level covenant API.
 *
 * A contract is a {@link Program}: named functions, each split into a `tapscript` segment
 * enforced on-chain and an `arkadeScript` segment emulated by the co-signing service. Compiler
 * artifacts are normalized into this model, sharing the resolver with hand-written programs.
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
 * declared, values type-checked).
 *
 * A covenant spend needs an `indexer` as well as an `emulator`: the co-signer resolves each
 * input's prevout from the previous ark tx the PSBT carries. Pure tapscript spends need neither.
 *
 * @example
 * ```typescript
 * const htlcProgram = {
 *     version: 1,
 *     name: "htlc", // metadata only — round-tripped, never compiled
 *     params: [
 *         { name: "hash", type: "bytes20" },
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
import type { ArkadeInfo, ArkProvider } from "../providers/ark";
import type { EmulatorProvider } from "../providers/emulator";
import type { IndexerProvider } from "../providers/indexer";
import type { Identity } from "../identity";
import type { ArkadeBroadcaster, VirtualCoin } from "../wallet";
import { getNormalizedVtxos, isVtxoSpent } from "../wallet";
import { CSVMultisigTapscript } from "../script/tapscript";
import type { TapLeafScript } from "../script/base";
import { toXOnly } from "../utils/keys";
import { timelockToSequence } from "../utils/timelock";
import { toTimelock } from "../wallet/timelockPolicy";
import {
    assertSubmittedArkTxid,
    buildOffchainTx,
    matchServerCheckpoints,
    submitViaEmulator,
    type ArkTxInput,
} from "../utils/arkTransaction";
import {
    ConditionWitness,
    getArkPsbtFields,
    PrevArkTxField,
    setArkPsbtField,
} from "../utils/unknownFields";
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
import { ContractManager, type IContractManager } from "../contracts/contractManager";
import {
    isContractVtxoEvent,
    type Contract,
    type ContractEvent,
    type ContractVtxoEvent,
    type ExtendedContractVtxo,
} from "../contracts/types";
import type { ContractRepository } from "../repositories/contractRepository";
import { InMemoryWalletRepository } from "../repositories/inMemory/walletRepository";
import { resolveArkadeService, type ArkadeService, type ResolvedArkadeService } from "./service";
import {
    ArkadeProgramScript,
    deserializeArkadeContractParams,
    serializeArkadeContractParams,
    witnessRefToBytes,
    validateParamValue,
    type ArkadeArgValue,
    type ArkadeFunction,
    type ArkadeParamValue,
    type ArkadeValueType,
    type CompiledProgramFunction,
    type InputDef,
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

/** The argument tuple of a function, derived from its declared `inputs`. */
type ArgsTuple<I extends readonly InputDef[]> = {
    [K in keyof I]: ArkadeValueType[I[K]["type"]];
};

/** The call signature arguments for one function (nullary when `inputs` is absent). */
type FnArgs<F extends ArkadeFunction> = F extends {
    inputs: infer I extends readonly InputDef[];
}
    ? ArgsTuple<I>
    : [];

/** A contract's functions returning `R`: typed per function for a literal program, else loose. */
type FunctionMap<P extends Program, R> = string extends keyof P["functions"]
    ? Record<string, (...args: ArkadeArgValue[]) => R>
    : {
          [K in keyof P["functions"]]: (...args: FnArgs<P["functions"][K]>) => R;
      };

/**
 * The statically-typed `functions` map of a contract: precisely typed per function for a literal
 * program, the loose {@link CallableFunctions} for the widened {@link Program}.
 */
export type ContractFunctions<P extends Program> = FunctionMap<P, ArkadeTransactionBuilder>;

/** The statically-typed `unlock` map of a contract, typed like {@link ContractFunctions}. */
export type ContractUnlockers<P extends Program> = FunctionMap<P, ArkadeUnlocker>;

// --- Spend types -----------------------------------------------------------

/** A spendable coin (VTXO) — outpoint + value. */
export interface Utxo {
    txid: string;
    vout: number;
    value: number;
    /**
     * The coin's scriptPubKey (hex), as {@link ArkadeContract.getUtxos} returns it. When set,
     * `.from()` refuses the coin unless it matches the contract spending it.
     */
    script?: string;
    /**
     * Raw bytes of the ark tx that created this VTXO, attached as its input's PrevArkTx. Overrides
     * the indexer-resolved value; supply it when the tx isn't indexable yet (a recursive covenant
     * spending an ark tx the caller just built).
     */
    sourceTx?: Uint8Array;
}

/**
 * A contract function bound to its call arguments, from `contract.unlock.<name>(...args)`.
 * Pass it to {@link ArkadeTransactionBuilder.from} to spend coins through that function.
 */
export interface ArkadeUnlocker {
    // `<any>`: a concrete `P` would not assign here.
    readonly contract: ArkadeContract<any>;
    readonly fn: CompiledProgramFunction;
    readonly args: Record<string, ArkadeArgValue>;
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

/** Fields shared by both forms of {@link ArkadeConnectOptions}. */
interface ArkadeConnectCommonOptions {
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
     * {@link ArkadeContract.register} and {@link ArkadeContract.on}, and makes
     * {@link ArkadeContract.getUtxos} read repository-backed state for registered contracts
     * instead of the indexer. Never disposed by {@link Arkade.dispose}.
     */
    contractManager?: IContractManager;
}

/**
 * The one-liner form: name the deployment, and `connect` resolves the providers (and, for
 * `{ network: "bitcoin" }`, the emulator).
 */
export interface ArkadeConnectServiceOptions extends ArkadeConnectCommonOptions {
    service: ArkadeService;
    /**
     * Persist contracts here. The client builds and owns a contract manager over it (with an
     * in-memory VTXO store), enabling {@link ArkadeContract.register} and
     * {@link ArkadeContract.on}; {@link Arkade.dispose} stops it. Exclusive with
     * `contractManager`. Deliberately narrower than the wallet's `StorageConfig`.
     */
    storage?: { contractRepository: ContractRepository };
    arkade?: never;
    emulator?: never;
    indexer?: never;
}

/** The provider form: hand over providers you already hold (e.g. a wallet's). */
export interface ArkadeConnectProviderOptions extends ArkadeConnectCommonOptions {
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
    service?: never;
    storage?: never;
}

/** Options for {@link Arkade.connect}: `service` and `arkade` are exclusive. */
export type ArkadeConnectOptions = ArkadeConnectServiceOptions | ArkadeConnectProviderOptions;

/** Event types {@link ArkadeContract.on} reports. */
export type ArkadeContractEventType = "vtxo_received" | "vtxo_spent" | "connection_reset";

/** The event an {@link ArkadeContract.on} handle of type `T` receives. */
export type ArkadeContractEvent<T extends ArkadeContractEventType = ArkadeContractEventType> =
    T extends "connection_reset"
        ? Extract<ContractEvent, { type: "connection_reset" }>
        : Extract<ContractVtxoEvent, { type: T }>;

/** Returned by {@link ArkadeContract.on}. */
export interface ArkadeContractSubscription {
    /** Stop delivery to this handle. Idempotent. */
    off(): void;
}

type EventHandle = {
    type: ArkadeContractEventType;
    callback: (event: ArkadeContractEvent) => void | Promise<void>;
};

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
    /** Bare protocol delay (blocks below 512, seconds otherwise), resolved only when needed. */
    readonly serverExitDelay?: bigint;
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
    /** The contract manager, when contract persistence is wired up (passed in or owned). */
    readonly contractManager?: IContractManager;
    /** Whether {@link connect} built {@link contractManager}, so {@link dispose} must stop it. */
    private readonly ownsContractManager: boolean;
    /** {@link ArkadeContract.on} handles by contract script (hex). */
    private readonly handles = new Map<string, Set<EventHandle>>();
    /** The single `onContractEvent` subscription fanning out to {@link handles}. */
    private unsubscribeEvents?: () => void;
    private disposed = false;

    private constructor(fields: {
        arkProvider: ArkadeServerProvider;
        emulator: EmulatorProvider | undefined;
        network: Network;
        serverKey: Uint8Array;
        serverExitDelay?: bigint;
        emulatorKey: Uint8Array | undefined;
        checkpoint: CSVMultisigTapscript.Type;
        indexer?: Pick<IndexerProvider, "getVtxos" | "getVirtualTxs">;
        identity?: Identity;
        userKey?: Uint8Array;
        contractManager?: IContractManager;
        ownsContractManager?: boolean;
    }) {
        this.arkProvider = fields.arkProvider;
        this.emulator = fields.emulator;
        this.network = fields.network;
        this.serverKey = fields.serverKey;
        this.serverExitDelay = fields.serverExitDelay;
        this.emulatorKey = fields.emulatorKey;
        this.checkpoint = fields.checkpoint;
        this.indexer = fields.indexer;
        this.identity = fields.identity;
        this.userKey = fields.userKey;
        this.contractManager = fields.contractManager;
        this.ownsContractManager = fields.ownsContractManager ?? false;
    }

    /**
     * Connect and resolve the server key, checkpoint closure and (if present) the co-signer key.
     *
     * @example
     * ```typescript
     * const arkade = await Arkade.connect({
     *     service: { network: "bitcoin" },
     *     identity,
     *     storage: { contractRepository },
     * });
     * ```
     */
    static async connect(opts: ArkadeConnectOptions): Promise<Arkade> {
        if (opts.storage && opts.contractManager) {
            throw new Error(
                "Arkade.connect: pass either `storage` or `contractManager`, not both — `storage` builds a second manager over another repository",
            );
        }

        let arkProvider: ArkadeServerProvider;
        let emulator: EmulatorProvider | undefined;
        let indexer: Pick<IndexerProvider, "getVtxos" | "getVirtualTxs"> | undefined;
        let info: ArkadeInfo;
        let resolved: ResolvedArkadeService | undefined;
        if (opts.service) {
            resolved = await resolveArkadeService(opts.service);
            ({ arkProvider, emulator, info } = resolved);
            indexer = resolved.indexerProvider;
        } else {
            arkProvider = opts.arkade;
            emulator = opts.emulator;
            indexer = opts.indexer;
            info = await opts.arkade.getInfo();
        }

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
        if (emulator) {
            emulatorKey = hex.decode(resolveEmulatorPubkey(network, opts.emulatorPubkey));
        }

        // Up-front so contract instantiation stays synchronous.
        let userKey: Uint8Array | undefined;
        if (opts.identity) {
            userKey = toXOnly(await opts.identity.xOnlyPublicKey(), "identity key");
        }

        let contractManager = opts.contractManager;
        let ownsContractManager = false;
        if (resolved && opts.storage) {
            const { onchainProvider } = resolved;
            contractManager = await ContractManager.create({
                indexerProvider: resolved.indexerProvider,
                contractRepository: opts.storage.contractRepository,
                // Mandatory, and session-scoped: VTXOs are re-read from the indexer on reconnect.
                walletRepository: new InMemoryWalletRepository(),
                // Parity with the wallet-owned manager: without it every height-typed CLTV reads
                // as unsatisfied. @see ContractManagerConfig.chainTip
                chainTip: async () => {
                    const { height, time } = await onchainProvider.getChainTip();
                    return { height, time };
                },
            });
            ownsContractManager = true;
        }

        return new Arkade({
            arkProvider,
            emulator,
            network,
            serverKey,
            serverExitDelay: info.unilateralExitDelay,
            emulatorKey,
            checkpoint,
            indexer,
            identity: opts.identity,
            userKey,
            contractManager,
            ownsContractManager,
        });
    }

    /**
     * Stop event delivery to every {@link ArkadeContract.on} handle and, when {@link connect}
     * built the contract manager (`storage`), dispose it. A caller-passed manager keeps running.
     */
    dispose(): void {
        this.disposed = true;
        this.unsubscribeEvents?.();
        this.unsubscribeEvents = undefined;
        this.handles.clear();
        if (this.ownsContractManager) this.contractManager?.dispose();
    }

    /**
     * @internal Add a handle for `script`, subscribing to the manager on first use; the last
     * handle's `off()` releases the subscription.
     */
    addEventHandle(manager: IContractManager, script: string, handle: EventHandle): () => void {
        if (this.disposed) throw new Error("ArkadeContract.on: the Arkade client is disposed");
        let set = this.handles.get(script);
        if (!set) {
            set = new Set();
            this.handles.set(script, set);
        }
        set.add(handle);
        if (!this.unsubscribeEvents) {
            this.unsubscribeEvents = manager.onContractEvent((event) => this.dispatch(event));
        }
        return () => {
            const current = this.handles.get(script);
            if (!current) return;
            current.delete(handle);
            if (current.size === 0) this.handles.delete(script);
            if (this.handles.size === 0) {
                this.unsubscribeEvents?.();
                this.unsubscribeEvents = undefined;
            }
        };
    }

    private dispatch(event: ContractEvent): void {
        let targets: EventHandle[];
        if (event.type === "connection_reset") {
            targets = [...this.handles.values()]
                .flatMap((set) => [...set])
                .filter((h) => h.type === "connection_reset");
        } else if (isContractVtxoEvent(event)) {
            targets = [...(this.handles.get(event.contractScript) ?? [])].filter(
                (h) => h.type === event.type,
            );
        } else {
            return; // watch-only activity: not a registered contract
        }
        const report = (error: unknown) =>
            console.error("Error in ArkadeContract event handler:", error);
        // Isolated: a throwing or rejecting handler can't starve its siblings.
        for (const handle of targets) {
            try {
                Promise.resolve(handle.callback(event)).catch(report);
            } catch (error) {
                report(error);
            }
        }
    }

    /**
     * Instantiate a contract from a program and its constructor arguments. `const` inference keeps
     * the program's literal type, so `functions` is strongly typed.
     *
     * Declared `server`/`user` params default to the client's keys. Compiler
     * artifacts reserve the server key and exit delay to the connected server.
     */
    contract<const P extends Program>(
        program: P,
        args: Record<string, ArkadeParamValue> = {},
    ): ArkadeContract<P> {
        const declared = (program.params ?? []).map((p) => p.name);
        if (declared.includes("server") && args.server === undefined) {
            args = { ...args, server: this.serverKey };
        }
        if (declared.includes("user") && args.user === undefined && this.userKey) {
            args = { ...args, user: this.userKey };
        }
        if (declared.includes("SERVER_EXIT_DELAY")) {
            const delay = this.serverExitDelay;
            if (delay === undefined || delay <= 0n)
                throw new Error(
                    "compiler artifact: server must provide a positive unilateral exit delay",
                );
            const typed = toTimelock(delay);
            if (typed.type === "seconds" && delay % 512n !== 0n) {
                throw new Error(
                    `compiler artifact: server exit delay ${delay}s must be a multiple of 512 seconds`,
                );
            }
            const sequence = BigInt(timelockToSequence(typed));
            if (
                args.SERVER_EXIT_DELAY !== undefined &&
                args.SERVER_EXIT_DELAY !== sequence &&
                args.SERVER_EXIT_DELAY !== Number(sequence)
            ) {
                throw new Error(
                    "compiler artifact: reserved SERVER_EXIT_DELAY must match the connected server",
                );
            }
            args = { ...args, SERVER_EXIT_DELAY: sequence };
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
        const out: CallableFunctions = Object.create(null);
        for (const fn of this.compiled) {
            out[fn.name] = (...callArgs: ArkadeArgValue[]) =>
                new ArkadeTransactionBuilder({
                    contract: this,
                    fn,
                    args: bindInputs(fn, callArgs),
                });
        }
        return out as unknown as ContractFunctions<P>;
    }

    /** Spending paths bound to their arguments, for `.from(coins, contract.unlock.<name>(...))`. */
    get unlock(): ContractUnlockers<P> {
        const out: Record<string, (...args: ArkadeArgValue[]) => ArkadeUnlocker> =
            Object.create(null);
        for (const fn of this.compiled) {
            out[fn.name] = (...callArgs: ArkadeArgValue[]) => ({
                contract: this,
                fn,
                args: bindInputs(fn, callArgs),
            });
        }
        return out as unknown as ContractUnlockers<P>;
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
        const manager = this.requireManager("register");
        return manager.createContract({
            ...this.toContractParams(),
            label: options?.label,
            metadata: options?.metadata,
        });
    }

    /**
     * Report this contract's activity: `vtxo_received`/`vtxo_spent` for its script, and
     * `connection_reset` when the manager's event stream reconnects. Registers the contract
     * (idempotent) so it is persisted and watched; requires a contract manager (`storage` or
     * `contractManager` on {@link Arkade.connect}).
     *
     * Activity is reported from subscription on — coins that predate it are not replayed. After
     * subscribing, and on every `connection_reset` (the manager re-syncs silently), read stored
     * state with {@link getVtxos}.
     *
     * @example
     * ```typescript
     * const spent = await htlc.on("vtxo_spent", (e) => console.log(e.vtxos));
     * const reset = await htlc.on("connection_reset", async () => reconcile(await htlc.getVtxos()));
     * spent.off();
     * ```
     */
    async on<T extends ArkadeContractEventType>(
        type: T,
        callback: (event: ArkadeContractEvent<T>) => void | Promise<void>,
    ): Promise<ArkadeContractSubscription> {
        const manager = this.requireManager("on");
        // Before registering: the watcher may emit during `register()`, and a handle added after
        // it would miss that.
        const off = this.client.addEventHandle(manager, hex.encode(this.pkScript), {
            type,
            callback: callback as EventHandle["callback"],
        });
        try {
            await this.register();
        } catch (error) {
            off();
            throw error;
        }
        return { off };
    }

    /**
     * Every stored VTXO of this contract, spent ones included (`getUtxos` hides those), as the
     * contract manager last synced them. The recovery read for {@link on}. Empty when the
     * contract is not registered.
     */
    async getVtxos(): Promise<ExtendedContractVtxo[]> {
        const manager = this.requireManager("getVtxos");
        const [withVtxos] = await manager.getContractsWithVtxos({
            script: hex.encode(this.pkScript),
        });
        return withVtxos?.vtxos ?? [];
    }

    private requireManager(method: string): IContractManager {
        const manager = this.client.contractManager;
        if (!manager) {
            throw new Error(
                `ArkadeContract.${method} requires a contract manager on the Arkade client — pass \`storage\` or \`contractManager\` to Arkade.connect`,
            );
        }
        return manager;
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
    private readonly extraPackets: ExtensionPacket[] = [];
    private readonly inputs: ContractInput[] = [];
    private changeScript?: Uint8Array;

    /** @internal */
    constructor(private readonly unlocker: ArkadeUnlocker) {}

    private get client(): Arkade {
        return this.unlocker.contract.client;
    }

    /**
     * Spend coins through this function, or through `unlocker` (`other.unlock.<name>(...args)`,
     * same client). Calls add up; contract coins come first, in call order, then `.fund()` inputs.
     *
     * Every coin's script sees the same outputs: "output 0 pays X" passes once for all of them.
     * For one payment per coin, the contract must check `INSPECTNUMINPUTS` or `PUSHCURRENTINPUTINDEX`.
     */
    from(coins: Utxo | Utxo[], unlocker: ArkadeUnlocker = this.unlocker): this {
        const list = Array.isArray(coins) ? coins : [coins];
        if (list.length === 0) throw new Error("from(): no coins given");
        const { contract, fn } = unlocker;
        if (contract.client !== this.client) {
            throw new Error(`from(): ${fn.name} belongs to a contract on another Arkade client`);
        }
        const script = hex.encode(contract.pkScript);
        const taken = new Set(this.inputs.map(({ coin: c }) => `${c.txid}:${c.vout}`));
        for (const coin of list) {
            const outpoint = `${coin.txid}:${coin.vout}`;
            if (coin.script && coin.script !== script) {
                throw new Error(
                    `from(): coin ${outpoint} is not locked by the contract of ${fn.name}`,
                );
            }
            if (taken.has(outpoint))
                throw new Error(`from(): coin ${outpoint} is already an input`);
            taken.add(outpoint);
        }
        this.inputs.push(...list.map((coin) => ({ coin, unlocker })));
        return this;
    }

    /**
     * Add extra inputs the caller funds (e.g. a taker's own coins in a swap).
     * These come after the contract coins and are signed with the client identity.
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

    /** Add an extension packet; reusing the asset or emulator packet's type fails at build. */
    withPacket(packet: ExtensionPacket): this {
        this.extraPackets.push(packet);
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
        const { arkTx, checkpoints } = await this.assemble();
        return { arkTx, checkpoints };
    }

    private async assemble(): Promise<{
        arkTx: Transaction;
        checkpoints: Transaction[];
        inputs: ContractInput[];
    }> {
        for (const { fn } of this.unlockers()) {
            if (fn.def.tapscript.csv) {
                throw new Error(
                    `${fn.name}: CSV leaves require an aged onchain output; the offchain builder creates fresh checkpoints — use the wallet's unilateral exit flow`,
                );
            }
        }
        if (this.outputs.length === 0) {
            throw new Error("ArkadeTransactionBuilder: at least one output is required");
        }
        const outputsSum = this.outputs.reduce((s, o) => s + (o.amount ?? 0n), 0n);
        const inputs: ContractInput[] =
            this.inputs.length > 0
                ? [...this.inputs]
                : [{ coin: await this.selectCoin(outputsSum), unlocker: this.unlocker }];
        const coinsSum = inputs.reduce((s, { coin }) => s + BigInt(coin.value), 0n);

        // Inputs must equal outputs; change takes any surplus (copy keeps `build()` idempotent).
        const outputs = [...this.outputs];
        const fundingSum = this.fundingCoins.reduce((s, f) => s + BigInt(f.value), 0n);
        const surplus = coinsSum + fundingSum - outputsSum;
        if (surplus < 0n) {
            throw new Error(
                `ArkadeTransactionBuilder: insufficient inputs — outputs ${outputsSum} exceed inputs ${coinsSum + fundingSum}`,
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
                ...inputs.map(({ coin, unlocker }) => ({
                    txid: coin.txid,
                    vout: coin.vout,
                    value: coin.value,
                    tapLeafScript: unlocker.fn.tapLeafScript,
                    tapTree: unlocker.contract.tapTree,
                })),
                ...this.fundingCoins,
            ],
            outputs,
            this.client.checkpoint,
        );

        // Set first: the resolver below skips inputs already carrying the field (the emulator
        // refuses an input bearing two).
        inputs.forEach(({ coin }, i) => {
            if (coin.sourceTx) setArkPsbtField(arkTx, i, PrevArkTxField, coin.sourceTx);
        });

        // Emulator v0.0.7+ requires PrevArkTx on every input. Ark input i spends checkpoint i,
        // which spends inputs[i], so carry the coin's own creating tx, not the checkpoint.
        // arkd-direct spends stay byte-identical.
        if (inputs.some(({ unlocker }) => unlocker.fn.arkadeScript)) {
            const indexer = this.client.indexer;
            if (!indexer) {
                throw new PrevTxUnavailableError(
                    "covenant spends require an `indexer` on the Arkade client to resolve the previous ark tx of each input",
                );
            }
            await attachPrevArkTxs(
                arkTx,
                [...inputs.map(({ coin }) => coin), ...this.fundingCoins].map((c) => c.txid),
                indexer,
            );
        }

        inputs.forEach(({ unlocker }, i) => {
            const condition = (unlocker.fn.def.tapscript.witness ?? []).map((w) =>
                witnessBytes(unlocker, w),
            );
            if (condition.length === 0) return;
            setArkPsbtField(arkTx, i, ConditionWitness, condition);
            setArkPsbtField(checkpoints[i], 0, ConditionWitness, condition);
        });

        // Asset (type 0), emulator (type 1), then caller packets, in one OP_RETURN extension.
        const packets: ExtensionPacket[] = [];
        if (this.assetSpecs.length > 0) {
            packets.push(this.buildAssetPacket());
        }
        const entries = inputs.flatMap(({ unlocker }, vin) => {
            const { arkadeScript, def } = unlocker.fn;
            if (!arkadeScript) return [];
            const stack = (def.arkadeScript?.witness ?? []).map((w) => witnessBytes(unlocker, w));
            return [{ vin, script: arkadeScript, witness: RawWitness.encode(stack) }];
        });
        if (entries.length > 0) {
            packets.push(EmulatorPacket.create(entries) as ExtensionPacket);
        }
        packets.push(...this.extraPackets);
        if (packets.length > 0) {
            attachExtension(arkTx, packets);
        }

        return { arkTx, checkpoints, inputs };
    }

    /** Build, submit and return the finalized transaction. */
    async send(): Promise<ArkadeSpendResult> {
        const client = this.client;
        const userKey = client.userKey;
        for (const { contract, fn } of this.unlockers()) {
            if (
                fn.def.tapscript.signers.some(
                    (signer) => typeof signer === "object" && "tweak" in signer,
                )
            ) {
                throw new Error(
                    `${fn.name}: covenant-tweaked leaf signing is not supported by Identity; use a signer that supports the covenant tweak with build()`,
                );
            }
            const { serverKey } = contract.keys;
            if (
                fn.signerKeys.some(
                    (key) => !equalBytes(key, serverKey) && (!userKey || !equalBytes(key, userKey)),
                )
            ) {
                throw new Error(
                    `${fn.name}: external leaf signatures are required; use build() and sign the PSBT with all required signers`,
                );
            }
        }
        const { arkTx, checkpoints, inputs } = await this.assemble();

        const userInputs = this.userInputIndexes(inputs);

        if (inputs.some(({ unlocker }) => unlocker.fn.arkadeScript)) {
            // Covenant path: the emulator runs the arkade script, adds the remaining
            // co-signatures (incl. the contract checkpoint) and finalizes with arkd.
            if (!client.emulator) {
                throw new Error("covenant spends require an `emulator` on the Arkade client");
            }
            return submitViaEmulator(client.emulator, { arkTx, checkpoints }, client.identity, {
                inputIndexes: userInputs,
            });
        }

        // Pure-tapscript path → arkd directly: sign the ark tx, submit UNSIGNED checkpoints, then
        // sign the server-returned checkpoints and finalize.
        if (!client.identity) {
            throw new Error("a signing identity is required for non-covenant spends");
        }
        // Checked before anything is signed. arkd refuses an input signed by the server alone.
        const serverOnly = inputs.find((_, i) => !userInputs.includes(i));
        if (serverOnly) {
            throw new Error(
                `${serverOnly.unlocker.fn.name}: a tapscript-only spend needs the user's signature on every input, and this leaf has only the server's`,
            );
        }
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
            matched.map(async ({ server, local }) => {
                const signed = await client.identity!.sign(server, [0]);
                // arkd returns checkpoints without the condition witness; finalize needs it back.
                const [condition] = getArkPsbtFields(local, 0, ConditionWitness);
                if (condition && getArkPsbtFields(signed, 0, ConditionWitness).length === 0) {
                    setArkPsbtField(signed, 0, ConditionWitness, condition);
                }
                return base64.encode(signed.toPSBT());
            }),
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
        const { identity } = this.client;
        if (!identity) {
            throw new Error("this spend requires an `identity` to sign its user/funding inputs");
        }
        return identity.sign(arkTx, userInputs);
    }

    /** The functions this spend goes through: the `.from()` ones, else this builder's own. */
    private unlockers(): ArkadeUnlocker[] {
        return this.inputs.length > 0 ? this.inputs.map((i) => i.unlocker) : [this.unlocker];
    }

    /** Indexes of inputs the client owns and must sign (contract inputs + funded inputs). */
    private userInputIndexes(inputs: ContractInput[]): number[] {
        const userKey = this.client.userKey;
        const idxs = inputs.flatMap(({ unlocker }, i) =>
            userKey && unlocker.fn.signerKeys.some((k) => equalBytes(k, userKey)) ? [i] : [],
        );
        for (let i = 0; i < this.fundingCoins.length; i++) idxs.push(inputs.length + i);
        return idxs;
    }

    private async selectCoin(amount: bigint): Promise<Utxo> {
        const utxos = await this.unlocker.contract.getUtxos();
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
}

/** A contract coin and the function it is spent through. */
interface ContractInput {
    coin: Utxo;
    unlocker: ArkadeUnlocker;
}

// --- helpers ---------------------------------------------------------------

function witnessBytes({ contract, args }: ArkadeUnlocker, ref: WitnessRef): Uint8Array {
    return witnessRefToBytes(ref, args, contract.args);
}

/** Bind positional call arguments to a function's declared input names. */
function bindInputs(
    fn: CompiledProgramFunction,
    callArgs: ArkadeArgValue[],
): Record<string, ArkadeArgValue> {
    const inputs = fn.def.inputs ?? [];
    if (callArgs.length !== inputs.length) {
        throw new Error(
            `${fn.name}: expected ${inputs.length} argument(s), got ${callArgs.length}`,
        );
    }
    const bound: Record<string, ArkadeArgValue> = Object.create(null);
    inputs.forEach((def, i) => {
        if (Object.hasOwn(bound, def.name))
            throw new Error(`${fn.name}: duplicate input '${def.name}'`);
        validateParamValue(def, callArgs[i]);
        bound[def.name] = callArgs[i];
    });
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
