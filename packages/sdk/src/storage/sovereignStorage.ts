import { hex, base64 } from "@scure/base";
import { TaprootControlBlock } from "@scure/btc-signer";
import { equalBytes } from "@scure/btc-signer/utils.js";
import type { NetworkName } from "../networks.js";
import { ChainTxType } from "../providers/indexer.js";
import type { OnchainProvider } from "../providers/onchain.js";
import { resolveVerifiedSovereignCondition } from "../tree/hashPreimageVerification.js";
import { Transaction } from "../utils/transaction.js";
import { ConditionWitness, getArkPsbtFields } from "../utils/unknownFields.js";
import { Executor, type ExecutorEvent, type ExitFeeWallet } from "../wallet/exit/executor.js";
import { finalizeVirtualTx } from "../wallet/exit/finalizeVirtualTx.js";
import type { BumpStep, ExitPackage } from "../wallet/exit/types.js";
import type {
    DAGNode,
    DAGValidationResult,
    ExitOnchainProvider,
    Outpoint,
    VerificationStorageProvider,
    VerificationIndexerProvider,
    VerificationOnchainProvider,
} from "../tree/vtxoDAGVerification.js";
import {
    VtxoVerificationError,
    computeTxid,
    verifyVtxoComplete,
} from "../tree/vtxoDAGVerification.js";
import { StorageCrypto } from "../utils/cryptoUtils.js";

export interface SovereignExitData {
    /** The specific VTXO root (the user's outpoint) being protected. */
    vtxoRootTxid: string;
    /** The Anchor commitment transaction ID. */
    commitmentTxid: string;
    /** The batch output index on the commitment transaction. */
    batchOutputIndex: number;
    /**
     * Ordered array of finalized, witness-bearing raw transaction hexes
     * (Anchor -> ... -> VTXO Root) ready for 1P1C CPFP package execution.
     */
    broadcastSequence: string[];
    /** Timestamp when this data was secured. */
    securedAt: number;
}

export interface SovereignUnrollPackageOptions {
    /** Target Bitcoin network for the graph-mode unroll package. */
    network: NetworkName;
    /** Target fee rate in sat/vB for 1P1C CPFP anchor bumps. */
    feeRate: number;
    /** Output index on the root VTXO transaction (default: 0). */
    vout?: number;
    /** Optional unix-seconds expiry hint carried onto the package. */
    validUntil?: number;
}

export interface ExecuteSovereignUnrollOptions extends SovereignUnrollPackageOptions {
    /**
     * On-chain fee wallet implementing `ExitFeeWallet` (e.g. `OnchainWallet`).
     * Builds and signs a CPFP child spending each virtual transaction's P2A anchor
     * output so zero-fee virtual transactions are broadcast as 1P1C packages,
     * never standalone.
     */
    feeWallet: ExitFeeWallet;
    /** Confirmation poll interval (ms) forwarded to `UnilateralExit.Executor`. */
    pollIntervalMs?: number;
    /** Optional abort signal forwarded to `UnilateralExit.Executor`. */
    signal?: AbortSignal;
    /** Optional listener invoked for each canonical `ExecutorEvent`. */
    onEvent?: (event: ExecutorEvent) => void;
    /**
     * Called, before a hop is broadcast, whenever its absolute (nLockTime) or relative (BIP-68)
     * timelock is not yet mature. Fired again only when the reason changes.
     */
    onPending?: (pending: SovereignUnrollPending) => void;
    /**
     * When true (default) an immature hop is waited on (polling every `pollIntervalMs`) before
     * broadcast. When false the unroll stops at that hop with `success: false` and the pending
     * reason as `error`, without broadcasting it.
     */
    waitForMaturity?: boolean;
}

/** A hop held back before broadcast because a timelock has not matured. */
export interface SovereignUnrollPending {
    txid: string;
    reason: string;
}

/**
 * Outcome of {@link executeSovereignUnroll}. `swept` is always `false`: the unroll only lands the
 * VTXO's transaction chain on-chain; the funds stay in the VTXO output until its CSV exit leaf is
 * swept (`UnilateralExit` / `Unroll.completeUnroll`).
 */
export interface SovereignUnrollResult {
    success: boolean;
    swept: false;
    broadcastedTxids: string[];
    confirmedTxids: string[];
    pending: SovereignUnrollPending[];
    events: ExecutorEvent[];
    error?: string;
}

// ─── Extraction & Orchestration ─────────────────────────────────────────────

