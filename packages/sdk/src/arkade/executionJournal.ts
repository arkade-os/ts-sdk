import { base64, hex, utf8 } from "@scure/base";
import { sha256 } from "@scure/btc-signer/utils.js";
import type {
    AtomicWalletState,
    WalletRepository,
    WalletState,
} from "../repositories/walletRepository";
import { verifyTapscriptSignatures, type EmulatorSubmitProposal } from "../utils/arkTransaction";
import { TAP_LEAF_VERSION, tapLeafHash } from "@scure/btc-signer/payment.js";
import { decodeTapscript, TapscriptType } from "../script/tapscript";
import { scriptFromTapLeafScript } from "../script/base";
import { Transaction } from "../utils/transaction";
import { P2A } from "../utils/anchor";
import { Extension } from "../extension";
import { EmulatorPacket } from "../extension/emulator";
import type { Outpoint, VirtualCoin } from "../wallet";
import type { IndexerProvider } from "../providers/indexer";

const SLOT = "nativeExecutionJournal";
const RECEIPT_SLOT = "nativeExecutionReceipt";
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const TXID = /^[0-9a-f]{64}$/;

export type NativeExecutionRecord = Readonly<{
    version: 1;
    state: "prepared";
    operationId: string;
    source: Readonly<Outpoint & { script: string; value: string }>;
    payout: Readonly<{ script: string; value: string }>;
    proposal: EmulatorSubmitProposal;
}>;

export type NativeExecutionObservation = Readonly<{
    state: "unknown" | "reconciled";
    record: NativeExecutionRecord;
}>;

export type NativeExecutionReceipt = Readonly<{
    version: 1;
    state: "reconciled";
    operationId: string;
    source: Readonly<Outpoint>;
    /** SHA256 of UTF-8 JSON {txid,arkTx,checkpointTxs}, in that order with exact PSBT strings. */
    proposalHash: string;
}>;

/** One unresolved prepared request per repository; dispatch may already have occurred.
 * Occupied slots always reject. This is not shared Wallet coin ownership or proof of acceptance.
 * Requires asserted persistent atomic storage; no release, replay or downgrade policy.
 * The 4 MiB JSON request budget is journal policy, not a universal protocol limit.
 */
export class NativeExecutionJournal {
    private readonly atomic: AtomicWalletState;

    constructor(private readonly repo: WalletRepository) {
        const atomic = repo.atomicWalletState;
        if (atomic?.version !== 1 || atomic.persistent !== true) {
            throw new Error("native execution journal requires persistent atomic wallet state v1");
        }
        this.atomic = atomic;
    }

    async admit(
        source: Readonly<Outpoint>,
        proposal: EmulatorSubmitProposal,
    ): Promise<NativeExecutionRecord> {
        const record = prepare(source, proposal);
        await this.atomic.update((state) => {
            if (readSlot(state) !== undefined)
                throw new Error("native execution journal is occupied");
            return { ...state, settings: { ...state.settings, [SLOT]: record } };
        });
        return record;
    }

    async get(source: Readonly<Outpoint>): Promise<NativeExecutionRecord | undefined> {
        const captured = captureSource(source);
        const record = readSlot((await this.repo.getWalletState()) ?? {});
        return record?.source.txid === captured.txid && record.source.vout === captured.vout
            ? record
            : undefined;
    }

    async getReceipt(source: Readonly<Outpoint>): Promise<NativeExecutionReceipt | undefined> {
        const captured = captureSource(source);
        const { receipt } = readReceiptSnapshot((await this.repo.getWalletState()) ?? {});
        return receipt?.source.txid === captured.txid && receipt.source.vout === captured.vout
            ? receipt
            : undefined;
    }

