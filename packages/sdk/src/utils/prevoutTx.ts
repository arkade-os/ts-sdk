import { base64, hex } from "@scure/base";
import { Transaction } from "./transaction";
import { PrevArkTxField, PrevoutTxField, getArkPsbtFields, setArkPsbtField } from "./unknownFields";

/**
 * Off-chain source of previous transactions: ark, tree and checkpoint txs, as
 * base64 PSBTs keyed by txid. Structurally satisfied by `IndexerProvider`.
 */
export interface PrevTxSource {
    getVirtualTxs(txids: string[]): Promise<{ txs: string[] }>;
}

/**
 * On-chain source of previous transactions — boarding and commitment txs, which
 * `getVirtualTxs` does not serve. Structurally satisfied by `OnchainProvider`.
 */
export interface RawTxSource {
    getRawTransaction(txid: string): Promise<Uint8Array>;
}

/**
 * A previous transaction could not be resolved, so the emulator would reject the
 * submission with `missing prevout tx for input N`. Distinguishes "no source is
 * wired up" from "the source did not have it" — the remedies differ.
 */
export class PrevTxUnavailableError extends Error {
    constructor(
        message: string,
        readonly txids: string[] = [],
    ) {
        super(message);
        this.name = "PrevTxUnavailableError";
    }
}

/**
 * Resolve raw wire-format bytes for each txid, batched and de-duplicated.
 *
 * Emulator v0.0.7+ requires the raw tx behind every input of a submitted ark tx
 * or intent proof (`PrevArkTxField`) and of an onchain tx (`PrevoutTxField`).
 * The value is a serialized `wire.MsgTx`, *not* a PSBT — `Transaction.toBytes()`
 * with the default `(withScriptSig=false, withWitness=false)` is exactly the
 * preimage the emulator hashes to check the tx against the outpoint.
 *
 * Off-chain txs are fetched in one batched call; anything the indexer does not
 * serve (a commitment or boarding tx) falls through to `onchain` when supplied.
 */
export async function resolvePrevTxs(
    txids: string[],
    source: PrevTxSource,
    onchain?: RawTxSource,
): Promise<Map<string, Uint8Array>> {
    const resolved = new Map<string, Uint8Array>();
    const wanted = [...new Set(txids)];
    if (wanted.length === 0) return resolved;

    // The response is not guaranteed to come back in request order, so key by
    // the txid each PSBT actually computes to rather than by position.
    try {
        const { txs } = await source.getVirtualTxs(wanted);
        for (const psbt of txs) {
            const tx = Transaction.fromPSBT(base64.decode(psbt));
            resolved.set(tx.id, tx.toBytes());
        }
    } catch (err) {
        // An indexer that rejects the whole batch over one unknown txid must not
        // sink a boarding tx the onchain source could have served.
        if (!onchain) throw err;
    }

    let missing = wanted.filter((txid) => !resolved.has(txid));
    if (missing.length > 0 && onchain) {
        const raw = await Promise.all(
            missing.map(async (txid) => {
                try {
                    return await onchain.getRawTransaction(txid);
                } catch {
                    return undefined; // a miss here is reported below, with all the others
                }
            }),
        );
        for (const [i, bytes] of raw.entries()) {
            if (bytes) resolved.set(missing[i], bytes);
        }
        missing = missing.filter((txid) => !resolved.has(txid));
    }

    if (missing.length > 0) {
        throw new PrevTxUnavailableError(
            `cannot resolve the previous transaction of ${missing.join(", ")}` +
                (onchain ? "" : " (no onchain source configured)"),
            missing,
        );
    }
    return resolved;
}

/**
 * Attach `PrevArkTxField` to every input of `tx` that does not already carry
 * one, resolving the bytes for `txids[i]` — the coin input `i` ultimately
 * spends.
 *
 * Inputs already carrying the field are skipped rather than overwritten: the
 * emulator rejects an input with more than one field of the same type, so a
 * caller-supplied value (`Utxo.sourceTx`) must win outright. Nothing is fetched
 * when every input is already covered.
 */
export async function attachPrevArkTxs(
    tx: Transaction,
    txids: string[],
    source: PrevTxSource,
    onchain?: RawTxSource,
): Promise<void> {
    const pending: number[] = [];
    for (let i = 0; i < tx.inputsLength; i++) {
        if (getArkPsbtFields(tx, i, PrevArkTxField).length === 0) pending.push(i);
    }
    if (pending.length === 0) return;

    const resolved = await resolvePrevTxs(
        pending.map((i) => txidAt(txids, i)),
        source,
        onchain,
    );
    for (const i of pending) {
        setArkPsbtField(tx, i, PrevArkTxField, resolved.get(txidAt(txids, i))!);
    }
}

/**
 * Attach `PrevoutTxField` to every input of an onchain PSBT, reading each
 * input's own outpoint — unlike an ark tx, an onchain tx spends its prevout
 * directly, so the txid is in the PSBT already.
 */
export async function attachPrevoutTxs(tx: Transaction, source: RawTxSource): Promise<void> {
    const pending: { index: number; txid: string }[] = [];
    for (let i = 0; i < tx.inputsLength; i++) {
        if (getArkPsbtFields(tx, i, PrevoutTxField).length > 0) continue;
        const input = tx.getInput(i);
        if (!input?.txid) throw new PrevTxUnavailableError(`input ${i} has no outpoint`);
        pending.push({ index: i, txid: hex.encode(input.txid) });
    }
    if (pending.length === 0) return;

    const resolved = new Map<string, Uint8Array>();
    for (const txid of new Set(pending.map((p) => p.txid))) {
        resolved.set(txid, await source.getRawTransaction(txid));
    }
    for (const { index, txid } of pending) {
        setArkPsbtField(tx, index, PrevoutTxField, resolved.get(txid)!);
    }
}

/**
 * A coin an intent proof spends, carrying the raw previous tx the emulator needs
 * to resolve its prevout pkScript.
 */
export type WithPrevTx<T> = T & { prevTx?: Uint8Array };

/**
 * Fill in `prevTx` on every coin an intent proof will spend, in one batched
 * lookup. The proof's synthetic input 0 needs nothing — the emulator synthesises
 * a one-output tx for it — so this covers exactly the coins, which land on proof
 * inputs `1..n`.
 */
export async function withPrevTxs<T extends { txid: string; prevTx?: Uint8Array }>(
    coins: T[],
    source: PrevTxSource,
    onchain?: RawTxSource,
): Promise<T[]> {
    const pending = coins.filter((c) => !c.prevTx);
    if (pending.length === 0) return coins;

    const resolved = await resolvePrevTxs(
        pending.map((c) => c.txid),
        source,
        onchain,
    );
    return coins.map((c) => (c.prevTx ? c : { ...c, prevTx: resolved.get(c.txid)! }));
}

function txidAt(txids: string[], index: number): string {
    const txid = txids[index];
    if (txid === undefined) {
        throw new PrevTxUnavailableError(`no source txid supplied for input ${index}`);
    }
    return txid;
}