/**
 * Assembles the Tapscript witness `[...sigs, preimage, script, controlBlock]` strictly
 * for an unambiguous, verified single-input sovereign conditional spend (e.g. VHTLC claim).
 *
 * Scoped to the sovereign exit pipeline so the shared `finalizeVirtualTx` wallet helper
 * retains its upstream semantics unchanged. Fails closed on any multi-leaf ambiguity,
 * unconditional leaf, unsupported condition script, oversized/wrong preimage, or incomplete
 * signature set.
 */
function finalizeSovereignConditionTx(tx: Transaction, txid: string): Transaction {
    const resolved = resolveVerifiedSovereignCondition(tx, txid);
    if (!resolved) {
        throw new VtxoVerificationError(
            `Transaction ${txid} does not spend an unambiguous verified conditional tapleaf`,
            "INVALID_CONDITION_WITNESS",
            { txid },
        );
    }

    const input = tx.getInput(0);
    const scriptSigs = input.tapScriptSig ?? [];

    // Collect signing key positions (data pushes directly consumed by CHECKSIG*) so 32-byte
    // hash pushes in the condition prefix cannot collide with signing keys.
    const keyPositions: Uint8Array[] = [];
    for (let i = 0; i < resolved.decoded.length - 1; i++) {
        const op = resolved.decoded[i];
        const next = resolved.decoded[i + 1];
        if (
            op instanceof Uint8Array &&
            (op.length === 32 || op.length === 33) &&
            (next === "CHECKSIG" || next === "CHECKSIGVERIFY" || next === "CHECKSIGADD")
        ) {
            keyPositions.push(op);
        }
    }

    if (keyPositions.length === 0) {
        throw new VtxoVerificationError(
            `Transaction ${txid} conditional tapleaf has no CHECKSIG signing keys`,
            "UNSUPPORTED_CONDITION_SCRIPT",
            { txid },
        );
    }

    if (scriptSigs.length !== keyPositions.length) {
        throw new VtxoVerificationError(
            `Transaction ${txid} has ${scriptSigs.length} tapScriptSig entries for ${keyPositions.length} signing keys`,
            "INCOMPLETE_SIGNATURES",
            { txid, sigCount: scriptSigs.length, keyCount: keyPositions.length },
        );
    }

    const sigs = keyPositions
        .map((pubKey) => {
            const matches = scriptSigs.filter(([{ pubKey: sigKey }]) => equalBytes(sigKey, pubKey));
            if (matches.length !== 1) {
                throw new VtxoVerificationError(
                    `Transaction ${txid} must carry exactly one signature for each tapscript key`,
                    "INCOMPLETE_SIGNATURES",
                    { txid, pubKey: hex.encode(pubKey), matchCount: matches.length },
                );
            }
            return matches[0][1];
        })
        .reverse();

    tx.updateInput(0, {
        finalScriptWitness: [
            ...sigs,
            resolved.preimage,
            resolved.script,
            TaprootControlBlock.encode(resolved.leaf[0]),
        ],
    });
    return tx;
}

/**
 * Finalizes a verified DAG node via the canonical SDK `finalizeVirtualTx` helper
 * (or the sovereign-scoped conditional witness assembler for verified `ConditionWitness`
 * spends) and extracts the full SegWit wire serialization (including witness data).
 */
function finalizeNodeToHex(node: DAGNode): string {
    const psbtBase64 = node.rawPsbt || base64.encode(node.tx.toPSBT());
    const decodedTx = Transaction.fromPSBT(base64.decode(psbtBase64));

    let hasConditionWitness = false;
    for (let i = 0; i < decodedTx.inputsLength; i++) {
        if (getArkPsbtFields(decodedTx, i, ConditionWitness).length > 0) {
            hasConditionWitness = true;
            break;
        }
    }

    if (!hasConditionWitness) {
        return finalizeVirtualTx(node.chainTx.type, psbtBase64).hex;
    }

    if (node.chainTx.type === ChainTxType.TREE) {
        throw new VtxoVerificationError(
            `TREE transaction ${node.txid} cannot carry ConditionWitness`,
            "INVALID_CONDITION_WITNESS",
            { txid: node.txid },
        );
    }

    return finalizeSovereignConditionTx(decodedTx, node.txid).hex;
}