    /** Persists configured-indexer reconciliation as trusted historical metadata, not finality.
     * Cached receipts require no RPC and never make the prepared slot spendable or reusable.
     */
    async reconcile(
        source: Readonly<Outpoint>,
        indexer: Pick<IndexerProvider, "getVtxos" | "getVirtualTxs">,
    ): Promise<NativeExecutionObservation | undefined> {
        const captured = captureSource(source);
        const bound = bindObserver(indexer);
        const { record, receipt } = readReceiptSnapshot((await this.repo.getWalletState()) ?? {});
        if (!record || record.source.txid !== captured.txid || record.source.vout !== captured.vout)
            return undefined;
        if (receipt) return Object.freeze({ state: "reconciled", record });
        const observation = await observeRecord(record, bound);
        if (observation.state !== "reconciled") return observation;
        const nextReceipt = receiptFor(record);
        await this.atomic.update((state) => {
            const current = readReceiptSnapshot(state);
            if (!current.record || JSON.stringify(current.record) !== JSON.stringify(record))
                throw new Error("native execution journal changed before reconciliation");
            if (current.receipt) return state;
            return { ...state, settings: { ...state.settings, [RECEIPT_SLOT]: nextReceipt } };
        });
        return observation;
    }

    /** Observes configured-indexer history, not independent finality or current spendability.
     * All outcomes leave the prepared slot occupied; observation never refreshes wallet state.
     */
    async observe(
        source: Readonly<Outpoint>,
        indexer: Pick<IndexerProvider, "getVtxos" | "getVirtualTxs">,
    ): Promise<NativeExecutionObservation | undefined> {
        const bound = bindObserver(indexer);
        const record = await this.get(source);
        return record ? observeRecord(record, bound) : undefined;
    }
}

function bindObserver(indexer: Pick<IndexerProvider, "getVtxos" | "getVirtualTxs">) {
    return {
        getVtxos: indexer.getVtxos.bind(indexer),
        getVirtualTxs: indexer.getVirtualTxs.bind(indexer),
    };
}

async function observeRecord(
    record: NativeExecutionRecord,
    { getVtxos, getVirtualTxs }: ReturnType<typeof bindObserver>,
): Promise<NativeExecutionObservation> {
    let state: NativeExecutionObservation["state"] = "unknown";
    try {
        const localArk = Transaction.fromPSBT(base64.decode(record.proposal.arkTx));
        const localCheckpoint = Transaction.fromPSBT(
            base64.decode(record.proposal.checkpointTxs[0]),
        );
        const [coins, transactions] = await Promise.all([
            Promise.resolve().then(() =>
                getVtxos({
                    outpoints: [
                        { txid: record.source.txid, vout: record.source.vout },
                        { txid: record.operationId, vout: 0 },
                    ],
                    pageIndex: 0,
                    pageSize: 2,
                    maxResponseBytes: MAX_REQUEST_BYTES,
                }),
            ),
            Promise.resolve().then(() =>
                getVirtualTxs([localCheckpoint.id, record.operationId], {
                    pageIndex: 0,
                    pageSize: 2,
                    maxResponseBytes: MAX_REQUEST_BYTES,
                }),
            ),
        ]);
        assertCompleteReply(coins, "vtxos");
        assertCompleteReply(transactions, "txs");
        const byOutpoint = new Map<string, VirtualCoin>();
        for (const coin of coins.vtxos) {
            const point = captureSource(coin);
            const id = `${point.txid}:${point.vout}`;
            if (
                byOutpoint.has(id) ||
                !Number.isSafeInteger(coin.value) ||
                coin.value <= 0 ||
                typeof coin.script !== "string" ||
                !/^(?:[0-9a-f]{2})+$/.test(coin.script)
            )
                throw new Error("invalid observed coin");
            byOutpoint.set(id, coin);
        }
        const spent = byOutpoint.get(`${record.source.txid}:${record.source.vout}`);
        const payout = byOutpoint.get(`${record.operationId}:0`);
        if (
            !spent ||
            !payout ||
            spent.isSpent !== true ||
            spent.arkTxId !== record.operationId ||
            spent.spentBy !== localCheckpoint.id ||
            spent.script !== record.source.script ||
            String(spent.value) !== record.source.value ||
            payout.script !== record.payout.script ||
            String(payout.value) !== record.payout.value
        )
            throw new Error("observed coins do not match journal");
        captureProposal({
            txid: record.operationId,
            arkTx: transactions.txs[0],
            checkpointTxs: [transactions.txs[1]],
        });
        const byTxid = new Map<string, { tx: Transaction; encoded: string }>();
        for (const encoded of transactions.txs) {
            const tx = Transaction.fromPSBT(base64.decode(encoded));
            if (byTxid.has(tx.id) || (tx.id !== localCheckpoint.id && tx.id !== record.operationId))
                throw new Error("unexpected observed transaction");
            byTxid.set(tx.id, { tx, encoded });
        }
        const ark = byTxid.get(record.operationId)!;
        const checkpoint = byTxid.get(localCheckpoint.id)!;
        const observed = prepare(record.source, {
            txid: record.operationId,
            arkTx: ark.encoded,
            checkpointTxs: [checkpoint.encoded],
        });
        if (
            observed.source.script !== record.source.script ||
            observed.source.value !== record.source.value ||
            observed.payout.script !== record.payout.script ||
            observed.payout.value !== record.payout.value
        )
            throw new Error("observed witness metadata mismatch");
        verifyObservedSignatures(ark.tx, localArk);
        verifyObservedSignatures(checkpoint.tx, localCheckpoint);
        state = "reconciled";
    } catch {
        // Remote uncertainty never releases a prepared execution.
    }
    return Object.freeze({ state, record });
}

