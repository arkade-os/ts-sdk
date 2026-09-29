import { base64, hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { cltvMaturity, type CltvMaturity } from "../contracts/handlers/helpers";
import type { PathContext } from "../contracts/types";
import type { IndexerProvider } from "../providers/indexer";
import { DefaultVtxo } from "../script/default";
import { decodeTapscript, MultisigTapscript, type RelativeTimelock } from "../script/tapscript";
import { ANCHOR_PKSCRIPT } from "../utils/anchor";
import { toXOnly } from "../utils/keys";
import type { VirtualCoin } from "../wallet";
import {
    canRecoverOnchain,
    canSweepOnchain,
    getNormalizedVtxos,
    hasTerminalSpend,
    type TimeHeight,
} from "../wallet/vtxo";

/**
 * Historical mainnet unilateral-exit delay (~7 days). Wallets still derive
 * this script after arkd advertises a new delay, so a funding-change output
 * from that era only matches when it is included. Same value as the private
 * constant in `wallet.ts`.
 */
export const MAINNET_LEGACY_EXIT_TIMELOCK: RelativeTimelock = {
    value: 605184n,
    type: "seconds",
};

const ANCHOR_HEX = hex.encode(ANCHOR_PKSCRIPT);

export interface DiagnoseOptions {
    /** Current and deprecated Ark signer keys, compressed or x-only. */
    serverPubkeys: Uint8Array[];
    /** Exit delays used to rebuild the sender's own vtxo scripts. */
    exitTimelocks: RelativeTimelock[];
}

export type OutputKind = "anchor" | "wallet" | "foreign" | "nonstandard";

export interface DiagnosedOutput {
    vout: number;
    amount: number;
    pkScript: string;
    kind: OutputKind;
}

export interface DiagnosedInput {
    leafType: string;
    pubkeys: string[];
}

export interface FundingTxDiagnosis {
    txid: string;
    /** x-only key that spent the collaborative leaf, when it sits next to a known signer. */
    senderPubkey?: string;
    /** The known signer on that leaf. */
    cosignerPubkey?: string;
    inputs: DiagnosedInput[];
    outputs: DiagnosedOutput[];
}

export type OutputLiveness = "spent" | "unrolled" | "recoverable" | "live" | "absent";

export type RecoveryAction = "none" | "wallet" | "lockup-leaf" | "onchain-exit";

export interface Recovery {
    action: RecoveryAction;
    reason: string;
}

export interface ReportedOutput extends DiagnosedOutput {
    txid: string;
    liveness: OutputLiveness;
    indexedScript?: string;
    scriptMismatch: boolean;
    recovery: Recovery;
}

export interface WalletVtxoRow {
    txid: string;
    vout: number;
    value: number;
    script: string;
    liveness: OutputLiveness;
}

export interface FundingReport {
    senderPubkeys: string[];
    walletScripts: string[];
    outputs: ReportedOutput[];
    /** Swept-or-expired foreign outputs that a key import does not watch. */
    lockupSats: number;
    /** Recoverable outputs on the sender's own vtxo script. */
    walletRecoverableSats: number;
    dust?: number;
    walletVtxos: WalletVtxoRow[];
}

export interface ServerSignerInfo {
    signerPubkey: string;
    deprecatedSigners: readonly { pubkey: string }[];
    unilateralExitDelay: bigint;
    network: string;
    dust: bigint;
}

export interface VhtlcLockupAssessment {
    matches: boolean;
    refundLocktime: bigint;
    maturity: CltvMaturity;
    /**
     * The leaf a swept lockup is recovered through: sender + server, after
     * `refundLocktime`. arkd checks the control block against the output key
     * and does not require the operator's signer to sign the intent.
     */
    leaf: "refundWithoutReceiver";
}

function delayToTimelock(delay: bigint): RelativeTimelock {
    return {
        value: delay,
        type: delay < 512n ? "blocks" : "seconds",
    };
}

function timelockKey(timelock: RelativeTimelock): string {
    return `${timelock.type}:${timelock.value.toString()}`;
}

/** Signer keys and exit delays that rebuild the scripts a restored wallet watches. */
export function diagnoseOptionsFromServer(server: ServerSignerInfo): DiagnoseOptions {
    const exitTimelocks = [delayToTimelock(server.unilateralExitDelay)];
    if (server.network === "bitcoin") exitTimelocks.push(MAINNET_LEGACY_EXIT_TIMELOCK);

    const seen = new Set<string>();
    const deduped: RelativeTimelock[] = [];
    for (const timelock of exitTimelocks) {
        const key = timelockKey(timelock);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(timelock);
    }

    return {
        serverPubkeys: [
            hex.decode(server.signerPubkey),
            ...server.deprecatedSigners.map((signer) => hex.decode(signer.pubkey)),
        ],
        exitTimelocks: deduped,
    };
}

function xOnlyServers(serverPubkeys: Uint8Array[]): Uint8Array[] {
    const seen = new Set<string>();
    const out: Uint8Array[] = [];
    for (const pubkey of serverPubkeys) {
        const xonly = toXOnly(pubkey, "server pubkey");
        const encoded = hex.encode(xonly);
        if (seen.has(encoded)) continue;
        seen.add(encoded);
        out.push(xonly);
    }
    return out;
}

function isPk(script: Uint8Array): boolean {
    return script.length === 34 && script[0] === 0x51 && script[1] === 0x20;
}

/** pkScripts of `sender` under every known signer and exit delay. */
export function senderWalletScripts(
    sender: Uint8Array,
    options: DiagnoseOptions,
): Map<string, string> {
    const scripts = new Map<string, string>();
    for (const serverPubKey of xOnlyServers(options.serverPubkeys)) {
        for (const csvTimelock of options.exitTimelocks) {
            let pkScript: Uint8Array;
            try {
                pkScript = new DefaultVtxo.Script({
                    pubKey: sender,
                    serverPubKey,
                    csvTimelock,
                }).pkScript;
            } catch {
                continue;
            }
            scripts.set(hex.encode(pkScript), hex.encode(serverPubKey));
        }
    }
    return scripts;
}

function readInput(tx: Transaction, index: number): DiagnosedInput {
    const input = tx.getInput(index);
    const leaf = input?.tapLeafScript?.[0];
    if (!leaf) return { leafType: "missing", pubkeys: [] };

    const body = leaf[1].subarray(0, leaf[1].length - 1);
    try {
        const decoded = decodeTapscript(body);
        const pubkeys = MultisigTapscript.is(decoded)
            ? decoded.params.pubkeys.map((pk) => hex.encode(pk))
            : [];
        return { leafType: decoded.type, pubkeys };
    } catch {
        return { leafType: "unknown", pubkeys: [] };
    }
}

function identifySender(
    inputs: DiagnosedInput[],
    serverKeys: Set<string>,
): { senderPubkey?: string; cosignerPubkey?: string } {
    const senders = new Set<string>();
    const cosigners = new Set<string>();
    for (const input of inputs) {
        if (input.leafType !== "multisig" || input.pubkeys.length !== 2) continue;
        const matched = input.pubkeys.filter((pk) => serverKeys.has(pk));
        const others = input.pubkeys.filter((pk) => !serverKeys.has(pk));
        if (matched.length !== 1 || others.length !== 1) continue;
        senders.add(others[0]);
        cosigners.add(matched[0]);
    }
    if (senders.size !== 1) return {};
    return {
        senderPubkey: [...senders][0],
        cosignerPubkey: cosigners.size === 1 ? [...cosigners][0] : undefined,
    };
}

/**
 * Classify one virtual transaction.
 *
 * The input leaf of a Boltz funding spend is the sender's own forfeit closure
 * (sender + Ark signer). Change comes back to that vtxo script. The other
 * output is the lockup, a different script the wallet does not derive from
 * the key.
 */
export function diagnoseFundingPsbt(
    psbtBase64: string,
    options: DiagnoseOptions,
): FundingTxDiagnosis {
    const tx = Transaction.fromPSBT(base64.decode(psbtBase64));
    const inputs: DiagnosedInput[] = [];
    for (let i = 0; i < tx.inputsLength; i++) inputs.push(readInput(tx, i));

    const servers = xOnlyServers(options.serverPubkeys);
    const serverKeys = new Set(servers.map((pk) => hex.encode(pk)));
    const { senderPubkey, cosignerPubkey } = identifySender(inputs, serverKeys);
    const walletScripts = senderPubkey
        ? senderWalletScripts(hex.decode(senderPubkey), options)
        : new Map<string, string>();

    const outputs: DiagnosedOutput[] = [];
    for (let vout = 0; vout < tx.outputsLength; vout++) {
        const output = tx.getOutput(vout);
        const script = output?.script ?? new Uint8Array();
        const amount = output?.amount ?? 0n;
        if (!Number.isSafeInteger(Number(amount))) {
            throw new Error(`output ${vout} amount ${amount} is not a safe integer`);
        }
        const pkScript = hex.encode(script);
        let kind: OutputKind;
        if (pkScript === ANCHOR_HEX) kind = "anchor";
        else if (walletScripts.has(pkScript)) kind = "wallet";
        else if (isPk(script)) kind = "foreign";
        else kind = "nonstandard";
        outputs.push({ vout, amount: Number(amount), pkScript, kind });
    }

    return { txid: tx.id, senderPubkey, cosignerPubkey, inputs, outputs };
}

function livenessOf(vtxo: VirtualCoin | undefined, now: TimeHeight): OutputLiveness {
    if (!vtxo) return "absent";
    if (hasTerminalSpend(vtxo)) return "spent";
    if (canSweepOnchain(vtxo)) return "unrolled";
    if (canRecoverOnchain(vtxo, now)) return "recoverable";
    return "live";
}

function recoveryFor(output: {
    kind: OutputKind;
    liveness: OutputLiveness;
    amount: number;
    scriptMismatch: boolean;
    indexedIsWallet: boolean;
    dust?: number;
}): Recovery {
    if (output.kind === "anchor") {
        return { action: "none", reason: "Anchor output." };
    }
    if (output.liveness === "spent") {
        return { action: "none", reason: "Already spent." };
    }
    if (output.liveness === "absent") {
        return { action: "none", reason: "Indexer has no vtxo at this outpoint." };
    }
    if (output.liveness === "unrolled") {
        return {
            action: "onchain-exit",
            reason: "Unrolled onchain. The batch-recovery path does not apply; the exit CSV does.",
        };
    }

    const dustNote =
        output.dust !== undefined && output.amount < output.dust
            ? ` Amount ${output.amount} is below the dust threshold ${output.dust}, so it cannot settle on its own.`
            : "";

    const onWallet = output.kind === "wallet" || output.indexedIsWallet;
    if (onWallet && output.liveness === "recoverable") {
        const mismatch = output.scriptMismatch
            ? " The virtual tx output script and the indexer script disagree; the indexer script is the sender's vtxo script."
            : "";
        return {
            action: "wallet",
            reason:
                "On the sender's vtxo script and swept or expired. A wallet that loads this key watches the script, including a deprecated signer, and recoverVtxos settles it without a forfeit." +
                mismatch +
                dustNote,
        };
    }
    if (onWallet && output.liveness === "live") {
        return {
            action: "none",
            reason: "On the sender's vtxo script and still spendable offchain.",
        };
    }

    if (output.liveness === "recoverable" || output.liveness === "live") {
        const when =
            output.liveness === "recoverable"
                ? "Swept or expired, so the batch takes it without a forfeit."
                : "Still live, so the same leaf settles as an offchain spend rather than a recoverable batch.";
        return {
            action: "lockup-leaf",
            reason:
                "Not the sender's vtxo script, so loading the key does not watch it. " +
                when +
                " arkd still accepts an intent that spends one leaf whose control block matches this output key; the operator signer is skipped. For a Boltz VHTLC that leaf is refundWithoutReceiver (sender + server) once refundLocktime has matured. The preimage was random, so the script comes from the old swap record — preimage hash, Boltz public key, timeouts, server public key — or from the encoded taptree. Register that contract and settle; the vhtlc handler stamps refundWithoutReceiver as the intent leaf." +
                dustNote,
        };
    }

    return { action: "none", reason: "No recovery path for this output." };
}

/**
 * Join funding diagnoses with indexer vtxos.
 *
 * `walletVtxos` are recoverable or live coins on the sender's own scripts that
 * were not created by these funding transactions. That is what a key import sees.
 */
export function reportFunding(
    diagnoses: FundingTxDiagnosis[],
    vtxos: VirtualCoin[],
    now: TimeHeight,
    opts?: { dust?: number; walletScripts?: ReadonlySet<string> },
): FundingReport {
    const byOutpoint = new Map<string, VirtualCoin>();
    for (const vtxo of vtxos) byOutpoint.set(`${vtxo.txid}:${vtxo.vout}`, vtxo);

    const walletScripts = opts?.walletScripts ?? new Set<string>();
    const outputs: ReportedOutput[] = [];
    for (const diagnosis of diagnoses) {
        for (const output of diagnosis.outputs) {
            const vtxo = byOutpoint.get(`${diagnosis.txid}:${output.vout}`);
            const liveness = livenessOf(vtxo, now);
            const indexedScript = vtxo?.script;
            const scriptMismatch = indexedScript !== undefined && indexedScript !== output.pkScript;
            const indexedIsWallet = indexedScript !== undefined && walletScripts.has(indexedScript);
            outputs.push({
                ...output,
                txid: diagnosis.txid,
                liveness,
                indexedScript,
                scriptMismatch,
                recovery: recoveryFor({
                    kind: output.kind,
                    liveness,
                    amount: output.amount,
                    scriptMismatch,
                    indexedIsWallet,
                    dust: opts?.dust,
                }),
            });
        }
    }

    const fundingKeys = new Set(outputs.map((output) => `${output.txid}:${output.vout}`));
    const walletVtxos: WalletVtxoRow[] = [];
    for (const vtxo of vtxos) {
        const key = `${vtxo.txid}:${vtxo.vout}`;
        if (fundingKeys.has(key)) continue;
        if (!walletScripts.has(vtxo.script)) continue;
        const liveness = livenessOf(vtxo, now);
        if (liveness !== "recoverable" && liveness !== "live") continue;
        walletVtxos.push({
            txid: vtxo.txid,
            vout: vtxo.vout,
            value: vtxo.value,
            script: vtxo.script,
            liveness,
        });
    }

    const lockupSats = outputs
        .filter((output) => output.recovery.action === "lockup-leaf")
        .reduce((sum, output) => sum + output.amount, 0);
    const walletRecoverableSats = [
        ...outputs.filter((output) => output.recovery.action === "wallet"),
        ...walletVtxos.filter((vtxo) => vtxo.liveness === "recoverable"),
    ].reduce((sum, row) => sum + ("amount" in row ? row.amount : row.value), 0);

    return {
        senderPubkeys: [
            ...new Set(
                diagnoses.flatMap((diagnosis) =>
                    diagnosis.senderPubkey ? [diagnosis.senderPubkey] : [],
                ),
            ),
        ],
        walletScripts: [...walletScripts],
        outputs,
        lockupSats,
        walletRecoverableSats,
        dust: opts?.dust,
        walletVtxos,
    };
}

/**
 * Whether a reconstructed VHTLC is the lockup at `outputPkScript`, and whether
 * its refund-without-receiver leaf is mature.
 */
export function assessVhtlcLockup(
    script: { pkScript: Uint8Array; options: { refundLocktime: bigint } },
    outputPkScript: string,
    now: Pick<PathContext, "currentTime" | "chainTime" | "blockHeight">,
): VhtlcLockupAssessment {
    return {
        matches: hex.encode(script.pkScript) === outputPkScript,
        refundLocktime: script.options.refundLocktime,
        maturity: cltvMaturity(
            {
                collaborative: true,
                currentTime: now.currentTime,
                chainTime: now.chainTime,
                blockHeight: now.blockHeight,
            },
            script.options.refundLocktime,
        ),
        leaf: "refundWithoutReceiver",
    };
}

function sats(n: number): string {
    return `${n} sat`;
}

const LOCKUP_LEAF =
    "A key import does not watch a foreign lockup. arkd still accepts an intent that spends one leaf of that script: the control block has to match the output key, and the operator signer is skipped. For a Boltz VHTLC that leaf is refundWithoutReceiver (sender + server) once refundLocktime has matured. The preimage was random, so the script comes from the old swap record — preimage hash, Boltz public key, timeouts, server public key — or from the encoded taptree. Register that contract and settle the swept coin; there is no forfeit.";

/** Plain-text report for an operator. */
export function formatFundingReport(report: FundingReport): string {
    const lines: string[] = [];
    lines.push(
        report.senderPubkeys.length === 0
            ? "sender: not identified"
            : `sender: ${report.senderPubkeys.join(", ")}`,
    );
    lines.push(`lockup outputs a key import does not watch: ${sats(report.lockupSats)}`);
    lines.push(`recoverable on the sender's own script: ${sats(report.walletRecoverableSats)}`);
    if (report.dust !== undefined && report.walletRecoverableSats < report.dust) {
        lines.push(
            `that own-script total is below dust ${report.dust}, so recoverVtxos will not settle it`,
        );
    }
    if (report.outputs.some((output) => output.recovery.action === "lockup-leaf")) {
        lines.push("");
        lines.push(LOCKUP_LEAF);
    }
    lines.push("");
    for (const output of report.outputs) {
        if (output.kind === "anchor") continue;
        const dust = output.recovery.reason.includes("below the dust threshold")
            ? "  below dust"
            : "";
        lines.push(
            `${output.txid}:${output.vout}  ${sats(output.amount)}  ${output.kind}  ${output.liveness}  ${output.recovery.action}${dust}`,
        );
        if (output.scriptMismatch) {
            lines.push(`  psbt script ${output.pkScript}`);
            lines.push(`  indexer script ${output.indexedScript}`);
        }
    }
    if (report.walletVtxos.length > 0) {
        lines.push("");
        lines.push("other vtxos on the sender script:");
        for (const vtxo of report.walletVtxos) {
            lines.push(`  ${vtxo.txid}:${vtxo.vout}  ${sats(vtxo.value)}  ${vtxo.liveness}`);
        }
    }
    return lines.join("\n");
}

/**
 * Fetch the virtual transactions and their vtxos and diagnose them.
 *
 * Also lists recoverable and live coins on the sender's own scripts, which is
 * the set a restored wallet can see.
 */
export async function diagnoseFundingOnServer(
    server: ServerSignerInfo,
    indexer: Pick<IndexerProvider, "getVtxos" | "getVirtualTxs">,
    txids: string[],
    now: TimeHeight = { timestamp: new Date() },
): Promise<FundingReport> {
    if (txids.length === 0) throw new Error("at least one txid is required");

    const options = diagnoseOptionsFromServer(server);
    const { txs } = await indexer.getVirtualTxs(txids);
    const diagnoses = txs.map((psbt) => diagnoseFundingPsbt(psbt, options));

    const found = new Set(diagnoses.map((diagnosis) => diagnosis.txid));
    const missing = txids.filter((txid) => !found.has(txid));
    if (missing.length > 0) {
        throw new Error(`indexer did not return virtual txs: ${missing.join(", ")}`);
    }

    const outpoints = diagnoses.flatMap((diagnosis) =>
        diagnosis.outputs
            .filter((output) => output.kind !== "anchor")
            .map((output) => ({ txid: diagnosis.txid, vout: output.vout })),
    );

    const walletScripts = new Map<string, string>();
    for (const diagnosis of diagnoses) {
        if (!diagnosis.senderPubkey) continue;
        for (const [pkScript, server] of senderWalletScripts(
            hex.decode(diagnosis.senderPubkey),
            options,
        )) {
            walletScripts.set(pkScript, server);
        }
    }

    const outputVtxos =
        outpoints.length === 0 ? [] : (await getNormalizedVtxos(indexer, { outpoints })).vtxos;
    const walletVtxos =
        walletScripts.size === 0
            ? []
            : (
                  await getNormalizedVtxos(indexer, {
                      scripts: [...walletScripts.keys()],
                      renewableOnly: true,
                  })
              ).vtxos;

    return reportFunding(diagnoses, [...outputVtxos, ...walletVtxos], now, {
        dust: Number(server.dust),
        walletScripts: new Set(walletScripts.keys()),
    });
}