/**
 * Traverses a validated DAG from the Anchoring Leaf to find the specific path
 * descending to the target VTXO Root, finalizing each PSBT through the canonical
 * SDK `finalizeVirtualTx` helper and returning witness-bearing raw transaction hexes.
 *
 * Order: `[AnchorTx (spends commitment), ..., IntermediateTx, ..., VTXO Root Tx]`.
 *
 * Fully iterative stack traversal to be stack-overflow immune on deep chains.
 *
 * @param anchoringLeaf The leaf of the DAG (directly spending the commitment).
 * @param vtxoRootTxid The ultimate VTXO target txid.
 * @returns Array of finalized, witness-bearing raw transaction hexes.
 */
export function extractExitSequence(anchoringLeaf: DAGNode, vtxoRootTxid: string): string[] {
    if (anchoringLeaf.txid === vtxoRootTxid) {
        return [finalizeNodeToHex(anchoringLeaf)];
    }

    type StackFrame = {
        node: DAGNode;
        childrenIterator: Iterator<DAGNode>;
    };

    const path: DAGNode[] = [anchoringLeaf];
    const stack: StackFrame[] = [
        {
            node: anchoringLeaf,
            childrenIterator: anchoringLeaf.children.values(),
        },
    ];

    let found = false;

    while (stack.length > 0) {
        const top = stack[stack.length - 1];
        const next = top.childrenIterator.next();

        if (next.done) {
            stack.pop();
            path.pop();
        } else {
            const child = next.value;
            path.push(child);

            if (child.txid === vtxoRootTxid) {
                found = true;
                break;
            }

            stack.push({
                node: child,
                childrenIterator: child.children.values(),
            });
        }
    }

    if (!found) {
        throw new Error(
            `Critical: VTXO Root ${vtxoRootTxid} not reachable from Anchoring Leaf ${anchoringLeaf.txid}`,
        );
    }

    return path.map(finalizeNodeToHex);
}

/**
 * UNROLL ONLY: converts a topologically ordered sequence of finalized, witness-bearing
 * virtual transactions into a canonical graph-mode `ExitPackage` (`BumpStep[]`) executable
 * by `UnilateralExit.Executor`.
 *
 * The package contains only `BumpStep`s to land the VTXO chain on-chain; it does NOT
 * include a post-CSV `SweepStep`. After unroll confirms, sweep the VTXO output separately
 * (e.g. via `Unroll.completeUnroll` or `UnilateralExit`).
 *
 * Ark virtual transactions pay zero implicit miner fees and carry ephemeral P2A
 * anchor outputs, so each hop is emitted as a `BumpStep` (1P1C CPFP package funded
 * at execution time via an `ExitFeeWallet`, waiting for confirmation between TRUC v3 hops).
 */
export function createSovereignUnrollPackage(
    vtxoRootTxid: string,
    broadcastSequence: string[],
    options: SovereignUnrollPackageOptions,
): ExitPackage {
    if (broadcastSequence.length === 0) {
        throw new Error(`Sovereign Unroll Failed: Empty broadcast sequence for ${vtxoRootTxid}`);
    }
    const vout = options.vout ?? 0;
    const outpoint = `${vtxoRootTxid}:${vout}`;

    const steps: BumpStep[] = broadcastSequence.map((txHex, index) => {
        const tx = Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true });
        const input0 = tx.getInput(0);
        if (!input0?.finalScriptWitness || input0.finalScriptWitness.length === 0) {
            throw new Error(
                `Sovereign Unroll Failed: Transaction at step ${index} is missing SegWit witness data`,
            );
        }
        return {
            kind: "bump",
            parentTxid: computeTxid(tx),
            parentHex: txHex,
            forVtxos: [outpoint],
        };
    });

    return {
        version: 1,
        mode: "graph",
        network: options.network,
        createdAt: Math.floor(Date.now() / 1000),
        validUntil: options.validUntil,
        feeRate: options.feeRate,
        sweepAddress: "",
        totals: {
            txCount: steps.length * 2,
            totalFeeSats: 0,
            fundingRequiredSats: 0,
            recoveredSats: 0,
        },
        vtxos: [{ outpoint }],
        steps,
    };
}

// ─── Storage Persistence ───────────────────────────────────────────────────

function getStorageKey(vtxoRootTxid: string): string {
    return `arkade_exit_data_${vtxoRootTxid}`;
}