function assertCompleteReply(reply: unknown, field: "vtxos" | "txs"): void {
    const value = reply as Record<string, any> | null;
    if (
        !value ||
        !Array.isArray(value[field]) ||
        value[field].length !== 2 ||
        utf8.decode(JSON.stringify(value)).length > MAX_REQUEST_BYTES
    )
        throw new Error("invalid or oversized observation reply");
    const page = value.page;
    if (
        page !== undefined &&
        page !== null &&
        (!page ||
            !Number.isInteger(page.current) ||
            page.current < 0 ||
            page.current > page.total ||
            !Number.isInteger(page.next) ||
            page.next < 0 ||
            page.next > page.total ||
            (page.next !== 0 && page.current < page.total) ||
            !Number.isInteger(page.total) ||
            page.total < 0 ||
            page.total > 1)
    )
        throw new Error("incomplete observation reply");
}

function verifyObservedSignatures(remote: Transaction, local: Transaction): void {
    const leaves = local.getInput(0).tapLeafScript;
    if (leaves?.length !== 1) throw new Error("ambiguous local spend policy");
    const leaf = leaves[0];
    if (leaf[1][leaf[1].length - 1] !== TAP_LEAF_VERSION)
        throw new Error("unsupported local leaf version");
    const script = scriptFromTapLeafScript(leaf);
    const policy = decodeTapscript(script);
    if (
        ![TapscriptType.Multisig, TapscriptType.CSVMultisig, TapscriptType.CLTVMultisig].includes(
            policy.type,
        )
    )
        throw new Error("unsupported local spend policy");
    const signers: string[] = policy.params.pubkeys.map((key: Uint8Array) => hex.encode(key));
    if (signers.length === 0 || new Set(signers).size !== signers.length)
        throw new Error("ambiguous local signers");
    const signatures = remote.getInput(0).tapScriptSig;
    if (
        !signatures ||
        signatures.length !== signers.length ||
        signatures.some(
            ([data, signature]) =>
                signature.length !== 64 || !signers.includes(hex.encode(data.pubKey)),
        )
    )
        throw new Error("invalid observed signatures");
    verifyTapscriptSignatures(
        remote,
        0,
        signers,
        [],
        undefined,
        tapLeafHash(script, leaf[1][leaf[1].length - 1]),
    );
}