/**
 * Extracts, finalizes, encrypts, and persists exit data to local storage.
 *
 * Encryption ownership: `storageKey` is a caller-managed 32-byte AES-256-GCM key
 * used exclusively for encrypting local storage at rest (for example derived from
 * an application unlock passphrase via `StorageCrypto.deriveStorageKey`). Never
 * supply a Bitcoin wallet seed, BIP-39 mnemonic, or private signing key; wallets
 * own all signing key material independently.
 *
 * @param result The successfully validated pipeline result.
 * @param storage The local storage adapter instance.
 * @param storageKey Caller-managed 32-byte AES-256-GCM local storage encryption key.
 */
export async function persistVtxoForExit(
    result: DAGValidationResult,
    storage: VerificationStorageProvider,
    storageKey: Uint8Array,
): Promise<void> {
    if (!storageKey || storageKey.length === 0) {
        throw new Error("Security Error: Storage encryption key is required for persistence.");
    }
    if (!result.valid) {
        throw new Error(
            "Security Error: Cannot persist invalid VTXO DAG verification result for sovereign exit",
        );
    }
    const broadcastSequence = extractExitSequence(result.anchoringLeaf, result.vtxoRoot.txid);

    const exitData: SovereignExitData = {
        vtxoRootTxid: result.vtxoRoot.txid,
        commitmentTxid: result.commitmentTxid,
        batchOutputIndex: result.batchOutputIndex,
        broadcastSequence,
        securedAt: Date.now(),
    };

    const payload = JSON.stringify(exitData);
    const encrypted = await StorageCrypto.encrypt(payload, storageKey);

    await storage.setItem(getStorageKey(exitData.vtxoRootTxid), base64.encode(encrypted));
}

/**
 * Recovers the strict top-down sequence of finalized, witness-bearing virtual
 * transactions for unilateral exit execution.
 * Fails loudly if the data was not secured locally prior to network drop.
 *
 * @param vtxoRootTxid Target VTXO Root ID.
 * @param storage Storage provider.
 * @param storageKey Caller-managed 32-byte AES-256-GCM local storage encryption key.
 */
export async function getBroadcastSequence(
    vtxoRootTxid: string,
    storage: VerificationStorageProvider,
    storageKey: Uint8Array,
): Promise<string[]> {
    if (!storageKey || storageKey.length === 0) {
        throw new Error("Security Error: Storage encryption key is required for decryption.");
    }
    const encryptedB64 = await storage.getItem(getStorageKey(vtxoRootTxid));
    if (!encryptedB64) {
        throw new Error(
            `Sovereign Exit Failed: No local data secured for VTXO Root ${vtxoRootTxid}. ASP connection required!`,
        );
    }

    const encrypted = base64.decode(encryptedB64);
    const decrypted = await StorageCrypto.decrypt(encrypted, storageKey);

    const data = JSON.parse(decrypted);
    if (
        !data ||
        typeof data !== "object" ||
        data.vtxoRootTxid !== vtxoRootTxid ||
        !Array.isArray(data.broadcastSequence) ||
        !data.broadcastSequence.every((entry: unknown) => typeof entry === "string")
    ) {
        throw new Error(
            `Sovereign Exit Failed: Invalid or mismatched exit record for VTXO Root ${vtxoRootTxid}.`,
        );
    }
    return data.broadcastSequence;
}

// ─── Automated Webhook Integrations ─────────────────────────────────────────

/**
 * Runs the full single-input verification pipeline and, if authentic, finalizes,
 * encrypts, and persists the unroll sequence locally (for later unroll-only execution
 * via `executeSovereignUnroll`; sweeping the on-chain VTXO after its CSV delay is a
 * separate wallet step).
 *
 * Prerequisite: when `onchain` is `BitcoinRpcProvider`, Bitcoin Core must run with
 * `-txindex=1` so the commitment transaction can be resolved by txid alone.
 *
 * @param storageKey Caller-managed 32-byte AES-256-GCM local storage encryption key
 *   (never a wallet seed, mnemonic, or signing key).
 */