function captureSource(source: Readonly<Outpoint>): Readonly<Outpoint> {
    const captured = { txid: source?.txid, vout: source?.vout };
    if (
        typeof captured.txid !== "string" ||
        !TXID.test(captured.txid) ||
        !Number.isInteger(captured.vout) ||
        captured.vout < 0 ||
        captured.vout > 0xffffffff
    ) {
        throw new Error("invalid native source outpoint");
    }
    return Object.freeze(captured);
}

function captureProposal(proposal: EmulatorSubmitProposal): EmulatorSubmitProposal {
    if (
        !proposal ||
        typeof proposal.txid !== "string" ||
        !TXID.test(proposal.txid) ||
        !Array.isArray(proposal.checkpointTxs) ||
        proposal.checkpointTxs.length !== 1
    ) {
        throw new Error("invalid native submission proposal");
    }
    const captured = {
        txid: proposal.txid,
        arkTx: proposal.arkTx,
        checkpointTxs: Object.freeze([...proposal.checkpointTxs]),
    };
    for (const encoded of [captured.arkTx, ...captured.checkpointTxs]) {
        if (
            typeof encoded !== "string" ||
            encoded.length === 0 ||
            encoded.length > MAX_REQUEST_BYTES ||
            encoded.length % 4 !== 0 ||
            /[^A-Za-z0-9+/=]/.test(encoded) ||
            !/^[^=]*={0,2}$/.test(encoded)
        ) {
            throw new Error("invalid or oversized native PSBT encoding");
        }
    }
    if (JSON.stringify(captured).length > MAX_REQUEST_BYTES)
        throw new Error("native request exceeds journal budget");
    return Object.freeze(captured);
}

function prepare(
    source: Readonly<Outpoint>,
    proposal: EmulatorSubmitProposal,
): NativeExecutionRecord {
    const captured = captureSource(source);
    const request = captureProposal(proposal);
    const ark = Transaction.fromPSBT(base64.decode(request.arkTx));
    const cp = Transaction.fromPSBT(base64.decode(request.checkpointTxs[0]));
    if (
        ark.id !== request.txid ||
        ark.inputsLength !== 1 ||
        cp.inputsLength !== 1 ||
        ark.outputsLength < 1 ||
        cp.outputsLength < 1
    )
        throw new Error("unsupported native transaction graph");
    const input = cp.getInput(0);
    const link = ark.getInput(0);
    const checkpoint = cp.getOutput(0);
    const payout = ark.getOutput(0);
    if (
        !input.txid ||
        hex.encode(input.txid) !== captured.txid ||
        input.index !== captured.vout ||
        !input.witnessUtxo ||
        input.witnessUtxo.amount <= 0n ||
        input.witnessUtxo.script.length === 0
    )
        throw new Error("native source does not match checkpoint");
    const principal = input.witnessUtxo.amount;
    if (
        !link.txid ||
        hex.encode(link.txid) !== cp.id ||
        link.index !== 0 ||
        !link.witnessUtxo ||
        !checkpoint.script ||
        checkpoint.script.length === 0 ||
        hex.encode(link.witnessUtxo.script) !== hex.encode(checkpoint.script) ||
        link.witnessUtxo.amount !== checkpoint.amount ||
        checkpoint.amount !== principal
    )
        throw new Error("native checkpoint link or principal mismatch");
    if (
        !payout.script ||
        payout.script.length === 0 ||
        payout.script[0] === 0x6a ||
        hex.encode(payout.script) === hex.encode(P2A.script) ||
        payout.amount !== principal
    )
        throw new Error("native payout must return full principal");
    validateExtras(cp, false);
    validateExtras(ark, true);
    return Object.freeze({
        version: 1,
        state: "prepared",
        operationId: request.txid,
        source: Object.freeze({
            ...captured,
            script: hex.encode(input.witnessUtxo.script),
            value: principal.toString(),
        }),
        payout: Object.freeze({ script: hex.encode(payout.script), value: principal.toString() }),
        proposal: request,
    });
}