export async function onReceiveVtxo(
    outpoint: Outpoint,
    indexer: VerificationIndexerProvider,
    onchain: VerificationOnchainProvider,
    storage: VerificationStorageProvider,
    storageKey: Uint8Array,
    minConfirmations: number = 1,
    witnessPreimages?: Map<string, Uint8Array>,
    commitmentTxid?: string,
): Promise<{ success: boolean; diagnostics: string[]; broadcastable?: boolean; error?: string }> {
    try {
        // 1. Run rigorous multi-layered verification (DAG, Sigs, Taproot, Timelocks, HTLCs)
        const verificationResult = await verifyVtxoComplete(
            outpoint,
            indexer,
            onchain,
            minConfirmations,
            witnessPreimages,
            commitmentTxid,
        );

        // 2. Finalize & persist encrypted exit data locally, cutting ASP ties for exiting
        await persistVtxoForExit(verificationResult, storage, storageKey);

        const statusNote = verificationResult.broadcastable
            ? "✓ Exit path is immediately broadcastable on-chain"
            : "! Exit path is secured locally (timelocks pending on-chain maturity)";

        return {
            success: true,
            broadcastable: verificationResult.broadcastable,
            diagnostics: [
                ...verificationResult.diagnostics,
                ` Local sovereign exit data secured for ${outpoint.txid}`,
                statusNote,
            ],
        };
    } catch (error: any) {
        return {
            success: false,
            diagnostics: ["Verification Pipeline Terminated"],
            error: error.message,
        };
    }
}

const SEQUENCE_DISABLE_FLAG = 0x80000000;
const SEQUENCE_TYPE_FLAG = 0x400000;
const LOCKTIME_THRESHOLD = 500_000_000;

type Tip = { height: number; time: number };

async function readTip(onchain: ExitOnchainProvider): Promise<Tip | undefined> {
    if (onchain.getChainTip) {
        const tip = await onchain.getChainTip();
        return { height: tip.height, time: tip.time };
    }
    if (onchain.getBlockchainInfo) {
        const info = await onchain.getBlockchainInfo();
        return { height: info.height, time: info.medianTime };
    }
    return undefined;
}

/**
 * Why `parentHex` cannot be broadcast yet, or `null` when its timelocks are mature.
 * Conservative like the verifier: absolute time locks need `locktime < tip MTP` (BIP-113),
 * block locks `locktime <= tip height`; relative locks are measured from the spent parent's
 * confirmation and never read as mature while the parent is unconfirmed or its height/time unknown.
 */
async function pendingReason(
    parentHex: string,
    onchain: ExitOnchainProvider,
): Promise<string | null> {
    const tx = Transaction.fromRaw(hex.decode(parentHex), { allowUnknownOutputs: true });
    const input = tx.getInput(0);
    const sequence = input.sequence ?? 0xffffffff;
    const lockTime = tx.lockTime;

    const absolute = lockTime > 0 && sequence !== 0xffffffff;
    const relative =
        tx.version >= 2 && (sequence & SEQUENCE_DISABLE_FLAG) === 0 && (sequence & 0xffff) > 0;
    if (!absolute && !relative) return null;

    const tip = await readTip(onchain);
    if (!tip) {
        throw new Error(
            "Cannot establish timelock maturity: the on-chain provider exposes neither getChainTip nor getBlockchainInfo",
        );
    }

    if (absolute) {
        if (lockTime < LOCKTIME_THRESHOLD) {
            if (lockTime > tip.height) {
                return `nLockTime ${lockTime} not reached (tip height ${tip.height})`;
            }
        } else if (lockTime >= tip.time) {
            return `nLockTime ${lockTime} is not below tip median-time-past ${tip.time}`;
        }
    }

    if (relative) {
        const parentTxid = hex.encode(input.txid!);
        let parent: Awaited<ReturnType<ExitOnchainProvider["getTxStatus"]>>;
        try {
            parent = await onchain.getTxStatus(parentTxid);
        } catch (err: any) {
            if (err?.code === -5 && String(err?.message ?? "").includes("-txindex")) {
                throw err;
            }
            return `spent parent ${parentTxid} is not yet confirmed on-chain; BIP-68 delay cannot start`;
        }
        if (!parent.confirmed) {
            return `spent parent ${parentTxid} is unconfirmed; BIP-68 delay cannot start`;
        }
        const value = sequence & 0xffff;
        if (sequence & SEQUENCE_TYPE_FLAG) {
            if (parent.blockTime === undefined) return `confirmation time of ${parentTxid} unknown`;
            const needed = value * 512;
            if (tip.time - parent.blockTime < needed) {
                return `BIP-68 delay of ${needed}s since ${parentTxid} not elapsed`;
            }
        } else {
            if (parent.blockHeight === undefined)
                return `confirmation height of ${parentTxid} unknown`;
            if (tip.height - parent.blockHeight < value) {
                return `BIP-68 delay of ${value} blocks since ${parentTxid} not elapsed`;
            }
        }
    }
    return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal!.reason ?? new Error("aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * UNROLL ONLY. Decrypts locally secured virtual transactions (requiring no ASP connection),
 * wraps them into a canonical graph-mode `ExitPackage`, and drives them on-chain through
 * `UnilateralExit.Executor`. It does NOT sweep: on success the VTXO output exists on-chain but
 * the funds are not in your wallet until its CSV exit leaf is swept (see `swept: false` in the
 * result and `Unroll.completeUnroll` / `UnilateralExit`).
 *
 * Every hop is funded via `options.feeWallet.bumpAnchor` and submitted as a 1P1C CPFP package
 * (`parentHex, childHex`) with confirmation waits between TRUC v3 hops; zero-fee P2A parents are
 * never broadcast standalone. Before each broadcast the hop's own timelocks are checked: an
 * immature hop is waited on (or, with `waitForMaturity: false`, reported and not broadcast).
 */
export async function executeSovereignUnroll(
    vtxoRootTxid: string,
    storage: VerificationStorageProvider,
    onchain: ExitOnchainProvider,
    storageKey: Uint8Array,
    options: ExecuteSovereignUnrollOptions,
): Promise<SovereignUnrollResult> {
    const broadcastedTxids: string[] = [];
    const confirmedTxids: string[] = [];
    const pending: SovereignUnrollPending[] = [];
    const events: ExecutorEvent[] = [];
    const pollMs = options.pollIntervalMs ?? 5_000;
    const result = (success: boolean, error?: string): SovereignUnrollResult => ({
        success,
        swept: false,
        broadcastedTxids,
        confirmedTxids,
        pending,
        events,
        ...(error !== undefined ? { error } : {}),
    });

    try {
        const broadcastSequence = await getBroadcastSequence(vtxoRootTxid, storage, storageKey);
        const pkg = createSovereignUnrollPackage(vtxoRootTxid, broadcastSequence, options);

        // Adapt ExitOnchainProvider to the OnchainProvider subset that Executor invokes for
        // graph-mode BumpSteps (getTxStatus + broadcastTransaction). Translate BitcoinRpcProvider's
        // `{ confirmed: false, inMempool: false }` into a throw so Executor recognizes unknown txs
        // instead of treating them as already in mempool.
        const executorProvider = {
            async getTxStatus(txid: string) {
                const status = await onchain.getTxStatus(txid);
                if (!status.confirmed && status.inMempool === false) {
                    throw new Error(`Transaction ${txid} not found`);
                }
                return status;
            },
            broadcastTransaction: (...txHexes: string[]) =>
                onchain.broadcastTransaction(...txHexes),
        } as unknown as OnchainProvider;

        // Check/wait for hop timelock maturity BEFORE calling feeWallet.bumpAnchor so an
        // immature hop neither locks/signs fee UTXOs nor gets broadcast prematurely.
        const maturityGatedFeeWallet: ExitFeeWallet = {
            async bumpAnchor(parentHex: string, feeRate: number): Promise<[string, string]> {
                const parentTxid = computeTxid(
                    Transaction.fromRaw(hex.decode(parentHex), { allowUnknownOutputs: true }),
                );
                let lastReason: string | undefined;
                for (;;) {
                    const reason = await pendingReason(parentHex, onchain);
                    if (reason === null) break;
                    if (reason !== lastReason) {
                        lastReason = reason;
                        const info = { txid: parentTxid, reason };
                        pending.push(info);
                        options.onPending?.(info);
                    }
                    if (options.waitForMaturity === false) {
                        throw new Error(`Hop ${parentTxid} is not yet broadcastable: ${reason}`);
                    }
                    await sleep(pollMs, options.signal);
                }
                return options.feeWallet.bumpAnchor(parentHex, feeRate);
            },
        };

        const executor = new Executor(pkg, executorProvider, {
            feeWallet: maturityGatedFeeWallet,
            pollIntervalMs: options.pollIntervalMs,
            signal: options.signal,
        });

        let failureReason: string | undefined;
        for await (const event of executor) {
            events.push(event);
            options.onEvent?.(event);

            if (event.status === "broadcast" && event.txid) {
                broadcastedTxids.push(event.txid);
            } else if (
                (event.status === "confirmed" || (event.status === "skipped" && !event.reason)) &&
                event.txid
            ) {
                confirmedTxids.push(event.txid);
            } else if (event.status === "failed") {
                failureReason = event.reason ?? "Exit step failed";
            }
        }

        return failureReason ? result(false, failureReason) : result(true);
    } catch (error: any) {
        return result(false, error?.message ?? String(error));
    }
}