function validateExtras(tx: Transaction, allowEmulator: boolean): void {
    let anchor = false;
    let emulator = false;
    for (let i = 1; i < tx.outputsLength; i++) {
        const output = tx.getOutput(i);
        if (output.amount !== 0n || !output.script)
            throw new Error("unsupported native extra output");
        if (hex.encode(output.script) === hex.encode(P2A.script) && !anchor) {
            anchor = true;
            continue;
        }
        if (allowEmulator && !emulator && Extension.isExtension(output.script)) {
            const packets = Extension.fromBytes(output.script).getPackets();
            if (
                packets.length === 1 &&
                packets[0] instanceof EmulatorPacket &&
                packets[0].entries.length === 1 &&
                packets[0].entries[0].vin === 0 &&
                hex.encode(Extension.create([...packets]).serialize()) === hex.encode(output.script)
            ) {
                emulator = true;
                continue;
            }
        }
        throw new Error("unsupported native extra output");
    }
}

function exactKeys(value: unknown, keys: string[]): asserts value is Record<string, any> {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== keys.length ||
        !keys.every((key) => Object.hasOwn(value, key))
    )
        throw new Error("invalid native journal record");
}

function readSlot(state: WalletState): NativeExecutionRecord | undefined {
    const settings = state.settings;
    if (settings === undefined) return undefined;
    if (!settings || typeof settings !== "object" || Array.isArray(settings))
        throw new Error("invalid wallet settings");
    if (!Object.hasOwn(settings, SLOT)) return undefined;
    const stored: unknown = settings[SLOT];
    exactKeys(stored, ["version", "state", "operationId", "source", "payout", "proposal"]);
    exactKeys(stored.source, ["txid", "vout", "script", "value"]);
    exactKeys(stored.payout, ["script", "value"]);
    exactKeys(stored.proposal, ["txid", "arkTx", "checkpointTxs"]);
    if (stored.version !== 1 || stored.state !== "prepared")
        throw new Error("unsupported native journal version or state");
    const derived = prepare(
        stored.source as NativeExecutionRecord["source"],
        stored.proposal as EmulatorSubmitProposal,
    );
    if (
        stored.operationId !== derived.operationId ||
        stored.source.script !== derived.source.script ||
        stored.source.value !== derived.source.value ||
        stored.payout.script !== derived.payout.script ||
        stored.payout.value !== derived.payout.value
    )
        throw new Error("native journal metadata mismatch");
    return derived;
}

function receiptFor(record: NativeExecutionRecord): NativeExecutionReceipt {
    const { txid, arkTx, checkpointTxs } = record.proposal;
    const proposalHash = hex.encode(
        sha256(new TextEncoder().encode(JSON.stringify({ txid, arkTx, checkpointTxs }))),
    );
    return Object.freeze({
        version: 1,
        state: "reconciled",
        operationId: record.operationId,
        source: Object.freeze({ txid: record.source.txid, vout: record.source.vout }),
        proposalHash,
    });
}

function readReceiptSnapshot(state: WalletState): {
    record?: NativeExecutionRecord;
    receipt?: NativeExecutionReceipt;
} {
    const record = readSlot(state);
    if (!state.settings || !Object.hasOwn(state.settings, RECEIPT_SLOT)) return { record };
    const stored: unknown = state.settings[RECEIPT_SLOT];
    exactKeys(stored, ["version", "state", "operationId", "source", "proposalHash"]);
    exactKeys(stored.source, ["txid", "vout"]);
    if (!record) throw new Error("orphan native execution receipt");
    const expected = receiptFor(record);
    if (
        stored.version !== 1 ||
        stored.state !== "reconciled" ||
        stored.operationId !== expected.operationId ||
        stored.source.txid !== expected.source.txid ||
        stored.source.vout !== expected.source.vout ||
        stored.proposalHash !== expected.proposalHash
    )
        throw new Error("conflicting or unsupported native execution receipt");
    return { record, receipt: expected };
}
