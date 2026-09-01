/**
 * Driving a set of funded swaps to their end.
 *
 * The tests that matter most are the ones about WHEN and about PROOF. The
 * manager holds no keys, so everything it can get wrong is a matter of timing
 * — claiming the L1 fill inside a window that two different functions describe
 * differently, refusing to claim once that window shuts, and still taking the
 * lockup back in every case where the swap died instead of settling — or a
 * matter of what it is willing to call an answer. Nothing here asks a solver
 * anything: a swap ends `settled` only on a witness that HASHES to the quote's
 * payment hash, and everything the chain cannot answer leaves it running.
 */
import { describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    CSVMultisigTapscript,
    ConditionWitness,
    VHTLCV2ContractHandler,
    buildOffchainTx,
    setArkPsbtField,
    type Contract,
    type ContractEvent,
    type CreateContractParams,
} from "@arkade-os/sdk";

import { lightningSendContract, lightningReceiveContract } from "../src/rfq";
import {
    ONCHAIN_CLAIM_MARGIN_SECONDS,
    ONCHAIN_ORDER_MARGIN_SECONDS,
    buildHtlcClaim,
    buildHtlcRefund,
    onchainHtlcScript,
    paymentHashOf,
    type ChainSource,
    type ChainUtxo,
} from "../src/onchainHtlc";
import {
    LockupNeedsRecoveryError,
    REFUND_MTP_LAG_SECONDS,
    type LockupSpendIndexer,
    type LockupVtxo,
} from "../src/refund";
import { SWAP_LOCKUP_CONTRACT_TYPE } from "../src/lockupContract";
import { RefundNotLocallyPossibleError } from "../src/refundBlocked";
import {
    RFQ_SWAP_RETENTION_SECONDS,
    createRfqSwapRecord,
    type RfqSwapOrigin,
    type RfqSwapRecord,
} from "../src/rfqRecord";
import {
    RfqSwapManager,
    RfqSwapOriginRequired,
    isRfqSwapTerminal,
    nextOnchainAction,
    type ArkadeRefundResult,
    type LightningReceiveSwap,
    type LightningSendSwap,
    type OnchainSendSwap,
    type RfqSwap,
    type RfqSwapActionName,
    type AvailableRfqSwapManagerCallbacks,
    type RfqSwapManagerCallbacks,
    type RfqSwapRecordStore,
    type RfqSwapState,
    type SwapContractRegistry,
} from "../src/swapManager";

const priv = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const key = (fill: number): Uint8Array => schnorr.getPublicKey(priv(fill));
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

const RFQ_ID = "a1".repeat(32);
const PREIMAGE = new Uint8Array(32).fill(7);
const PAYMENT_HASH = paymentHashOf(PREIMAGE);
const PAYOUT = p2tr(key(5));

const HTLC_LOCKTIME = 1_800_000_000;
/** The order `assertFundable` enforces: the Arkade refund opens LAST. */
const REFUND_LOCKTIME = HTLC_LOCKTIME + ONCHAIN_ORDER_MARGIN_SECONDS + 3600;
/** Comfortably inside the claim window, and well before the Arkade refund. */
const SAFE_NOW = HTLC_LOCKTIME - ONCHAIN_CLAIM_MARGIN_SECONDS - 3600;

const htlcOf = () =>
    onchainHtlcScript(
        {
            paymentHash: PAYMENT_HASH,
            claimKey: key(1),
            refundKey: key(3),
            refundLocktime: HTLC_LOCKTIME,
        },
        "regtest",
    );

/** The Arkade lockup, derived exactly the way both legs derive it — ONE `P`
 * unlocks the covenant's claim leaf and (for an onchain send) the L1 leaf. */
const LOCKUP = lightningSendContract({
    solverPubkey: key(1),
    operatorPubkey: key(3),
    paymentHash: PAYMENT_HASH,
    refundLocktime: REFUND_LOCKTIME,
    claimDelay: 4096,
    emulatorPubkey: key(9),
    refundPkScript: PAYOUT,
    senderPubkey: key(13),
    receiverPkScript: p2tr(key(1)),
});

/**
 * The receive corridor's lockup: the SAME covenant with the roles inverted —
 * the solver is `sender` and funds it, the trader is `receiver` and claims it.
 * Built through the production builder, so what the receive tests below drive
 * is the real tree and not the send tree wearing a different label. In
 * particular `refundWithoutReceiver` on THIS script is the solver's leaf, which
 * is what makes a spend through it a loss rather than a return.
 */
const RECEIVE_LOCKUP = lightningReceiveContract({
    solverPubkey: key(1),
    refundLocktime: REFUND_LOCKTIME,
    operatorPubkey: key(3),
    paymentHash: PAYMENT_HASH,
    claimDelay: 4096,
    emulatorPubkey: key(9),
    solverRefundPkScript: p2tr(key(1)),
    payoutPubkey: key(13),
    payoutPkScript: PAYOUT,
});

/** The lockup's funding outpoint — what a spend of it has to reference. */
const LOCKUP_OUTPOINT = { txid: "99".repeat(32), vout: 0 };
const LOCKUP_VALUE = 100_000;
/** The txid our own receive claim comes back with. */
const CLAIM_TXID = "ac".repeat(32);
/** The ark transaction a lockup spend is carried by — the counterparty's, on
 * every leg but a settled receive. */
const ARK_TXID = "ab".repeat(32);

const UNROLL = CSVMultisigTapscript.encode({
    timelock: { type: "blocks", value: BigInt(144) },
    pubkeys: [key(3)],
});

const FILL: ChainUtxo = {
    txid: "11".repeat(32),
    vout: 0,
    amount: BigInt(100_000),
    confirmations: 3,
};

/**
 * A real spend of the lockup, built the way the SDK builds every offchain
 * spend: `buildOffchainTx` emits ONE checkpoint per input, and that
 * checkpoint's single input is the one that actually spends the lockup and
 * carries its leaf's witness. That is the transaction the indexer names in
 * `spentBy`, so it is the one these fixtures hand back.
 */
const spendOfLockup = (
    over: {
        leaf?: "claim" | "refundWithoutReceiver";
        conditionWitness?: Uint8Array[];
        finalWitness?: Uint8Array[];
        /** Which covenant was spent — the send lockup unless a receive test
         * says otherwise. */
        script?: typeof LOCKUP;
    } = {},
): { txid: string; psbt: string } => {
    const script = over.script ?? LOCKUP;
    const leaf =
        over.leaf === "refundWithoutReceiver" ? script.refundWithoutReceiver() : script.claim();
    const { checkpoints } = buildOffchainTx(
        [
            {
                txid: LOCKUP_OUTPOINT.txid,
                vout: LOCKUP_OUTPOINT.vout,
                value: LOCKUP_VALUE,
                tapLeafScript: leaf,
                tapTree: script.encode(),
            },
        ],
        [{ script: PAYOUT, amount: BigInt(LOCKUP_VALUE) }],
        UNROLL,
    );
    const checkpoint = checkpoints[0];
    if (over.conditionWitness) {
        setArkPsbtField(checkpoint, 0, ConditionWitness, over.conditionWitness);
    }
    if (over.finalWitness) checkpoint.updateInput(0, { finalScriptWitness: over.finalWitness });
    return { txid: checkpoint.id, psbt: base64.encode(checkpoint.toPSBT()) };
};

/** The solver's claim: the preimage attached the way a condition closure is
 * finalized, in Ark's proprietary `ConditionWitness` PSBT field. */
const CLAIM_SPEND = spendOfLockup({ conditionWitness: [PREIMAGE] });

interface FakeVtxo {
    txid: string;
    vout: number;
    /** `""` — NOT absent — is what the indexer reports when there is nothing
     * to name. On its own it does NOT mean unspent: the wire contract permits
     * `isSpent: true` alongside it. */
    spentBy: string;
    /** The ark transaction that spent the checkpoint `spentBy` names — what
     * history correlates on, and what the manager stamps onto a terminal
     * record. Optional on the wire, so its absence is a case of its own. */
    arkTxId?: string;
    isSpent?: boolean;
    settledBy?: string;
}

/** An unspent lockup output, exactly as the indexer shapes one. */
const unspent = (): FakeVtxo[] => [{ ...LOCKUP_OUTPOINT, spentBy: "" }];
const spentBy = (txid: string): FakeVtxo[] => [{ ...LOCKUP_OUTPOINT, spentBy: txid }];
/** Spent, but by nothing the indexer names — the shape `hasTerminalSpend`
 * exists to catch. There is no witness to go and verify. */
const spentUnnamed = (over: Partial<FakeVtxo> = {}): FakeVtxo => ({
    ...LOCKUP_OUTPOINT,
    vout: 1,
    spentBy: "",
    isSpent: true,
    ...over,
});

/** A scripted indexer. Typed against the production seam so a change to
 * LockupSpendIndexer breaks this at compile time. Records the lookups made, so
 * tests can assert on what was asked, not only on what was concluded. */
type FakeIndexer = LockupSpendIndexer & { vtxoCalls: number; txLookups: string[][] };

/**
 * A funded output as `findLockupVtxos` reads one — the receive leg's view of
 * the same script. Separate from {@link FakeVtxo} because the two reads are
 * genuinely different queries: the fate read asks for everything at the script
 * and cares about `spentBy`, while this one asks the spendable and recoverable
 * filters separately and is the only read whose `value` is summed.
 */
interface FakeFunded {
    txid: string;
    vout: number;
    value: number;
    recoverable?: boolean;
}

const fakeIndexer = (
    state: {
        vtxos?: FakeVtxo[];
        /** Only the txids present here are resolvable — a `spentBy` with no
         * entry models the indexer returning fewer txs than were asked for. */
        txs?: { txid: string; psbt: string }[];
        /** What sits at the lockup, for the filtered reads. */
        funded?: FakeFunded[];
        fail?: boolean;
    } = {},
): FakeIndexer => {
    const indexer = {
        vtxoCalls: 0,
        txLookups: [] as string[][],
        async getVtxos(filter?: { spendableOnly?: boolean; recoverableOnly?: boolean }) {
            indexer.vtxoCalls += 1;
            if (state.fail) throw new Error("indexer unreachable");
            // The filters are honoured rather than ignored: `findLockupVtxos`
            // makes both calls and merges them, so a fake that answered the
            // same set twice would report every output as spendable AND
            // recoverable and hide the dedup entirely.
            const funded = state.funded ?? [];
            if (filter?.spendableOnly) return { vtxos: funded.filter((v) => !v.recoverable) };
            if (filter?.recoverableOnly) return { vtxos: funded.filter((v) => v.recoverable) };
            return { vtxos: state.vtxos ?? [] };
        },
        async getVirtualTxs(txids: string[]) {
            indexer.txLookups.push(txids);
            const known = new Map((state.txs ?? []).map((tx) => [tx.txid, tx.psbt]));
            return { txs: txids.map((id) => known.get(id)).filter((psbt) => psbt !== undefined) };
        },
    };
    return indexer as unknown as FakeIndexer;
};

/** A scripted ChainSource, mutable between passes. Records the lookups the
 * manager makes so the tests can assert on what it asked, not just on what it
 * concluded. Typed against the production contract so a change to ChainSource
 * breaks this at compile time. */
type FakeChain = ChainSource & { spendLookups: { txid: string; vout: number }[] };

const fakeChain = (state: {
    utxos?: ChainUtxo[];
    spend?: { txHex: string } | null;
    mtp?: number;
    failUtxos?: boolean;
}): FakeChain => {
    const spendLookups: { txid: string; vout: number }[] = [];
    return {
        spendLookups,
        async getScriptUtxos() {
            if (state.failUtxos) throw new Error("esplora unreachable");
            return state.utxos ?? [];
        },
        async getSpendingTx(txid: string, vout: number) {
            spendLookups.push({ txid, vout });
            return state.spend ?? null;
        },
        async broadcast() {
            return "cc".repeat(32);
        },
        async getMtp() {
            return state.mtp ?? 0;
        },
    } as unknown as FakeChain;
};

const lightningSwap = (over: Partial<LightningSendSwap> = {}): LightningSendSwap => ({
    kind: "lightning_send",
    rfqId: RFQ_ID,
    state: "pending",
    lockupPkScript: LOCKUP.pkScript,
    paymentHash: PAYMENT_HASH,
    refundLocktime: REFUND_LOCKTIME,
    createdAt: 1,
    updatedAt: 1,
    ...over,
});

const onchainSwap = (over: Partial<OnchainSendSwap> = {}): OnchainSendSwap => ({
    kind: "onchain_send",
    rfqId: RFQ_ID,
    state: "pending",
    lockupPkScript: LOCKUP.pkScript,
    paymentHash: PAYMENT_HASH,
    refundLocktime: REFUND_LOCKTIME,
    createdAt: 1,
    updatedAt: 1,
    htlc: htlcOf(),
    minConfirmations: 2,
    ...over,
});

/** The receive leg's record. `expectedAmount` is what the lockup must carry;
 * every value test below moves it or the funding against each other. */
const receiveSwap = (over: Partial<LightningReceiveSwap> = {}): LightningReceiveSwap => ({
    kind: "lightning_receive",
    rfqId: RFQ_ID,
    state: "pending",
    lockupPkScript: RECEIVE_LOCKUP.pkScript,
    paymentHash: PAYMENT_HASH,
    refundLocktime: REFUND_LOCKTIME,
    expectedAmount: LOCKUP_VALUE,
    createdAt: 1,
    updatedAt: 1,
    ...over,
});

interface Spies {
    callbacks: RfqSwapManagerCallbacks;
    claims: { rfqId: string; utxo: ChainUtxo }[];
    lockupClaims: { vtxos: readonly LockupVtxo[]; partiallyClaimed: boolean }[];
    refunds: string[];
    saved: RfqSwapState[];
    actions: RfqSwapActionName[];
}

const spies = (
    over: {
        claim?: () => Promise<{ txid: string }>;
        claimLockup?: () => Promise<{ txid: string; amount: number }>;
        refund?: () => Promise<ArkadeRefundResult>;
        probe?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
    } = {},
): Spies => {
    const claims: { rfqId: string; utxo: ChainUtxo }[] = [];
    const lockupClaims: { vtxos: readonly LockupVtxo[]; partiallyClaimed: boolean }[] = [];
    const refunds: string[] = [];
    const saved: RfqSwapState[] = [];
    return {
        claims,
        lockupClaims,
        refunds,
        saved,
        actions: [],
        callbacks: {
            async claimOnchain(swap, utxo) {
                claims.push({ rfqId: swap.rfqId, utxo });
                return over.claim ? over.claim() : { txid: "dd".repeat(32) };
            },
            async claimLockup(_swap, vtxos, options) {
                lockupClaims.push({ vtxos, partiallyClaimed: options.partiallyClaimed });
                return over.claimLockup
                    ? over.claimLockup()
                    : { txid: CLAIM_TXID, amount: LOCKUP_VALUE };
            },
            async refundArkade(swap) {
                refunds.push(swap.rfqId);
                return over.refund ? over.refund() : { txid: "ee".repeat(32), amount: 100_000 };
            },
            async saveSwap(swap) {
                saved.push(swap.state);
            },
            // optional on the interface: only wired when a test asks for it,
            // so the unprobed configuration stays the default here too
            ...(over.probe ? { canRefundArkade: over.probe } : {}),
        },
    };
};

/** A scripted contract manager. Typed against the production seam so a change
 * to `SwapContractRegistry` breaks this at compile time, and it records both
 * what was registered and how many listeners are attached — the subscription's
 * lifecycle is as much of the contract as the events themselves. */
type FakeContracts = SwapContractRegistry & {
    created: CreateContractParams[];
    retired: { script: string; watch: string }[];
    /**
     * The scripts a real manager would still subscribe and poll — every
     * written row minus the `retained` ones. Retirement is only worth
     * anything if it moves this set.
     */
    watched: () => string[];
    /** Push an event to every live listener, the way the watcher would. */
    emit: (event: ContractEvent) => void;
    listenerCount: () => number;
};

const fakeContracts = (
    over: {
        failCreate?: () => boolean;
        failRead?: () => boolean;
        /** Rows written by something other than this manager — what the request
         * entrypoints leave behind before the caller funds. */
        preexisting?: CreateContractParams[];
    } = {},
): FakeContracts => {
    const listeners = new Set<(event: ContractEvent) => void>();
    const created: CreateContractParams[] = [...(over.preexisting ?? [])];
    const retired: { script: string; watch: string }[] = [];
    const rows = new Map<string, string>(created.map((c) => [c.script, c.watch ?? "watched"]));
    return {
        created,
        retired,
        watched: () =>
            [...rows.entries()]
                .filter(([, watch]) => watch !== "retained")
                .map(([script]) => script),
        emit(event: ContractEvent) {
            for (const listener of [...listeners]) listener(event);
        },
        listenerCount: () => listeners.size,
        async createContract(params: CreateContractParams) {
            if (over.failCreate?.()) throw new Error("contract repository unavailable");
            created.push(params);
            rows.set(params.script, params.watch ?? "watched");
            return { ...params, state: "active", createdAt: 1 } as Contract;
        },
        async getContracts(filter?: { script?: string }) {
            if (over.failRead?.()) throw new Error("contract repository unavailable");
            return created
                .filter((row) => filter?.script === undefined || row.script === filter.script)
                .map((row) => ({ ...row, state: "active", createdAt: 1 }) as Contract);
        },
        onContractEvent(callback: (event: ContractEvent) => void) {
            listeners.add(callback);
            return () => listeners.delete(callback);
        },
        async setContractWatchState(script: string, watch: string) {
            // A real ContractManager resolves the row first and throws
            // `Contract ${script} not found` when there is none — modelled
            // here, so a test cannot pass by retiring something never written.
            if (!rows.has(script)) {
                throw new Error(`Contract ${script} not found`);
            }
            rows.set(script, watch);
            retired.push({ script, watch });
        },
    } as unknown as FakeContracts;
};

/** The lockup as a caller would hand it over for registration: the very
 * covenant object `pushRefundWithoutReceiver` takes, plus the address that was
 * actually funded. */
const LOCKUP_HANDLE = { script: LOCKUP, address: "ark1lockup" };
const LOCKUP_SCRIPT_HEX = hex.encode(LOCKUP.pkScript);

/** A `vtxo_spent` for the lockup, shaped the way the watcher emits one. The
 * `contract` and `vtxos` fields are deliberately junk — nothing in the manager
 * may read them, and a test that filled them in plausibly would hide it. */
const lockupEvent = (
    type: "vtxo_received" | "vtxo_spent",
    contractScript = LOCKUP_SCRIPT_HEX,
): ContractEvent =>
    ({ type, contractScript, vtxos: [], contract: {}, timestamp: 1 }) as unknown as ContractEvent;

/** A manager wired to the given seams, never started — the tests drive `poll()`
 * so nothing depends on a timer. */
const manager = (input: {
    indexer?: LockupSpendIndexer;
    chain?: ChainSource;
    contracts?: SwapContractRegistry;
    repository?: RfqSwapRecordStore;
    now: number | (() => number);
    spies: Spies;
    enableAutoActions?: boolean;
    /** What to install instead of the full spy set — a half-wired
     * installation, which only the relaxed type makes expressible. */
    install?: AvailableRfqSwapManagerCallbacks;
}): RfqSwapManager => {
    const m = new RfqSwapManager(
        {
            indexer: input.indexer ?? fakeIndexer({ vtxos: unspent() }),
            chain: input.chain,
            contracts: input.contracts,
            repository: input.repository,
        },
        {
            now: typeof input.now === "function" ? input.now : () => input.now as number,
            enableAutoActions: input.enableAutoActions,
            events: { onActionExecuted: (_s, a) => input.spies.actions.push(a) },
        },
    );
    m.setCallbacks(input.install ?? input.spies.callbacks);
    return m;
};

/** The spy set minus one claim. */
const without = (
    s: Spies,
    key: "claimOnchain" | "claimLockup",
): AvailableRfqSwapManagerCallbacks => {
    const relaxed: AvailableRfqSwapManagerCallbacks = { ...s.callbacks };
    delete relaxed[key];
    return relaxed;
};

describe("nextOnchainAction", () => {
    const at = (phase: Parameters<typeof nextOnchainAction>[0]["phase"], now: number) =>
        nextOnchainAction({ phase, htlcLocktime: HTLC_LOCKTIME, now });

    it("waits while the fill is missing or shallow", () => {
        expect(at({ phase: "unfunded" }, SAFE_NOW)).toBe("wait");
        expect(at({ phase: "awaiting_confirmations", utxo: FILL }, SAFE_NOW)).toBe("wait");
    });

    it("claims a confirmed fill while the window is open", () => {
        expect(at({ phase: "claimable", utxo: FILL }, SAFE_NOW)).toBe("claim");
    });

    it("refuses to claim inside the margin, though the phase still says claimable", () => {
        // THE trap. classifyOnchainHtlc reports `claimable` right up until
        // median-time-past reaches refundLocktime, but claimOnchainFill refuses
        // from ONCHAIN_CLAIM_MARGIN_SECONDS before it — so driving straight off
        // the phase would spend that whole margin throwing claim_window_closed
        // at every poll and never fall back to the Arkade refund.
        const inside = HTLC_LOCKTIME - ONCHAIN_CLAIM_MARGIN_SECONDS + 1;
        expect(at({ phase: "claimable", utxo: FILL }, inside)).toBe("claim_window_closed");
        // and the boundary itself is still claimable
        expect(
            at({ phase: "claimable", utxo: FILL }, HTLC_LOCKTIME - ONCHAIN_CLAIM_MARGIN_SECONDS),
        ).toBe("claim");
    });

    it("never claims once the solver's refund leaf has matured", () => {
        expect(at({ phase: "refundable", utxo: FILL }, SAFE_NOW)).toBe("claim_window_closed");
    });

    it("reports a settled L1 half as claimed or swept", () => {
        expect(at({ phase: "claimed", txid: "ab".repeat(32), preimage: PREIMAGE }, SAFE_NOW)).toBe(
            "claimed",
        );
        expect(at({ phase: "swept", txid: "ab".repeat(32) }, SAFE_NOW)).toBe("swept");
    });
});

describe("RfqSwapManager — resolution is read off chain, and only proof counts", () => {
    /** One pass over a lightning-send swap against the given lockup state. */
    const resolve = async (indexer: LockupSpendIndexer, now = SAFE_NOW) => {
        const s = spies();
        const swap = lightningSwap();
        const m = manager({ indexer, now, spies: s });
        await m.addSwap(swap);
        await m.poll();
        return { swap, s };
    };

    it("settles on a preimage that hashes to the payment hash", async () => {
        const { swap, s } = await resolve(
            fakeIndexer({ vtxos: spentBy(CLAIM_SPEND.txid), txs: [CLAIM_SPEND] }),
        );
        expect(swap.state).toBe("settled");
        expect(s.refunds).toHaveLength(0);
    });

    it("reads the preimage out of the raw witness stack too, not only the Ark field", async () => {
        // A claim may carry P in `finalScriptWitness` rather than in Ark's
        // proprietary ConditionWitness field; both are searched, because
        // reading only one would miss a real settlement.
        const spend = spendOfLockup({ finalWitness: [PREIMAGE, new Uint8Array([1])] });
        const { swap } = await resolve(fakeIndexer({ vtxos: spentBy(spend.txid), txs: [spend] }));
        expect(swap.state).toBe("settled");
    });

    it("does NOT settle on a preimage-shaped item that hashes to something else", async () => {
        // THE security property. A matching witness SHAPE is not proof — a
        // 32-byte item is just bytes until it hashes to the payment hash. Read
        // permissively, this would tell a trader their Lightning payment landed
        // when the money actually came back.
        const impostor = new Uint8Array(32).fill(8);
        expect(paymentHashOf(impostor)).not.toBe(PAYMENT_HASH);
        const spend = spendOfLockup({
            conditionWitness: [impostor],
            finalWitness: [impostor, new Uint8Array(32).fill(9)],
        });
        const { swap } = await resolve(fakeIndexer({ vtxos: spentBy(spend.txid), txs: [spend] }));
        expect(swap.state).toBe("refunded");
    });

    it("reads a spend carrying no preimage at all as a refund", async () => {
        // Every non-claim leaf either pays the trader's own committed address
        // (the covenant pins it) or needs the trader's own signature, so a
        // spend with nothing to verify means the money went back.
        const spend = spendOfLockup({ leaf: "refundWithoutReceiver" });
        const { swap } = await resolve(fakeIndexer({ vtxos: spentBy(spend.txid), txs: [spend] }));
        expect(swap.state).toBe("refunded");
    });

    it("ignores a preimage attached to a spend of somebody else's outpoint", async () => {
        // The witness only counts when it is on the input that spends OUR
        // lockup output; a tx that reveals P against a different outpoint says
        // nothing about this swap's lockup.
        const spend = spendOfLockup({ conditionWitness: [PREIMAGE] });
        const vtxos = [{ txid: "77".repeat(32), vout: 3, spentBy: spend.txid }];
        const { swap } = await resolve(fakeIndexer({ vtxos, txs: [spend] }));
        expect(swap.state).toBe("refunded");
    });

    it("leaves an unspent lockup pending, and asks nobody", async () => {
        const indexer = fakeIndexer({ vtxos: unspent() });
        const { swap } = await resolve(indexer);
        expect(swap.state).toBe("pending");
        // nothing spent, so no spend to look up
        expect(indexer.txLookups).toHaveLength(0);
    });

    it("treats an indexer that cannot answer as nothing learned, never as resolved", async () => {
        const { swap } = await resolve(fakeIndexer({ fail: true }));
        expect(swap.state).toBe("pending");
    });

    it("does not read an output spent by nothing it can name as still funded", async () => {
        // The wire contract permits `isSpent: true` with an EMPTY `spentBy`, so
        // testing `spentBy` alone would call a lockup that is gone "still
        // there" — the exact misclassification the SDK's own `hasTerminalSpend`
        // unions three facts to avoid. There is no witness to verify here, so
        // the honest answer is `unknown`, never `returned`.
        const indexer = fakeIndexer({ vtxos: [spentUnnamed()] });
        const { swap } = await resolve(indexer);
        expect(swap.state).toBe("pending");
        // nothing named, so there was nothing to go and fetch
        expect(indexer.txLookups).toEqual([[]]);
    });

    it("still finds the claim when a sibling output was spent by nothing it can name", async () => {
        // Two funded outputs: one claimed, one spent with no `spentBy` to
        // follow. Reading the unnamed one as "still funded" would abandon the
        // search and miss a settlement that is sitting right there, proven.
        const indexer = fakeIndexer({
            vtxos: [...spentBy(CLAIM_SPEND.txid), spentUnnamed()],
            txs: [CLAIM_SPEND],
        });
        const { swap } = await resolve(indexer);
        expect(swap.state).toBe("settled");
    });

    it("does not read a lockup that is not visible yet as one that came back", async () => {
        // No outputs at the script at all — a swap added a moment before its
        // funding vtxo is indexed, or an indexer still catching up. Nothing was
        // spent, so nothing came back; calling this `refunded` would drop a
        // freshly funded swap out of monitoring and tell the trader their money
        // is home when it is sitting at the lockup.
        const indexer = fakeIndexer({ vtxos: [] });
        const { swap } = await resolve(indexer);
        expect(swap.state).toBe("pending");
        expect(indexer.txLookups).toHaveLength(0);
    });

    it("does not call a lockup refunded when the spend itself is not observable", async () => {
        // `getVirtualTxs` may legitimately return fewer transactions than were
        // asked for. An unobservable spend is `unknown`, not proof of anything
        // — reading it as a refund would report the wrong outcome for a swap
        // that in fact settled.
        const indexer = fakeIndexer({ vtxos: spentBy(CLAIM_SPEND.txid), txs: [] });
        const { swap } = await resolve(indexer);
        expect(swap.state).toBe("pending");
        expect(indexer.txLookups).toEqual([[CLAIM_SPEND.txid]]);
    });

    it("still refunds a lockup that is funded past the deadline, whatever the negotiation did", async () => {
        // There is no negotiation state to consult any more, and that is the
        // point: `refused`, `expired` and `stuck` never ended a swap that still
        // had sats at the lockup, and now nothing but the lockup can.
        const { swap, s } = await resolve(fakeIndexer({ vtxos: unspent() }), REFUND_LOCKTIME + 1);
        expect(swap.state).toBe("refunded");
        expect(s.refunds).toEqual([RFQ_ID]);
    });

    it("does not let an unreachable indexer block the refund gate", async () => {
        // The gate depends on `refundLocktime` alone, and that timelock is not
        // something an outage can move — so an indexer that cannot answer must
        // not be able to strand the lockup.
        const { swap, s } = await resolve(fakeIndexer({ fail: true }), REFUND_LOCKTIME + 1);
        expect(swap.state).toBe("refunded");
        expect(s.refunds).toEqual([RFQ_ID]);
    });

    it("watches the lockup by its own script", async () => {
        const indexer = fakeIndexer({ vtxos: unspent() });
        const seen: (string[] | undefined)[] = [];
        const original = indexer.getVtxos.bind(indexer);
        indexer.getVtxos = async (opts?: { scripts?: string[] }) => {
            seen.push(opts?.scripts);
            return original(opts as never);
        };
        await resolve(indexer);
        expect(seen).toEqual([[hex.encode(LOCKUP.pkScript)]]);
    });
});

describe("RfqSwapManager — the onchain-send L1 half", () => {
    it("claims a confirmed fill and records the txid", async () => {
        const s = spies();
        const swap = onchainSwap();
        const m = manager({
            chain: fakeChain({ utxos: [FILL], mtp: SAFE_NOW }),
            now: SAFE_NOW,
            spies: s,
        });
        await m.start([swap]);
        await m.stop();

        expect(s.claims).toHaveLength(1);
        expect(s.claims[0].utxo.txid).toBe(FILL.txid);
        expect(swap.state).toBe("claimed");
        expect(swap.claimTxid).toBe("dd".repeat(32));
        expect(s.actions).toEqual(["claimOnchain"]);
    });

    it("does not claim inside the margin, and does not refund early either", async () => {
        const s = spies();
        const inside = HTLC_LOCKTIME - ONCHAIN_CLAIM_MARGIN_SECONDS + 60;
        const swap = onchainSwap();
        const m = manager({
            // still `claimable` as far as the phase is concerned
            chain: fakeChain({ utxos: [FILL], mtp: inside }),
            now: inside,
            spies: s,
        });
        await m.addSwap(swap);
        await m.poll();

        expect(s.claims).toHaveLength(0);
        expect(s.refunds).toHaveLength(0); // the Arkade window has not opened
        expect(swap.state).toBe("pending");
    });

    it("never claims from `refundable`, and takes the lockup back instead", async () => {
        const s = spies();
        const past = REFUND_LOCKTIME + 60;
        const swap = onchainSwap();
        const m = manager({
            chain: fakeChain({ utxos: [FILL], mtp: HTLC_LOCKTIME + 1 }),
            now: past,
            spies: s,
        });
        await m.addSwap(swap);
        await m.poll();

        expect(s.claims).toHaveLength(0);
        expect(s.refunds).toEqual([RFQ_ID]);
        expect(swap.state).toBe("refunded");
        expect(swap.refundTxid).toBe("ee".repeat(32));
    });

    it("remembers the fill's outpoint, so a spent HTLC is not read back as unfunded", async () => {
        const s = spies();
        const chain = fakeChain({ utxos: [FILL], mtp: SAFE_NOW });
        const swap = onchainSwap();
        const m = manager({
            chain,
            now: SAFE_NOW,
            spies: s,
            enableAutoActions: false,
        });
        await m.addSwap(swap);
        await m.poll();
        expect(swap.funding).toEqual({ txid: FILL.txid, vout: FILL.vout });

        // The fill is gone; only the remembered outpoint can tell "spent" from
        // "never funded" — classifyOnchainHtlc looks up the spend only when it
        // is given one.
        const refundSpend = await buildHtlcRefund({
            htlc: htlcOf(),
            utxo: FILL,
            payoutPkScript: PAYOUT,
            feeRateSatVb: 2,
            sign: async (sighash) => schnorr.sign(sighash, priv(3)),
        });
        const swept = fakeChain({ utxos: [], spend: { txHex: refundSpend.txHex } });
        const m2 = manager({
            chain: swept,
            now: SAFE_NOW,
            spies: s,
        });
        await m2.addSwap(swap);
        await m2.poll();
        expect(swept.spendLookups).toEqual([{ txid: FILL.txid, vout: FILL.vout }]);
    });

    it("recovers a claim made before a restart, reading the txid off chain", async () => {
        const s = spies();
        const claimSpend = await buildHtlcClaim({
            htlc: htlcOf(),
            utxo: FILL,
            preimage: PREIMAGE,
            payoutPkScript: PAYOUT,
            feeRateSatVb: 2,
            sign: async (sighash) => schnorr.sign(sighash, priv(1)),
        });
        const swap = onchainSwap({ funding: { txid: FILL.txid, vout: FILL.vout } });
        const m = manager({
            chain: fakeChain({ utxos: [], spend: { txHex: claimSpend.txHex } }),
            now: SAFE_NOW,
            spies: s,
        });
        await m.addSwap(swap);
        await m.poll();

        expect(swap.state).toBe("claimed");
        expect(swap.claimTxid).toBe(claimSpend.txid);
        expect(s.claims).toHaveLength(0); // nothing to re-broadcast
    });

    it("keeps watching the lockup after a claim, and takes it back if nobody comes", async () => {
        // The trader has its onchain coins, but the Arkade lockup is still
        // funded and still the trader's to recover if the solver never claims.
        const s = spies();
        const swap = onchainSwap({ state: "claimed", claimTxid: "dd".repeat(32) });
        const m = manager({
            chain: fakeChain({ utxos: [] }),
            now: REFUND_LOCKTIME + 60,
            spies: s,
        });
        await m.addSwap(swap);
        await m.poll();

        expect(s.refunds).toEqual([RFQ_ID]);
        expect(swap.state).toBe("refunded");
    });

    it("reports the solver's own claim of the lockup as settled, not as a refund", async () => {
        // The happy end of an onchain send: the trader took the L1 fill, and
        // the solver then claimed the Arkade lockup with the P that claim
        // published. "The lockup is empty" alone cannot tell that apart from
        // the money coming back — the hash-verified witness can, and calling it
        // a refund would tell the trader the exact opposite of what happened.
        const s = spies();
        const swap = onchainSwap({ state: "claimed", claimTxid: "dd".repeat(32) });
        const m = manager({
            indexer: fakeIndexer({ vtxos: spentBy(CLAIM_SPEND.txid), txs: [CLAIM_SPEND] }),
            chain: fakeChain({ utxos: [] }),
            now: REFUND_LOCKTIME + 60,
            spies: s,
        });
        await m.addSwap(swap);
        await m.poll();

        expect(swap.state).toBe("settled");
        expect(s.refunds).toHaveLength(0);
    });

    it("still refunds a swap the solver never filled at all", async () => {
        // `unfunded` at refundLocktime means the solver never came — the one
        // case a manager that treats "keep waiting for the fill" as the end of
        // the pass would sit on forever with the lockup stranded.
        const s = spies();
        const swap = onchainSwap();
        const m = manager({
            chain: fakeChain({ utxos: [] }),
            now: REFUND_LOCKTIME + 60,
            spies: s,
        });
        await m.addSwap(swap);
        await m.poll();

        expect(swap.state).toBe("refunded");
        expect(s.refunds).toEqual([RFQ_ID]);
    });

    it("claims even while the Arkade indexer is down", async () => {
        // The L1 claim is on a consensus deadline; no other service's uptime
        // has any bearing on it, so a failing indexer must not stall the pass.
        const s = spies();
        const swap = onchainSwap();
        const m = manager({
            indexer: fakeIndexer({ fail: true }),
            chain: fakeChain({ utxos: [FILL], mtp: SAFE_NOW }),
            now: SAFE_NOW,
            spies: s,
        });
        await m.addSwap(swap);
        await m.poll();

        expect(s.claims).toHaveLength(1);
        expect(swap.state).toBe("claimed");
    });

    it("fails loudly when asked to watch an onchain swap with no ChainSource", async () => {
        const s = spies();
        const swap = onchainSwap();
        const failures: string[] = [];
        const completed: RfqSwap[] = [];
        const m = new RfqSwapManager(
            { indexer: fakeIndexer({ vtxos: unspent() }) },
            {
                now: () => SAFE_NOW,
                events: {
                    onSwapFailed: (_s, e) => failures.push(e.message),
                    onSwapCompleted: (s2) => completed.push(s2),
                },
            },
        );
        m.setCallbacks(s.callbacks);
        await m.start([swap]);
        await m.stop();

        expect(swap.state).toBe("failed");
        expect(failures[0]).toMatch(/ChainSource/);
        expect(await m.hasSwap(RFQ_ID)).toBe(false);
        // and NOT through onSwapCompleted: a listener by that name firing on a
        // failure is a trap this manager avoids
        expect(completed).toHaveLength(0);
    });

    it("treats a chain read that failed as nothing learned, not as an answer", async () => {
        const s = spies();
        const swap = onchainSwap();
        const m = manager({
            chain: fakeChain({ failUtxos: true }),
            now: SAFE_NOW,
            spies: s,
        });
        await m.addSwap(swap);
        await m.poll();

        expect(swap.state).toBe("pending");
        expect(s.claims).toHaveLength(0);
    });

    it("still takes the lockup back while the chain is unreachable", async () => {
        // The refund gate depends on `refundLocktime` alone, and the timelock
        // order puts that well after the L1 window shuts — so an esplora
        // outage must not be able to strand the lockup.
        const s = spies();
        const swap = onchainSwap();
        const m = manager({
            chain: fakeChain({ failUtxos: true }),
            now: REFUND_LOCKTIME + 60,
            spies: s,
        });
        await m.addSwap(swap);
        await m.poll();

        expect(swap.state).toBe("refunded");
        expect(s.refunds).toEqual([RFQ_ID]);
    });
});

describe("RfqSwapManager — the lightning-send leg", () => {
    it("ends on the lockup's own resolution, without pushing a refund", async () => {
        const cases = [
            { spend: CLAIM_SPEND, expected: "settled" },
            { spend: spendOfLockup({ leaf: "refundWithoutReceiver" }), expected: "refunded" },
        ] as const;
        for (const { spend, expected } of cases) {
            const s = spies();
            const swap = lightningSwap();
            const m = manager({
                indexer: fakeIndexer({ vtxos: spentBy(spend.txid), txs: [spend] }),
                // past the refund deadline, so only the lockup's fate can be
                // what stopped the push
                now: REFUND_LOCKTIME + REFUND_MTP_LAG_SECONDS,
                spies: s,
            });
            await m.addSwap(swap);
            await m.poll();

            expect(swap.state).toBe(expected);
            expect(s.refunds).toHaveLength(0);
            expect(await m.hasSwap(RFQ_ID)).toBe(false);
        }
    });

    it("does nothing while the refund window is shut", async () => {
        const s = spies();
        const swap = lightningSwap();
        const m = manager({ now: REFUND_LOCKTIME - 1, spies: s });
        await m.addSwap(swap);
        await m.poll();

        expect(s.refunds).toHaveLength(0);
        expect(swap.state).toBe("pending");
    });

    it("retries a push refused while median-time-past lags, at the poll cadence", async () => {
        let attempts = 0;
        const s = spies({
            refund: async () => {
                if (++attempts <= 2) throw new Error("FORFEIT_CLOSURE_LOCKED");
                return { txid: "ee".repeat(32), amount: 100_000 };
            },
        });
        const swap = lightningSwap();
        const m = manager({ now: REFUND_LOCKTIME + 1, spies: s });
        await m.addSwap(swap);
        await m.poll();
        expect(attempts).toBe(1);
        expect(swap.state).toBe("pending"); // a refusal is not a failure yet
        await m.poll();
        await m.poll();

        expect(attempts).toBe(3);
        expect(swap.state).toBe("refunded");
    });

    it("gives up once the attempt window closes, keeping the server's reason", async () => {
        const s = spies({
            refund: async () => {
                throw new Error("FORFEIT_CLOSURE_LOCKED");
            },
        });
        const swap = lightningSwap();
        const m = manager({
            now: REFUND_LOCKTIME + REFUND_MTP_LAG_SECONDS,
            spies: s,
        });
        await m.addSwap(swap);
        await m.poll();

        expect(swap.state).toBe("failed");
        expect(swap.failure).toMatch(/FORFEIT_CLOSURE_LOCKED/);
    });

    it("treats an empty lockup as nothing left to do", async () => {
        // The one place the manager settles for less than proof: the chain read
        // could not resolve the spend, the refund push finds nothing to return,
        // and there is no further move available.
        const s = spies({ refund: async () => null });
        const swap = lightningSwap();
        const m = manager({
            indexer: fakeIndexer({ vtxos: [] }),
            now: REFUND_LOCKTIME + 1,
            spies: s,
        });
        await m.addSwap(swap);
        await m.poll();

        expect(swap.state).toBe("refunded");
        expect(swap.refundTxid).toBeUndefined();
    });
});

/**
 * The receive leg, where both halves of every other corridor are inverted: the
 * SOLVER funds the lockup and the TRADER claims it.
 *
 * So the tests here are about the two things that inversion changes. First,
 * what the manager is willing to publish `P` for — deriving the script proves
 * nothing on this leg, because the script was never the lie, and a claim of a
 * dust-funded lockup hands the solver a full Lightning settlement for nothing.
 * Second, what the states mean: `refunded` is a LOSS here, `claimed` is our own
 * belief rather than a chain fact, and there is no trader-side refund to fall
 * back on when the window shuts.
 */
describe("RfqSwapManager — the lightning-receive leg", () => {
    /** One pass over a receive swap. The manager is never started here, so
     * `addSwap` does not poll on its own — same as every other block. */
    const pass = async (m: RfqSwapManager, swap: LightningReceiveSwap): Promise<void> => {
        await m.addSwap(swap);
        await m.poll();
    };

    /** A lockup funded with one output, unspent — so the fate read says `open`
     * and the pass carries on to the claim. */
    const fundedIndexer = (value = LOCKUP_VALUE, over: Partial<FakeFunded> = {}) =>
        fakeIndexer({
            vtxos: unspent(),
            funded: [{ ...LOCKUP_OUTPOINT, value, ...over }],
        });

    /** Comfortably inside the claim window. */
    const BEFORE_DEADLINE = REFUND_LOCKTIME - 3600;

    it("claims a lockup funded for the agreed amount", async () => {
        const s = spies();
        const swap = receiveSwap();
        const m = manager({ indexer: fundedIndexer(), now: BEFORE_DEADLINE, spies: s });
        await pass(m, swap);

        expect(s.lockupClaims).toHaveLength(1);
        expect(s.lockupClaims[0].partiallyClaimed).toBe(false);
        expect(s.lockupClaims[0].vtxos).toEqual([
            { ...LOCKUP_OUTPOINT, value: LOCKUP_VALUE, recoverable: false },
        ]);
        expect(swap.state).toBe("claimed");
        expect(swap.claimTxid).toBe(CLAIM_TXID);
        expect(s.actions).toEqual(["claimLockup"]);
        // and it is not over: `claimed` is what we did, not what the chain says
        expect(await m.hasSwap(RFQ_ID)).toBe(true);
    });

    it("overfunding is fine; the gate is a floor", async () => {
        const s = spies();
        const swap = receiveSwap();
        const m = manager({
            indexer: fundedIndexer(LOCKUP_VALUE + 1),
            now: BEFORE_DEADLINE,
            spies: s,
        });
        await pass(m, swap);

        expect(swap.state).toBe("claimed");
    });

    it("sums funding split across outputs rather than reading the first", async () => {
        const s = spies();
        const swap = receiveSwap();
        const m = manager({
            indexer: fakeIndexer({
                vtxos: unspent(),
                funded: [
                    { ...LOCKUP_OUTPOINT, value: LOCKUP_VALUE - 1 },
                    { ...LOCKUP_OUTPOINT, vout: 1, value: 1 },
                ],
            }),
            now: BEFORE_DEADLINE,
            spies: s,
        });
        await pass(m, swap);

        expect(swap.state).toBe("claimed");
        expect(s.lockupClaims[0].vtxos).toHaveLength(2);
    });

    it("counts a swept output toward the funded value", async () => {
        // A recoverable output is the agreed money still sitting at the script,
        // so it makes the difference between the gate reading this lockup as
        // fully funded and reading it as one satoshi short. What cannot be done
        // with it is spend it offchain, and `pushClaim` refuses that by name —
        // which is why it is handed to the callback rather than dropped here.
        const s = spies();
        const swap = receiveSwap();
        const m = manager({
            indexer: fakeIndexer({
                vtxos: unspent(),
                funded: [
                    { ...LOCKUP_OUTPOINT, value: LOCKUP_VALUE - 1 },
                    { ...LOCKUP_OUTPOINT, vout: 1, value: 1, recoverable: true },
                ],
            }),
            now: BEFORE_DEADLINE,
            spies: s,
        });
        await pass(m, swap);

        expect(swap.state).toBe("claimed");
        expect(s.lockupClaims[0].vtxos).toEqual([
            { ...LOCKUP_OUTPOINT, value: LOCKUP_VALUE - 1, recoverable: false },
            { ...LOCKUP_OUTPOINT, vout: 1, value: 1, recoverable: true },
        ]);
    });

    it("refuses to publish the preimage for a dust-funded lockup", async () => {
        // THE attack this leg has and no other: the solver funds the correctly
        // derived script with dust. Claiming makes `P` public, which is what
        // lets the solver settle the payer's held HTLC in full.
        const s = spies();
        const swap = receiveSwap();
        const m = manager({ indexer: fundedIndexer(330), now: BEFORE_DEADLINE, spies: s });
        await pass(m, swap);

        expect(s.lockupClaims).toHaveLength(0);
        expect(swap.state).toBe("needs_counterparty");
        expect(swap.blockedReason).toMatch(/330 sats, below the agreed 100000/);
        // not terminal: the solver can still make this right
        expect(await m.hasSwap(RFQ_ID)).toBe(true);
    });

    it("refuses a record whose expectedAmount cannot be compared against", async () => {
        // The same class as the invoice gate's non-finite guards: `locked <
        // undefined` and `locked < NaN` are both false, so an unusable
        // comparand does not FAIL the value gate, it deletes it — and the claim
        // proceeds for whatever was funded.
        for (const expectedAmount of [Number.NaN, undefined as unknown as number]) {
            const s = spies();
            const swap = receiveSwap({ expectedAmount });
            const m = manager({ indexer: fundedIndexer(1), now: BEFORE_DEADLINE, spies: s });
            await pass(m, swap);

            expect(s.lockupClaims).toHaveLength(0);
            expect(swap.state).toBe("needs_counterparty");
            expect(swap.blockedReason).toMatch(/not a finite number/);
        }
    });

    it("claims as soon as the solver tops a short lockup up", async () => {
        const s = spies();
        const swap = receiveSwap();
        let value = LOCKUP_VALUE - 1;
        const m = manager({
            indexer: fakeIndexer({
                vtxos: unspent(),
                // read fresh every pass, so the top-up is visible
                get funded() {
                    return [{ ...LOCKUP_OUTPOINT, value }];
                },
            }),
            now: BEFORE_DEADLINE,
            spies: s,
        });
        await pass(m, swap);
        expect(swap.state).toBe("needs_counterparty");

        value = LOCKUP_VALUE;
        await m.poll();

        expect(swap.state).toBe("claimed");
        expect(s.lockupClaims).toHaveLength(1);
        // the refusal's reason does not outlive the refusal
        expect(swap.blockedReason).toBeUndefined();
    });

    it("never pushes an Arkade refund, before or after the deadline", async () => {
        // Every non-claim leaf of this covenant is the SOLVER's. A generic
        // caller that wired `refundArkade` for its send swaps must not see it
        // called with a receive one.
        for (const now of [BEFORE_DEADLINE, REFUND_LOCKTIME + 1, REFUND_LOCKTIME + 100_000]) {
            let probes = 0;
            const s = spies({
                probe: async () => {
                    probes += 1;
                    return { ok: true };
                },
            });
            const swap = receiveSwap();
            const m = manager({ indexer: fundedIndexer(), now, spies: s });
            await pass(m, swap);

            expect(s.refunds).toHaveLength(0);
            // not even asked whether one is possible — there is nothing to ask
            expect(probes).toBe(0);
        }
    });

    it("stops claiming at refundLocktime, and claims right up to it", async () => {
        // No margin, deliberately: the claim is an offchain spend that lands in
        // seconds, and the solver's CLTV matures against median-time-past, so
        // the real window runs PAST this deadline rather than ending before it.
        const claimed = spies();
        const open = receiveSwap();
        const before = manager({
            indexer: fundedIndexer(),
            now: REFUND_LOCKTIME - 1,
            spies: claimed,
        });
        await pass(before, open);
        expect(open.state).toBe("claimed");

        const s = spies();
        const shut = receiveSwap();
        const after = manager({ indexer: fundedIndexer(), now: REFUND_LOCKTIME, spies: s });
        await pass(after, shut);

        expect(s.lockupClaims).toHaveLength(0);
        expect(shut.state).toBe("needs_counterparty");
        expect(shut.blockedReason).toMatch(/claim window closed/);
    });

    it("keeps a submitted claim's label once the window shuts", async () => {
        // `claimed` is still the truest thing the record knows; replacing it
        // with a refusal would un-say it.
        const s = spies();
        const swap = receiveSwap({ state: "claimed", claimTxid: CLAIM_TXID });
        const m = manager({ indexer: fundedIndexer(), now: REFUND_LOCKTIME + 1, spies: s });
        await pass(m, swap);

        expect(swap.state).toBe("claimed");
        expect(swap.blockedReason).toBeUndefined();
    });

    it("settles on a hash-verified spend made by a txid that is not ours", async () => {
        // `nonInteractiveClaim` is pinned to the trader's own payout script, so
        // a claim that lands without us still pays us. Matching on the txid we
        // submitted would turn that success into an anomaly the day covclaimd
        // starts working.
        const spend = spendOfLockup({ script: RECEIVE_LOCKUP, conditionWitness: [PREIMAGE] });
        expect(spend.txid).not.toBe(CLAIM_TXID);

        const s = spies();
        const swap = receiveSwap({ state: "claimed", claimTxid: CLAIM_TXID });
        const m = manager({
            indexer: fakeIndexer({ vtxos: spentBy(spend.txid), txs: [spend] }),
            now: BEFORE_DEADLINE,
            spies: s,
        });
        await pass(m, swap);

        // and the name collision one layer apart: fate `claimed` is state
        // `settled`, never state `claimed`
        expect(swap.state).toBe("settled");
        expect(await m.hasSwap(RFQ_ID)).toBe(false);
    });

    it("a claim that never lands ends refunded when the solver takes the lockup back", async () => {
        // The transition the state doc has to make legal: `claimed` is not
        // terminal, so it must not retire the swap.
        const s = spies();
        const swap = receiveSwap({ state: "claimed", claimTxid: CLAIM_TXID });
        const solverRefund = spendOfLockup({
            script: RECEIVE_LOCKUP,
            leaf: "refundWithoutReceiver",
        });
        const m = manager({
            indexer: fakeIndexer({ vtxos: spentBy(solverRefund.txid), txs: [solverRefund] }),
            now: BEFORE_DEADLINE,
            spies: s,
        });
        await pass(m, swap);

        expect(swap.state).toBe("refunded");
        expect(isRfqSwapTerminal(swap.state)).toBe(true);
    });

    it("reports a lost receive without the txid of the claim that lost it", async () => {
        // The one combination where a `txid` on the outcome would name an
        // action that did not happen: the claim was submitted, the chain never
        // took it, and the solver reclaimed the lockup. The record keeps
        // `claimTxid` for diagnosis; the outcome does not carry it.
        const s = spies();
        const swap = receiveSwap({ state: "claimed", claimTxid: CLAIM_TXID });
        const solverRefund = spendOfLockup({
            script: RECEIVE_LOCKUP,
            leaf: "refundWithoutReceiver",
        });
        const m = manager({
            indexer: fakeIndexer({ vtxos: spentBy(solverRefund.txid), txs: [solverRefund] }),
            now: BEFORE_DEADLINE,
            spies: s,
        });
        await m.addSwap(swap);
        const waiting = m.waitForSwapCompletion(RFQ_ID);
        await m.poll();

        expect(swap.claimTxid).toBe(CLAIM_TXID);
        await expect(waiting).resolves.toEqual({ state: "refunded", txid: undefined });
    });

    it("reports nothing wired to claim, instead of a lockup nobody here can take", async () => {
        // `claimable` would name an action this wallet cannot perform by hand
        // either, and the swap would sit at it until the window shut.
        const swap = receiveSwap();
        const m = new RfqSwapManager({ indexer: fundedIndexer() }, { now: () => BEFORE_DEADLINE });
        await m.addSwap(swap);
        await m.poll();

        expect(swap.state).toBe("needs_counterparty");
        expect(swap.blockedReason).toMatch(/no callbacks are wired/);
    });

    it("ends refunded, not failed, when only a re-claim was the thing that threw", async () => {
        // Both `claimTxid` and a claim error are set when the window shuts.
        // A claim went out, so this is an ordinary loss rather than a wallet
        // that could not act — `failed` is reserved for the latter.
        let now = BEFORE_DEADLINE;
        let fail = false;
        const s = spies({
            claimLockup: async () => {
                if (fail) throw new Error("ark server unreachable");
                return { txid: CLAIM_TXID, amount: LOCKUP_VALUE };
            },
        });
        const swap = receiveSwap();
        const funded = [{ ...LOCKUP_OUTPOINT, value: LOCKUP_VALUE }];
        const m = manager({
            indexer: fakeIndexer({
                vtxos: unspent(),
                get funded() {
                    return funded;
                },
            }),
            now: () => now,
            spies: s,
        });
        await pass(m, swap);
        expect(swap.claimTxid).toBe(CLAIM_TXID);

        fail = true;
        funded.push({ ...LOCKUP_OUTPOINT, vout: 1, value: 500 });
        await m.poll();
        expect(s.lockupClaims).toHaveLength(2);

        now = REFUND_LOCKTIME + REFUND_MTP_LAG_SECONDS;
        await m.poll();

        expect(swap.state).toBe("refunded");
        expect(swap.failure).toBeUndefined();
    });

    it("sweeps a lockup topped up after a claim, skipping the value gate", async () => {
        // Once `P` is public the value gate protects nothing, and holding the
        // remainder back over it would strand the trader's own money — note the
        // funding here is far below `expectedAmount` and is claimed anyway.
        const s = spies();
        const swap = receiveSwap({ state: "claimed", claimTxid: CLAIM_TXID });
        const m = manager({ indexer: fundedIndexer(1), now: BEFORE_DEADLINE, spies: s });
        await pass(m, swap);

        expect(s.lockupClaims).toHaveLength(1);
        expect(s.lockupClaims[0].partiallyClaimed).toBe(true);
        expect(swap.state).toBe("claimed");
    });

    it("does not re-claim the same outputs while the indexer catches up", async () => {
        // The spend is submitted and finalized, but the outputs keep reading as
        // unspent for a few passes. Re-submitting them would fail against the
        // server every time and report a swap that worked as one that is
        // failing — so the second pass claims nothing, and the third claims
        // only because a NEW output showed up.
        const s = spies();
        const swap = receiveSwap();
        const funded = [{ ...LOCKUP_OUTPOINT, value: LOCKUP_VALUE }];
        const m = manager({
            indexer: fakeIndexer({
                vtxos: unspent(),
                get funded() {
                    return funded;
                },
            }),
            now: BEFORE_DEADLINE,
            spies: s,
        });
        await pass(m, swap);
        expect(s.lockupClaims).toHaveLength(1);

        await m.poll();
        expect(s.lockupClaims).toHaveLength(1);
        expect(swap.state).toBe("claimed");

        funded.push({ ...LOCKUP_OUTPOINT, vout: 1, value: 500 });
        await m.poll();

        expect(s.lockupClaims).toHaveLength(2);
        expect(s.lockupClaims[1].partiallyClaimed).toBe(true);
        expect(s.lockupClaims[1].vtxos).toHaveLength(2);
    });

    it("ends refunded once the solver's reclaim window has passed unobserved", async () => {
        const s = spies();
        const swap = receiveSwap();
        const m = manager({
            indexer: fakeIndexer({ vtxos: [] }),
            now: REFUND_LOCKTIME + REFUND_MTP_LAG_SECONDS,
            spies: s,
        });
        await pass(m, swap);

        expect(swap.state).toBe("refunded");
        expect(await m.hasSwap(RFQ_ID)).toBe(false);
        // resolution, not rejection — but the caller has to read the state
        await expect(m.waitForSwapCompletion(RFQ_ID)).resolves.toEqual({
            state: "refunded",
            txid: undefined,
        });
    });

    it("ends failed, with the reason, when the claim kept throwing until the window shut", async () => {
        // The one shape that is not an ordinary unwind: a claimable lockup this
        // wallet could not take. Reported as `refunded` it would read to an
        // awaiting caller as a swap that simply did not happen.
        let now = BEFORE_DEADLINE;
        const s = spies({
            claimLockup: async () => {
                throw new Error("ark server unreachable");
            },
        });
        const swap = receiveSwap();
        const m = manager({ indexer: fundedIndexer(), now: () => now, spies: s });
        await pass(m, swap);
        expect(swap.state).toBe("claimable"); // retried, not given up on
        expect(s.lockupClaims).toHaveLength(1);

        await m.poll();
        expect(s.lockupClaims).toHaveLength(2);

        now = REFUND_LOCKTIME + REFUND_MTP_LAG_SECONDS;
        await m.poll();

        expect(swap.state).toBe("failed");
        expect(swap.failure).toMatch(/ark server unreachable/);
        await expect(m.waitForSwapCompletion(RFQ_ID)).rejects.toThrow(/ark server unreachable/);
    });

    it("reports without acting when auto-actions are off", async () => {
        const s = spies();
        const swap = receiveSwap();
        const m = manager({
            indexer: fundedIndexer(),
            now: BEFORE_DEADLINE,
            spies: s,
            enableAutoActions: false,
        });
        await pass(m, swap);

        expect(s.lockupClaims).toHaveLength(0);
        expect(swap.state).toBe("claimable");
    });

    it("leaves the swap running when the lockup read fails", async () => {
        const s = spies();
        const swap = receiveSwap();
        const failures: string[] = [];
        const m = manager({ indexer: fakeIndexer({ fail: true }), now: BEFORE_DEADLINE, spies: s });
        m.onSwapFailed((_s, error) => failures.push(error.message));
        await pass(m, swap);

        expect(swap.state).toBe("pending");
        expect(failures).toEqual(["indexer unreachable"]);
        expect(await m.hasSwap(RFQ_ID)).toBe(true);
    });

    it("does not resolve a waiter on the local claim, only on the chain's answer", async () => {
        // An L1 broadcast is a chain fact the trader holds coins from; an
        // Arkade submission is a submission, and `claimed -> refunded` is
        // reachable from it.
        const s = spies();
        const swap = receiveSwap();
        const spend = spendOfLockup({ script: RECEIVE_LOCKUP, conditionWitness: [PREIMAGE] });
        const state = { vtxos: unspent(), funded: [{ ...LOCKUP_OUTPOINT, value: LOCKUP_VALUE }] };
        const indexer = fakeIndexer({
            get vtxos() {
                return state.vtxos;
            },
            get funded() {
                return state.funded;
            },
            txs: [spend],
        });
        const m = manager({ indexer, now: BEFORE_DEADLINE, spies: s });
        await pass(m, swap);
        expect(swap.state).toBe("claimed");

        let settled: unknown = null;
        const waiting = m.waitForSwapCompletion(RFQ_ID).then((outcome) => (settled = outcome));
        await Promise.resolve();
        expect(settled).toBeNull();

        state.vtxos = spentBy(spend.txid);
        await m.poll();
        await waiting;

        expect(settled).toEqual({ state: "settled", txid: CLAIM_TXID });
    });
});

/**
 * A refund nobody here can push is not a failure and not an ending: the lockup
 * is still funded, and the solver claiming it is still what resolves the swap.
 * So the state has to be reported without retrying, without `onSwapFailed`,
 * and — the item-5 interaction — without unwatching the contract.
 */
describe("RfqSwapManager — a kind whose claim was never wired", () => {
    const BEFORE_DEADLINE = REFUND_LOCKTIME - 3600;
    const fundedIndexer = () =>
        fakeIndexer({ vtxos: unspent(), funded: [{ ...LOCKUP_OUTPOINT, value: LOCKUP_VALUE }] });

    it("drives a lightning send with neither claim wired, which used not to compile", async () => {
        const s = spies();
        const swap = lightningSwap();
        const m = manager({
            now: REFUND_LOCKTIME + 60,
            spies: s,
            install: { refundArkade: s.callbacks.refundArkade, saveSwap: s.callbacks.saveSwap },
        });
        await m.addSwap(swap);
        await m.poll();

        expect(swap.state).toBe("refunded");
        expect(s.refunds).toEqual([RFQ_ID]);
    });

    it("blocks a receive swap on the missing claimLockup, naming the wiring", async () => {
        const s = spies();
        const swap = receiveSwap();
        const m = manager({
            indexer: fundedIndexer(),
            now: BEFORE_DEADLINE,
            spies: s,
            install: without(s, "claimLockup"),
        });
        await m.addSwap(swap);
        await m.poll();

        expect(swap.state).toBe("needs_counterparty");
        expect(swap.blockedReason).toMatch(/no claimLockup callback is wired/);
        expect(s.lockupClaims).toHaveLength(0);
    });

    it("blocks a claimable fill on the missing claimOnchain, and lifts once it is wired", async () => {
        // Non-terminal is the whole point: `setCallbacks` is installable late
        // by design, so a terminal state here would foreclose the wiring this
        // relaxation exists for.
        const s = spies();
        const swap = onchainSwap();
        const m = manager({
            chain: fakeChain({ utxos: [FILL], mtp: SAFE_NOW }),
            now: SAFE_NOW,
            spies: s,
            install: without(s, "claimOnchain"),
        });
        await m.addSwap(swap);
        await m.poll();

        expect(swap.state).toBe("needs_counterparty");
        expect(swap.blockedReason).toMatch(/no claimOnchain callback is wired/);
        expect(isRfqSwapTerminal(swap.state)).toBe(false);
        expect(s.claims).toHaveLength(0);

        m.setCallbacks(s.callbacks);
        await m.poll();

        expect(s.claims).toHaveLength(1);
        expect(swap.state).toBe("claimed");
        expect(swap.claimTxid).toBe("dd".repeat(32));
    });

    it("keeps reporting a claimable fill when nothing at all is wired", async () => {
        // The check targets the half-wired case only. Fully unwired is the
        // documented manual mode: report `claimable`, act by hand.
        const swap = onchainSwap();
        const m = new RfqSwapManager(
            {
                indexer: fakeIndexer({ vtxos: unspent() }),
                chain: fakeChain({ utxos: [FILL], mtp: SAFE_NOW }),
            },
            { now: () => SAFE_NOW },
        );
        await m.addSwap(swap);
        await m.poll();

        expect(swap.state).toBe("claimable");
    });
});

describe("RfqSwapManager — a refund this wallet cannot make", () => {
    const cannotSign = () =>
        new RefundNotLocallyPossibleError(
            "foreign-descriptor",
            "this wallet cannot derive tr(xpub…/0/7); the swap was created on another wallet",
        );

    it("reports it on the first pass, with a reason and no failure event", async () => {
        const s = spies({
            refund: async () => {
                throw cannotSign();
            },
        });
        const failures: string[] = [];
        const swap = lightningSwap();
        const m = manager({ now: REFUND_LOCKTIME + 1, spies: s });
        m.onSwapFailed((_swap, error) => failures.push(error.message));
        await m.addSwap(swap);
        await m.poll();

        expect(swap.state).toBe("needs_counterparty");
        expect(swap.blockedReason).toMatch(/created on another wallet/);
        // `failure` is for an action that was attempted and did not work
        expect(swap.failure).toBeUndefined();
        expect(failures).toEqual([]);
    });

    it("is not retried, and never becomes `failed`", async () => {
        // The behaviour this whole state exists for: at the default cadence the
        // retry branch would burn ~1440 passes against a push that cannot work,
        // and end on a label claiming an action failed.
        let now = REFUND_LOCKTIME + 1;
        const s = spies({
            refund: async () => {
                throw cannotSign();
            },
        });
        const swap = lightningSwap();
        const m = manager({ now: () => now, spies: s });
        await m.addSwap(swap);
        await m.poll();
        now = REFUND_LOCKTIME + REFUND_MTP_LAG_SECONDS + 1;
        await m.poll();
        await m.poll();

        expect(s.refunds).toEqual([RFQ_ID]);
        expect(swap.state).toBe("needs_counterparty");
        // and it is still monitored: the swap has not ended
        expect(await m.hasSwap(RFQ_ID)).toBe(true);
    });

    it("leaves an ordinary refusal on the retry path", async () => {
        // The narrowness of the new branch. `LockupNeedsRecoveryError` is the
        // case that must keep retrying: the caller can recover the lockup while
        // the window is open, after which the next pass simply succeeds.
        const s = spies({
            refund: async () => {
                throw new LockupNeedsRecoveryError(["aa".repeat(32) + ":0"], BigInt(0));
            },
        });
        const swap = lightningSwap();
        const m = manager({ now: REFUND_LOCKTIME + 1, spies: s });
        await m.addSwap(swap);
        await m.poll();
        await m.poll();

        expect(s.refunds).toEqual([RFQ_ID, RFQ_ID]);
        expect(swap.state).toBe("pending");
    });

    it("reports a wallet with nothing wired to act, instead of sitting `pending`", async () => {
        // The loudest gap, and the one that needs no key material to see: with
        // `enableAutoActions` off the swap would otherwise stay `pending` past
        // its window forever — monitored, never acted on, never reported.
        const s = spies();
        const swap = lightningSwap();
        const m = manager({ now: REFUND_LOCKTIME + 1, spies: s, enableAutoActions: false });
        await m.addSwap(swap);
        await m.poll();

        expect(s.refunds).toEqual([]);
        expect(swap.state).toBe("needs_counterparty");
        expect(swap.blockedReason).toMatch(/automatic actions are disabled/);
    });

    it("keeps the lockup watched", async () => {
        // The item-5 interaction from the other side: the money is still at the
        // lockup, so retiring its contract here would unwatch live funds and
        // lose the solver claim that still ends this swap.
        const s = spies({
            refund: async () => {
                throw cannotSign();
            },
        });
        const contracts = fakeContracts();
        const swap = lightningSwap({ lockup: LOCKUP_HANDLE });
        const m = manager({ contracts, now: REFUND_LOCKTIME + 1, spies: s });
        await m.addSwap(swap);
        await m.poll();

        expect(swap.state).toBe("needs_counterparty");
        expect(contracts.retired).toEqual([]);
        expect(contracts.watched()).toEqual([LOCKUP_SCRIPT_HEX]);
    });

    it("still ends `settled` when the counterparty claims the lockup", async () => {
        const s = spies({
            refund: async () => {
                throw cannotSign();
            },
        });
        const swap = lightningSwap();
        let claimed = false;
        const m = manager({
            indexer: {
                getVtxos: async () =>
                    claimed
                        ? fakeIndexer({ vtxos: spentBy(CLAIM_SPEND.txid) }).getVtxos()
                        : fakeIndexer({ vtxos: unspent() }).getVtxos(),
                getVirtualTxs: fakeIndexer({ txs: [CLAIM_SPEND] }).getVirtualTxs,
            } as unknown as LockupSpendIndexer,
            now: REFUND_LOCKTIME + 1,
            spies: s,
        });
        await m.addSwap(swap);
        await m.poll();
        expect(swap.state).toBe("needs_counterparty");

        claimed = true;
        await m.poll();

        expect(swap.state).toBe("settled");
        // and the refusal's reason goes with it: a settled swap carrying one
        // reads as still blocked
        expect(swap.blockedReason).toBeUndefined();
        expect(await m.hasSwap(RFQ_ID)).toBe(false);
    });

    it("says so before the window opens, when a probe is wired", async () => {
        // Reportable while the solver can still act, rather than at the
        // deadline — which is the whole reason the probe exists.
        const s = spies({
            probe: async () => ({ ok: false, reason: "the signing wallet is not this one" }),
        });
        const swap = lightningSwap();
        const m = manager({ now: REFUND_LOCKTIME - 3600, spies: s });
        await m.addSwap(swap);
        await m.poll();

        expect(swap.state).toBe("needs_counterparty");
        expect(swap.blockedReason).toBe("the signing wallet is not this one");
        expect(s.refunds).toEqual([]);
    });

    it("keeps a claimed L1 fill across the refusal, and claims it only once", async () => {
        // The two halves have different keys: being unable to take the Arkade
        // lockup back says nothing about the fill the trader already has. The
        // label defers while blocked — `claimed` is re-read from chain every
        // pass and would otherwise flip — but `claimTxid` is what carries the
        // fact, and it is what stops a second broadcast of P.
        let ok = false;
        let now = SAFE_NOW;
        const s = spies({
            probe: async () => (ok ? { ok: true } : { ok: false, reason: "not this wallet" }),
        });
        const swap = onchainSwap();
        const states: RfqSwapState[] = [];
        const m = manager({
            chain: fakeChain({ utxos: [FILL], mtp: SAFE_NOW }),
            now: () => now,
            spies: s,
        });
        m.onSwapUpdate((updated) => states.push(updated.state));
        await m.addSwap(swap);
        await m.poll();
        // pre-window, the live claim keeps the label
        expect(swap.state).toBe("claimed");

        now = REFUND_LOCKTIME + 1;
        await m.poll();
        await m.poll();
        expect(swap.state).toBe("needs_counterparty");

        ok = true;
        await m.poll();

        // back to `claimed`, not `pending` — and the resumed push then refunds
        expect(states).toEqual([
            "claimable",
            "claimed",
            "needs_counterparty",
            "claimed",
            "refunded",
        ]);
        expect(swap.claimTxid).toBe("dd".repeat(32));
        expect(s.claims).toHaveLength(1);
        expect(swap.blockedReason).toBeUndefined();
    });

    it("re-attempts a push-reported refusal only when the probe retracts it", async () => {
        // Without a probe the push is not re-issued; with one, its `ok` is the
        // single thing that clears the refusal and lets the push run again.
        let ok = false;
        const s = spies({
            probe: async () => (ok ? { ok: true } : { ok: false, reason: "not this wallet" }),
            refund: async () => {
                if (!ok) throw cannotSign();
                return { txid: "ee".repeat(32), amount: 100_000 };
            },
        });
        const swap = lightningSwap();
        const m = manager({ now: REFUND_LOCKTIME + 1, spies: s });
        await m.addSwap(swap);
        // a refusing probe reports before the push is ever tried
        await m.poll();
        expect(s.refunds).toEqual([]);
        expect(swap.state).toBe("needs_counterparty");

        ok = true;
        await m.poll();

        expect(s.refunds).toEqual([RFQ_ID]);
        expect(swap.state).toBe("refunded");
    });

    it("goes back to `pending` and refunds once the probe says yes", async () => {
        // Not a dead end: restoring the wallet that can sign resumes the normal
        // drive, which is why the probe re-runs on every pass.
        let ok = false;
        const s = spies({
            probe: async () =>
                ok ? { ok: true } : { ok: false, reason: "the signing wallet is not this one" },
        });
        const swap = lightningSwap();
        const states: RfqSwapState[] = [];
        const m = manager({ now: REFUND_LOCKTIME + 1, spies: s });
        m.onSwapUpdate((updated) => states.push(updated.state));
        await m.addSwap(swap);
        await m.poll();
        expect(swap.state).toBe("needs_counterparty");

        ok = true;
        await m.poll();

        expect(states).toEqual(["needs_counterparty", "pending", "refunded"]);
        expect(swap.blockedReason).toBeUndefined();
        expect(s.refunds).toEqual([RFQ_ID]);
    });
});

describe("RfqSwapManager — bookkeeping", () => {
    const settledIndexer = () =>
        fakeIndexer({ vtxos: spentBy(CLAIM_SPEND.txid), txs: [CLAIM_SPEND] });

    it("persists every state change through saveSwap", async () => {
        const s = spies();
        const swap = lightningSwap();
        const m = manager({ indexer: settledIndexer(), now: SAFE_NOW, spies: s });
        await m.addSwap(swap);
        await m.poll();
        expect(s.saved).toEqual(["settled"]);
    });

    it("runs one action at a time per swap", async () => {
        let inFlight = 0;
        let overlapped = false;
        const s = spies({
            refund: async () => {
                inFlight += 1;
                overlapped ||= inFlight > 1;
                await Promise.resolve();
                inFlight -= 1;
                return { txid: "ee".repeat(32), amount: 1 };
            },
        });
        const swap = lightningSwap();
        const m = manager({ now: REFUND_LOCKTIME + 1, spies: s });
        m["monitored"].set(swap.rfqId, swap);

        await Promise.all([m.poll(), m.poll(), m.poll()]);
        expect(overlapped).toBe(false);
        expect(s.refunds).toHaveLength(1);
    });

    it("observes without acting when auto actions are off", async () => {
        const s = spies();
        const swap = onchainSwap();
        const m = manager({
            chain: fakeChain({ utxos: [FILL], mtp: SAFE_NOW }),
            now: SAFE_NOW,
            spies: s,
            enableAutoActions: false,
        });
        await m.addSwap(swap);
        await m.poll();

        expect(s.claims).toHaveLength(0);
        // but the caller is told the window is open, so it can act by hand
        expect(swap.state).toBe("claimable");
    });

    it("reports completion once, then drops the swap", async () => {
        const completed: RfqSwap[] = [];
        const s = spies();
        const m = new RfqSwapManager(
            { indexer: settledIndexer() },
            { now: () => SAFE_NOW, events: { onSwapCompleted: (swap) => completed.push(swap) } },
        );
        m.setCallbacks(s.callbacks);
        const swap = lightningSwap();
        await m.addSwap(swap);
        await m.poll();
        await m.poll();

        expect(completed).toHaveLength(1);
        expect(isRfqSwapTerminal(completed[0].state)).toBe(true);
        expect(await m.getPendingSwaps()).toHaveLength(0);
    });

    it("resolves waitForSwapCompletion when the trader's payout is decided", async () => {
        // For an onchain send that is the L1 claim, not the end of the record's
        // life — the manager goes on watching the lockup afterwards.
        const s = spies();
        const swap = onchainSwap();
        const m = manager({
            chain: fakeChain({ utxos: [FILL], mtp: SAFE_NOW }),
            now: SAFE_NOW,
            spies: s,
        });
        m["monitored"].set(swap.rfqId, swap);
        const waiting = m.waitForSwapCompletion(RFQ_ID);
        await m.poll();

        await expect(waiting).resolves.toEqual({ state: "claimed", txid: "dd".repeat(32) });
        expect(await m.hasSwap(RFQ_ID)).toBe(true); // still watching the lockup
    });

    it("resolves for a claimed onchain send the refund refusal has since relabelled", async () => {
        // The shape a restart loads when the Arkade half was refused after the
        // window: the L1 payout is done and the txid proves it, so the caller
        // must not hang waiting for a label that will never come back.
        const swap = onchainSwap({ state: "needs_counterparty", claimTxid: "dd".repeat(32) });
        const m = manager({ now: REFUND_LOCKTIME + 1, spies: spies() });
        await m.addSwap(swap);

        await expect(m.waitForSwapCompletion(RFQ_ID)).resolves.toEqual({
            state: "needs_counterparty",
            txid: "dd".repeat(32),
        });
    });

    it("settles a waiter only once the record has been persisted", async () => {
        // A caller that awaits completion and then reads its own storage must
        // not find the record still saying `pending`.
        const order: string[] = [];
        const s = spies();
        s.callbacks.saveSwap = async (swap) => {
            // A real repository write yields before it lands; settling a waiter
            // from the state change instead would slip in ahead of it.
            await Promise.resolve();
            order.push(`saved:${swap.state}`);
        };
        const swap = lightningSwap();
        const m = manager({ indexer: settledIndexer(), now: SAFE_NOW, spies: s });
        m["monitored"].set(swap.rfqId, swap);
        const waiting = m.waitForSwapCompletion(RFQ_ID).then(() => order.push("resolved"));
        await m.poll();
        await waiting;

        expect(order).toEqual(["saved:settled", "resolved"]);
    });

    it("does not settle a waiter or finalize when the record failed to persist", async () => {
        // The failure mirror of the test above. Reporting completion off a
        // write that threw tells the caller a swap is done that its own
        // storage never recorded — and on restart the manager re-drives the
        // stale record and replays action callbacks against it.
        const s = spies();
        s.callbacks.saveSwap = async () => {
            throw new Error("repository unavailable");
        };
        const swap = lightningSwap();
        const m = manager({ indexer: settledIndexer(), now: SAFE_NOW, spies: s });
        m["monitored"].set(swap.rfqId, swap);

        let settled = false;
        void m.waitForSwapCompletion(RFQ_ID).then(
            () => (settled = true),
            () => (settled = true),
        );
        await m.poll();
        await Promise.resolve();

        expect(settled).toBe(false);
        // Still monitored and still dirty, so the next pass retries the write
        // rather than the record being silently lost.
        expect(await m.hasSwap(RFQ_ID)).toBe(true);
        expect(m["dirty"].has(RFQ_ID)).toBe(true);
    });

    it("holds the per-swap lock across the save, so a direct poll cannot re-enter", async () => {
        // `arm()` serialises the timer path, but an explicit `poll()` — an
        // app-resume handler, say — is not. Releasing the lock before `save`
        // yields let a second pass through the in-progress guard and fire the
        // action callbacks again for the same swap.
        const s = spies();
        let releaseSave: (() => void) | undefined;
        let saveCalls = 0;
        s.callbacks.saveSwap = async () => {
            saveCalls += 1;
            await new Promise<void>((resolve) => {
                releaseSave = resolve;
            });
        };
        const swap = lightningSwap();
        const m = manager({ indexer: settledIndexer(), now: SAFE_NOW, spies: s });
        m["monitored"].set(swap.rfqId, swap);

        const first = m.poll();
        await vi.waitFor(() => expect(saveCalls).toBe(1));
        expect(await m.isProcessing(RFQ_ID)).toBe(true);
        await m.poll(); // re-entry attempt: must be a no-op while the save is in flight
        expect(saveCalls).toBe(1);

        releaseSave?.();
        await first;
    });

    it("rejects pending waiters when a swap is removed, rather than hanging them", async () => {
        const swap = lightningSwap();
        const m = manager({ now: SAFE_NOW, spies: spies() });
        m["monitored"].set(swap.rfqId, swap);
        const waiting = m.waitForSwapCompletion(RFQ_ID);
        await m.removeSwap(RFQ_ID);
        await expect(waiting).rejects.toThrow(/removed from monitoring/);
    });

    it("resolves a refund rather than rejecting it", async () => {
        const s = spies();
        const swap = lightningSwap();
        const m = manager({ now: REFUND_LOCKTIME + 1, spies: s });
        m["monitored"].set(swap.rfqId, swap);
        const waiting = m.waitForSwapCompletion(RFQ_ID);
        await m.poll();

        await expect(waiting).resolves.toEqual({ state: "refunded", txid: "ee".repeat(32) });
    });

    it("rejects waitForSwapCompletion only on a real failure", async () => {
        const s = spies({
            refund: async () => {
                throw new Error("FORFEIT_CLOSURE_LOCKED");
            },
        });
        const swap = lightningSwap();
        const m = manager({
            now: REFUND_LOCKTIME + REFUND_MTP_LAG_SECONDS,
            spies: s,
        });
        m["monitored"].set(swap.rfqId, swap);
        const waiting = m.waitForSwapCompletion(RFQ_ID);
        await m.poll();

        await expect(waiting).rejects.toThrow(/FORFEIT_CLOSURE_LOCKED/);
        // and a late asker still gets an answer instead of "not monitored"
        await expect(m.waitForSwapCompletion(RFQ_ID)).rejects.toThrow(/FORFEIT_CLOSURE_LOCKED/);
    });

    it("does not let a throwing listener derail the pass", async () => {
        const s = spies();
        const m = new RfqSwapManager(
            { indexer: settledIndexer() },
            {
                now: () => SAFE_NOW,
                events: {
                    onSwapUpdate: () => {
                        throw new Error("consumer blew up");
                    },
                },
            },
        );
        m.setCallbacks(s.callbacks);
        const swap = lightningSwap();
        await m.addSwap(swap);
        await m.poll();

        expect(swap.state).toBe("settled");
        expect(s.saved).toEqual(["settled"]);
    });

    it("polls on the configured interval once started, and stops on stop()", async () => {
        vi.useFakeTimers();
        try {
            const s = spies();
            const indexer = fakeIndexer({ vtxos: unspent() });
            const m = manager({ indexer, now: SAFE_NOW, spies: s });
            await m.start([lightningSwap()]);
            expect(indexer.vtxoCalls).toBe(1); // start polls immediately

            await vi.advanceTimersByTimeAsync(5_000);
            expect(indexer.vtxoCalls).toBe(2);

            await m.stop();
            await vi.advanceTimersByTimeAsync(20_000);
            expect(indexer.vtxoCalls).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });
});

/**
 * The lockup as a registered contract, and the indexer's push as a latency
 * optimization on top of a poll that still decides everything.
 *
 * The property under test throughout is the one from the module doc: an event
 * may only change WHEN a pass runs, never what that pass concludes. So the
 * tests that matter are the negative ones — a spend event over a lockup the
 * indexer still reports as open must leave the swap exactly where it was, and
 * an event naming a script this manager does not watch must do nothing at all.
 */
describe("RfqSwapManager — the lockup as a contract", () => {
    const swapWithLockup = (over: Partial<LightningSendSwap> = {}): LightningSendSwap =>
        lightningSwap({ lockup: LOCKUP_HANDLE, ...over });

    describe("registration", () => {
        it("registers the lockup under vhtlc-v2, at the script that was funded", async () => {
            const s = spies();
            const contracts = fakeContracts();
            const m = manager({ contracts, now: SAFE_NOW, spies: s });
            await m.addSwap(swapWithLockup());
            await m.poll();

            expect(contracts.created).toHaveLength(1);
            const row = contracts.created[0];
            expect(row.type).toBe(SWAP_LOCKUP_CONTRACT_TYPE);
            expect(row.script).toBe(LOCKUP_SCRIPT_HEX);
            expect(row.address).toBe("ark1lockup");
            expect(row.metadata).toMatchObject({ genericallySpendable: false });
            // The params must be the ones the SDK's own handler derives the
            // funded script back out of — a row that round-trips to anything
            // else is refused by `upsertContractRow`, so pin it here rather
            // than discover it against a live wallet.
            expect(hex.encode(VHTLCV2ContractHandler.createScript(row.params).pkScript)).toBe(
                LOCKUP_SCRIPT_HEX,
            );
        });

        it("registers once, however many passes run", async () => {
            const s = spies();
            const contracts = fakeContracts();
            const m = manager({ contracts, now: SAFE_NOW, spies: s });
            await m.addSwap(swapWithLockup());
            await m.poll();
            await m.poll();
            await m.poll();

            expect(contracts.created).toHaveLength(1);
        });

        it("refuses to register a covenant that is not the funded script", async () => {
            // The record disagrees with itself: its `lockupPkScript` names one
            // script and its covenant derives another. Rows are keyed by
            // script, so registering the covenant's would leave the FUNDED
            // lockup unwatched while reporting success.
            const s = spies();
            const contracts = fakeContracts();
            const failures: string[] = [];
            const m = manager({ contracts, now: SAFE_NOW, spies: s });
            m.onSwapFailed((_swap, error) => failures.push(error.message));

            await m.addSwap(swapWithLockup({ lockupPkScript: new Uint8Array(34).fill(9) }));
            await m.poll();

            expect(contracts.created).toEqual([]);
            expect(failures.some((f) => /does not match its lockupPkScript/.test(f))).toBe(true);
        });

        it("still drives the swap when registration fails, and retries it next pass", async () => {
            // Registration buys latency; it decides nothing. The refund below
            // it is gated on a timelock a missing contract row cannot move, so
            // failing the pass over bookkeeping would trade a real deadline for
            // an imaginary one.
            const s = spies();
            let broken = true;
            const contracts = fakeContracts({ failCreate: () => broken });
            const m = manager({
                contracts,
                now: REFUND_LOCKTIME,
                spies: s,
            });
            await m.addSwap(swapWithLockup());
            await m.poll();

            expect(contracts.created).toEqual([]);
            expect(s.refunds).toEqual([RFQ_ID]); // the money path ran anyway

            broken = false;
            const again = manager({ contracts, now: SAFE_NOW, spies: s });
            await again.addSwap(swapWithLockup());
            await again.poll();
            expect(contracts.created).toHaveLength(1);
        });

        it("says so once — not every pass — when there is no covenant to register", async () => {
            const s = spies();
            const contracts = fakeContracts();
            const failures: string[] = [];
            const m = manager({ contracts, now: SAFE_NOW, spies: s });
            m.onSwapFailed((_swap, error) => failures.push(error.message));

            await m.addSwap(lightningSwap()); // no `lockup`
            await m.poll();
            await m.poll();

            expect(failures.filter((f) => /carries no lockup script/.test(f))).toHaveLength(1);
            expect(contracts.created).toEqual([]);
        });

        it("counts a row the request path already wrote, instead of reporting it missing", async () => {
            // `requestLightningSend` registers before the caller can fund, and
            // returns no covenant object a polling caller has to carry — so a
            // record without `lockup` is the normal case, not a broken one.
            // Complaining here would report a problem that was already solved,
            // and would leave the row un-retired for good.
            const s = spies();
            const contracts = fakeContracts({
                preexisting: [{ script: LOCKUP_SCRIPT_HEX } as CreateContractParams],
            });
            const failures: string[] = [];
            const m = manager({
                indexer: fakeIndexer({ vtxos: spentBy(CLAIM_SPEND.txid), txs: [CLAIM_SPEND] }),
                contracts,
                now: SAFE_NOW,
                spies: s,
            });
            m.onSwapFailed((_swap, error) => failures.push(error.message));

            const swap = lightningSwap(); // no `lockup`
            await m.addSwap(swap);
            await m.poll();
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(failures).toEqual([]);
            expect(swap.state).toBe("settled");
            expect(contracts.retired).toEqual([{ script: LOCKUP_SCRIPT_HEX, watch: "retained" }]);
        });

        it("decides nothing about a covenant it could not look up", async () => {
            // An unreadable store means the row's existence is UNKNOWN. Calling
            // it absent would be a guess, and a permanent one — the answer is
            // settled once and never revisited.
            const s = spies();
            let broken = true;
            const contracts = fakeContracts({
                failRead: () => broken,
                preexisting: [{ script: LOCKUP_SCRIPT_HEX } as CreateContractParams],
            });
            const failures: string[] = [];
            const m = manager({ contracts, now: SAFE_NOW, spies: s });
            m.onSwapFailed((_swap, error) => failures.push(error.message));

            await m.addSwap(lightningSwap()); // no `lockup`
            await m.poll();
            expect(failures.some((f) => /carries no lockup script/.test(f))).toBe(false);

            broken = false;
            await m.poll();
            expect(failures.filter((f) => /carries no lockup script/.test(f))).toEqual([]);
        });

        it("needs no contract manager at all", async () => {
            const s = spies();
            const m = manager({
                indexer: fakeIndexer({ vtxos: spentBy(CLAIM_SPEND.txid), txs: [CLAIM_SPEND] }),
                now: SAFE_NOW,
                spies: s,
            });
            const swap = swapWithLockup();
            await m.addSwap(swap);
            await m.poll();

            expect(swap.state).toBe("settled");
        });
    });

    describe("the subscription", () => {
        it("runs a pass for the named swap the moment an event arrives", async () => {
            const s = spies();
            const contracts = fakeContracts();
            const indexer = fakeIndexer({
                vtxos: spentBy(CLAIM_SPEND.txid),
                txs: [CLAIM_SPEND],
            });
            const m = manager({ indexer, contracts, now: SAFE_NOW, spies: s });
            // `start` subscribes; its immediate pass would settle the swap on
            // its own, so the swap is added AFTER, with the timer far away.
            await m.start([]);
            const swap = swapWithLockup();
            m.onSwapUpdate(() => {});

            const before = indexer.vtxoCalls;
            await m.addSwap(swap);
            expect(swap.state).toBe("settled");
            expect(indexer.vtxoCalls).toBeGreaterThan(before);
            await m.stop();
        });

        it("re-reads the chain rather than believing the event", async () => {
            // THE property. The lockup still reads OPEN, and a `vtxo_spent`
            // says otherwise. The event must not be able to end the swap: it
            // only causes a pass, and that pass asks the indexer, which says
            // the money is still there.
            const s = spies();
            const contracts = fakeContracts();
            const indexer = fakeIndexer({ vtxos: unspent() });
            const m = manager({ indexer, contracts, now: SAFE_NOW, spies: s });
            const swap = swapWithLockup();
            await m.start([swap]);

            const before = indexer.vtxoCalls;
            contracts.emit(lockupEvent("vtxo_spent"));
            await Promise.resolve();
            await Promise.resolve();
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(indexer.vtxoCalls).toBeGreaterThan(before); // it looked
            expect(swap.state).toBe("pending"); // and believed what it saw
            expect(s.refunds).toEqual([]);
            await m.stop();
        });

        it("ignores an event for a script it does not watch", async () => {
            const s = spies();
            const contracts = fakeContracts();
            const indexer = fakeIndexer({ vtxos: unspent() });
            const m = manager({ indexer, contracts, now: SAFE_NOW, spies: s });
            await m.start([swapWithLockup()]);

            const before = indexer.vtxoCalls;
            contracts.emit(lockupEvent("vtxo_spent", "ff".repeat(34)));
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(indexer.vtxoCalls).toBe(before);
            await m.stop();
        });

        it("re-polls everything after the stream resets", async () => {
            // A dropped stream may have swallowed events while it was down, so
            // the whole set is re-read rather than trusted.
            const s = spies();
            const contracts = fakeContracts();
            const indexer = fakeIndexer({ vtxos: unspent() });
            const m = manager({ indexer, contracts, now: SAFE_NOW, spies: s });
            await m.start([swapWithLockup()]);

            const before = indexer.vtxoCalls;
            contracts.emit({ type: "connection_reset", timestamp: 1 });
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(indexer.vtxoCalls).toBeGreaterThan(before);
            await m.stop();
        });

        it("drops the subscription on stop() and takes it back on start()", async () => {
            const s = spies();
            const contracts = fakeContracts();
            const m = manager({ contracts, now: SAFE_NOW, spies: s });
            expect(contracts.listenerCount()).toBe(0);

            await m.start([swapWithLockup()]);
            expect(contracts.listenerCount()).toBe(1);

            await m.stop();
            expect(contracts.listenerCount()).toBe(0);

            await m.start([]);
            expect(contracts.listenerCount()).toBe(1);
            await m.stop();
        });
    });

    it("stops watching the contract once the swap is over, and never deletes it", async () => {
        const s = spies();
        const contracts = fakeContracts();
        const m = manager({
            indexer: fakeIndexer({ vtxos: spentBy(CLAIM_SPEND.txid), txs: [CLAIM_SPEND] }),
            contracts,
            now: SAFE_NOW,
            spies: s,
        });
        const swap = swapWithLockup();
        await m.addSwap(swap);
        await m.poll();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(swap.state).toBe("settled");
        expect(contracts.retired).toEqual([{ script: LOCKUP_SCRIPT_HEX, watch: "retained" }]);
        // The row survives — it is what keeps the lockup's VTXOs annotatable —
        // but it is out of every background channel.
        expect(contracts.created.map((row) => row.script)).toEqual([LOCKUP_SCRIPT_HEX]);
        expect(contracts.watched()).toEqual([]);
    });

    it("does not try to retire a row it never managed to write", async () => {
        // A swap whose registration was REFUSED — here because its covenant
        // disagreed with its funded script — still reaches a terminal state.
        // Retiring a script with no row throws "not found", which would surface
        // as a second, misleading FAILURE on a swap that in fact settled. The
        // registration refusal is worth reporting; a phantom one is not.
        const s = spies();
        const contracts = fakeContracts();
        const failures: string[] = [];
        const m = manager({
            indexer: fakeIndexer({ vtxos: spentBy(CLAIM_SPEND.txid), txs: [CLAIM_SPEND] }),
            contracts,
            now: SAFE_NOW,
            spies: s,
        });
        m.onSwapFailed((_swap, error) => failures.push(error.message));

        const swap = swapWithLockup({ lockupPkScript: new Uint8Array(34).fill(9) });
        await m.addSwap(swap);
        await m.poll();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(swap.state).toBe("settled");
        expect(contracts.retired).toEqual([]);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatch(/does not match its lockupPkScript/);
    });

    it("leaves the contract alone when a swap is merely removed", async () => {
        // Removal says this manager stops driving the swap, not that the
        // lockup is done — the row may still be watching real money.
        const s = spies();
        const contracts = fakeContracts();
        const m = manager({ contracts, now: SAFE_NOW, spies: s });
        await m.addSwap(swapWithLockup());
        await m.poll();
        await m.removeSwap(RFQ_ID);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(contracts.created).toHaveLength(1);
        expect(contracts.retired).toEqual([]);
        expect(contracts.watched()).toEqual([LOCKUP_SCRIPT_HEX]);
    });

    it("hands a needs-recovery refusal to the caller intact, and keeps retrying", async () => {
        // A swept lockup cannot be refunded by any offchain spend until it is
        // recovered into a fresh batch. The manager cannot recover it — but the
        // caller can, while the window is still open — so it keeps retrying AND
        // reports which failure this is, unflattened, so the caller can act.
        const swept = [{ txid: "55".repeat(32), vout: 3, value: 8_000, recoverable: true }];
        const s = spies({
            refund: () => Promise.reject(new LockupNeedsRecoveryError(["55".repeat(32) + ":3"])),
        });
        const seen: unknown[] = [];
        const m = manager({ now: REFUND_LOCKTIME, spies: s });
        m.onSwapFailed((_swap, error) => seen.push(error));

        const swap = swapWithLockup();
        await m.addSwap(swap);
        await m.poll();
        await m.poll();

        expect(seen).toHaveLength(2); // retried, not given up on
        expect(seen[0]).toBeInstanceOf(LockupNeedsRecoveryError);
        expect((seen[0] as LockupNeedsRecoveryError).outpoints).toEqual([swept[0].txid + ":3"]);
        expect(swap.state).toBe("pending"); // still inside the MTP window
    });

    it("stops reacting to events for a removed swap", async () => {
        const s = spies();
        const contracts = fakeContracts();
        const indexer = fakeIndexer({ vtxos: unspent() });
        const m = manager({ indexer, contracts, now: SAFE_NOW, spies: s });
        await m.start([swapWithLockup()]);
        await m.removeSwap(RFQ_ID);

        const before = indexer.vtxoCalls;
        contracts.emit(lockupEvent("vtxo_spent"));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(indexer.vtxoCalls).toBe(before);
        await m.stop();
    });
});

/**
 * The manager as the owner of its own persistence.
 *
 * What a consumer used to write by hand — the restore loop, the retention
 * pass, and a `saveSwap` that could not compose the FIRST write of a swap at
 * all, because `createRfqSwapRecord` wants request-time facts the live record
 * does not carry and `updateRfqSwapRecord` wants a record that does not exist
 * yet. That origin trap is what these tests are mostly about: where the origin
 * comes from, what happens when it cannot, and that the write it produces is
 * the one waiters and finalization are gated on.
 *
 * The other half is the sink matrix. A repository and a `saveSwap` are
 * independent options, so there are four configurations and each has a rule:
 * both gate, either alone gates, and neither means process-local. Wiring the
 * repository does NOT weaken `saveSwap` — a rejection from it still holds the
 * pass back, exactly as it does today.
 */
describe("RfqSwapManager — manager-owned persistence", () => {
    const LOCKUP_ADDRESS = LOCKUP.address("tark", key(3)).encode();
    const RECEIVE_ADDRESS = RECEIVE_LOCKUP.address("tark", key(3)).encode();

    const sendOrigin = (over: Partial<RfqSwapOrigin> = {}): RfqSwapOrigin => ({
        kind: "lightning_send",
        lockupAddress: LOCKUP_ADDRESS,
        profile: {
            signer: { signingDescriptor: `tr(${hex.encode(key(13))})` },
            hashlock: { paymentHash: PAYMENT_HASH },
        },
        amount: LOCKUP_VALUE,
        fundingTxid: "fa".repeat(32),
        ...over,
    });

    const receiveOrigin = (): RfqSwapOrigin => ({
        kind: "lightning_receive",
        lockupAddress: RECEIVE_ADDRESS,
        profile: {
            signer: { signingDescriptor: `tr(${hex.encode(key(13))})` },
            hashlock: { paymentHash: PAYMENT_HASH },
            expectedAmount: LOCKUP_VALUE,
            payoutAddress: "tark1payout",
        },
    });

    /**
     * A record store that can be made to fail. Typed against the production
     * seam, so a change to `RfqSwapRecordStore` breaks this at compile time,
     * and it counts writes — several tests turn on a write NOT having happened.
     */
    type FakeStore = RfqSwapRecordStore & {
        records: Map<string, RfqSwapRecord>;
        writes: RfqSwapRecord[];
        removed: string[];
        failWrite?: boolean;
        failRead?: boolean;
    };

    const fakeStore = (seed: RfqSwapRecord[] = []): FakeStore => {
        const store: FakeStore = {
            records: new Map(seed.map((record) => [record.rfqId, record])),
            writes: [],
            removed: [],
            async saveRfqSwap(record) {
                if (store.failWrite) throw new Error("record store unavailable");
                store.writes.push(record);
                store.records.set(record.rfqId, record);
            },
            async getRfqSwap(rfqId) {
                if (store.failRead) throw new Error("record store unavailable");
                return store.records.get(rfqId);
            },
            async getAllRfqSwaps() {
                if (store.failRead) throw new Error("record store unavailable");
                return [...store.records.values()];
            },
            async removeRfqSwap(rfqId) {
                store.removed.push(rfqId);
                store.records.delete(rfqId);
            },
        };
        return store;
    };

    /** The contract row registration writes before an address can be funded —
     * which is where `restoreFromRepository` gets each covenant back from. */
    const rowFor = (script: typeof LOCKUP, address: string): CreateContractParams => ({
        type: SWAP_LOCKUP_CONTRACT_TYPE,
        params: VHTLCV2ContractHandler.serializeParams(script.options),
        script: hex.encode(script.pkScript),
        address,
    });

    const storedSend = (over: Partial<RfqSwapRecord> = {}): RfqSwapRecord => ({
        ...createRfqSwapRecord(sendOrigin(), lightningSwap()),
        ...over,
    });

    /** An indexer that ends the swap `settled`, so a pass has something to
     * write. Most tests here are about the WRITE, and a swap that stays
     * `pending` past its first record makes none. */
    const settlingIndexer = () =>
        fakeIndexer({ vtxos: spentBy(CLAIM_SPEND.txid), txs: [CLAIM_SPEND] });

    describe("where the first record's origin comes from", () => {
        it("writes a swap's first record from the origin handed to addSwap", async () => {
            const store = fakeStore();
            const s = spies();
            const m = manager({ repository: store, now: SAFE_NOW, spies: s });

            await m.addSwap(lightningSwap(), sendOrigin());
            await m.poll();

            const record = store.records.get(RFQ_ID);
            expect(record?.kind).toBe("lightning_send");
            expect(record?.state).toBe("pending");
            // The origin half is what no live swap carries and no later pass
            // can reconstruct — the whole reason the parameter exists.
            expect(record?.lockupAddress).toBe(LOCKUP_ADDRESS);
            expect(record?.fundingTxid).toBe("fa".repeat(32));
            expect(record?.amount).toBe(LOCKUP_VALUE);
        });

        it("resolves the origin from the store for a swap it already holds", async () => {
            // The restart case: the consumer rebuilt the swap itself and hands
            // it over with no origin, because the store is already the origin.
            const store = fakeStore([storedSend()]);
            const s = spies();
            const m = manager({
                indexer: settlingIndexer(),
                repository: store,
                now: SAFE_NOW,
                spies: s,
            });

            await m.addSwap(lightningSwap({ state: "pending" }));
            await m.poll();

            expect(store.writes.at(-1)?.state).toBe("settled");
            expect(store.writes.at(-1)?.lockupAddress).toBe(LOCKUP_ADDRESS);
            expect(store.writes.at(-1)?.fundingTxid).toBe("fa".repeat(32));
        });

        it("refuses a swap the store has never seen and that carries no origin", async () => {
            // At the DOOR, not at the first write: by then the funding is
            // broadcast and the record would exist only in memory.
            const store = fakeStore();
            const s = spies();
            const m = manager({ repository: store, now: SAFE_NOW, spies: s });

            await expect(m.addSwap(lightningSwap())).rejects.toBeInstanceOf(RfqSwapOriginRequired);
            expect(await m.hasSwap(RFQ_ID)).toBe(false);
            expect(store.writes).toHaveLength(0);
        });

        it("refuses an origin belonging to a different corridor, at the same door", async () => {
            // Left to the first write this surfaces a pass later, with the swap
            // monitored and the funding broadcast — and then keeps surfacing,
            // since the write path retries a dirty record every poll and the
            // mismatch throws deterministically. A receive origin projected off
            // a send swap also writes `expectedAmount: undefined` over the
            // caller's own value, so the record would be wrong, not just late.
            const store = fakeStore();
            const s = spies();
            const m = manager({ repository: store, now: SAFE_NOW, spies: s });

            await expect(m.addSwap(lightningSwap(), receiveOrigin())).rejects.toThrow(
                /lightning_receive origin paired with a lightning_send swap/,
            );
            expect(await m.hasSwap(RFQ_ID)).toBe(false);
            expect(store.writes).toHaveLength(0);
        });

        it("refuses an origin naming a lockup this swap does not watch", async () => {
            // The quieter half of the same check: the record stores no
            // `lockupPkScript`, so a restore would derive one from this address
            // and watch a covenant the swap never had.
            const store = fakeStore();
            const s = spies();
            const m = manager({ repository: store, now: SAFE_NOW, spies: s });

            await expect(
                m.addSwap(lightningSwap(), sendOrigin({ lockupAddress: RECEIVE_ADDRESS })),
            ).rejects.toThrow(/not the same swap/);
            expect(await m.hasSwap(RFQ_ID)).toBe(false);
            expect(store.writes).toHaveLength(0);
        });

        it("applies the same rule to start(), and tracks nothing when it fails", async () => {
            const store = fakeStore();
            const s = spies();
            const m = manager({ repository: store, now: SAFE_NOW, spies: s });

            await expect(
                m.start([lightningSwap(), lightningSwap({ rfqId: "b2".repeat(32) })]),
            ).rejects.toBeInstanceOf(RfqSwapOriginRequired);
            expect(await m.getPendingSwaps()).toHaveLength(0);
            await m.stop();
        });

        it("leaves the parameter inert with no repository wired", async () => {
            const s = spies();
            const m = manager({ now: SAFE_NOW, spies: s });

            await m.addSwap(lightningSwap());

            expect(await m.hasSwap(RFQ_ID)).toBe(true);
        });
    });

    describe("the write, and what it gates", () => {
        it("persists the new state on any pass that changed one", async () => {
            const store = fakeStore();
            const s = spies();
            const m = manager({
                indexer: settlingIndexer(),
                repository: store,
                now: SAFE_NOW,
                spies: s,
            });

            await m.addSwap(lightningSwap(), sendOrigin());
            await m.poll();

            expect(store.records.get(RFQ_ID)?.state).toBe("settled");
        });

        it("holds waiters and finalization back when the canonical write fails", async () => {
            const store = fakeStore();
            store.failWrite = true;
            const failures: string[] = [];
            const s = spies();
            const m = manager({
                indexer: settlingIndexer(),
                repository: store,
                now: SAFE_NOW,
                spies: s,
            });
            m.onSwapFailed((_swap, error) => failures.push(error.message));
            const completed: string[] = [];
            m.onSwapCompleted((swap) => completed.push(swap.rfqId));

            await m.addSwap(lightningSwap(), sendOrigin());
            await m.poll();

            expect(failures.some((message) => message.includes("record store"))).toBe(true);
            expect(completed).toHaveLength(0);
            // Still monitored, so the next pass retries the write.
            expect(await m.hasSwap(RFQ_ID)).toBe(true);
            // And the secondary sink never saw a state the record of record
            // refused: projecting it would put `saveSwap` ahead of the store.
            expect(s.saved).toHaveLength(0);

            store.failWrite = false;
            await m.poll();

            expect(store.records.get(RFQ_ID)?.state).toBe("settled");
            expect(completed).toEqual([RFQ_ID]);
            expect(s.saved).toContain("settled");
        });

        it("still lets a rejected saveSwap hold the pass back, repository or not", async () => {
            // The regression guard for the one thing this item could plausibly
            // have weakened. `saveSwap` is a second sink now, not a demoted
            // one: both writes gate.
            const store = fakeStore();
            const s = spies();
            s.callbacks.saveSwap = async () => {
                throw new Error("secondary sink unavailable");
            };
            const completed: string[] = [];
            const m = manager({
                indexer: settlingIndexer(),
                repository: store,
                now: SAFE_NOW,
                spies: s,
            });
            m.onSwapCompleted((swap) => completed.push(swap.rfqId));

            await m.addSwap(lightningSwap(), sendOrigin());
            await m.poll();

            // The canonical write DID land — it runs first and succeeded.
            expect(store.records.get(RFQ_ID)?.state).toBe("settled");
            expect(completed).toHaveLength(0);
            expect(await m.hasSwap(RFQ_ID)).toBe(true);
        });

        it("keeps state process-local when neither sink is wired", async () => {
            const swap = lightningSwap();
            const completed: string[] = [];
            const m = new RfqSwapManager(
                { indexer: fakeIndexer({ vtxos: spentBy(CLAIM_SPEND.txid), txs: [CLAIM_SPEND] }) },
                { now: () => SAFE_NOW },
            );
            m.setCallbacks({ refundArkade: async () => null });
            m.onSwapCompleted((s) => completed.push(s.rfqId));

            await m.addSwap(swap);
            await m.poll();

            expect(swap.state).toBe("settled");
            expect(completed).toEqual([RFQ_ID]);
        });
    });

    describe("restoreFromRepository", () => {
        const contractsFor = (...rows: CreateContractParams[]) =>
            fakeContracts({ preexisting: rows });

        it("rebuilds every stored record and drives it", async () => {
            const store = fakeStore([storedSend()]);
            const s = spies();
            const m = manager({
                indexer: settlingIndexer(),
                contracts: contractsFor(rowFor(LOCKUP, LOCKUP_ADDRESS)),
                repository: store,
                now: SAFE_NOW,
                spies: s,
            });

            const result = await m.restoreFromRepository();

            expect(result.restored.map((swap) => swap.rfqId)).toEqual([RFQ_ID]);
            expect(result.failed).toHaveLength(0);
            expect(await m.hasSwap(RFQ_ID)).toBe(true);

            await m.poll();

            expect(store.records.get(RFQ_ID)?.state).toBe("settled");
        });

        it("carries a restored swap's origin, so its record can be rewritten", async () => {
            // The store losing a record mid-life is the case the in-memory
            // origin map exists for: without it the next write would have
            // nothing to build a create from.
            const store = fakeStore([storedSend()]);
            const s = spies();
            const m = manager({
                indexer: settlingIndexer(),
                contracts: contractsFor(rowFor(LOCKUP, LOCKUP_ADDRESS)),
                repository: store,
                now: SAFE_NOW,
                spies: s,
            });

            await m.restoreFromRepository();
            store.records.clear();
            await m.poll();

            expect(store.records.get(RFQ_ID)?.lockupAddress).toBe(LOCKUP_ADDRESS);
            // And it is a CLEAN origin, not the old record spread whole: a
            // stale `blockedReason` carried through would read as a live
            // refusal on a swap that is running.
            expect(store.records.get(RFQ_ID)?.blockedReason).toBeUndefined();
        });

        it("reports a record it cannot rebuild without stranding the others", async () => {
            const orphan = {
                ...createRfqSwapRecord(receiveOrigin(), receiveSwap()),
                rfqId: "b2".repeat(32),
            };
            const store = fakeStore([storedSend(), orphan]);
            const s = spies();
            const m = manager({
                // Only the send lockup has a row; the receive one has none.
                contracts: contractsFor(rowFor(LOCKUP, LOCKUP_ADDRESS)),
                repository: store,
                now: SAFE_NOW,
                spies: s,
            });

            const result = await m.restoreFromRepository();

            expect(result.restored.map((swap) => swap.rfqId)).toEqual([RFQ_ID]);
            expect(result.failed.map((failure) => failure.rfqId)).toEqual(["b2".repeat(32)]);
            expect(result.failed[0].error.name).toBe("LockupContractMissing");
            // Kept in the store: the record is fine, the wallet's copy of the
            // covenant is what is missing.
            expect(store.removed).toHaveLength(0);
        });

        it("takes the covenant from an override instead of the contract store", async () => {
            const store = fakeStore([storedSend()]);
            const s = spies();
            const m = manager({ repository: store, now: SAFE_NOW, spies: s });

            const result = await m.restoreFromRepository({
                params: async () => VHTLCV2ContractHandler.serializeParams(LOCKUP.options),
            });

            expect(result.restored).toHaveLength(1);
        });

        it("refuses when there is no covenant source at all", async () => {
            const store = fakeStore([storedSend()]);
            const s = spies();
            const m = manager({ repository: store, now: SAFE_NOW, spies: s });

            await expect(m.restoreFromRepository()).rejects.toThrow(/contracts/);
        });

        it("refuses when no repository is wired", async () => {
            const s = spies();
            const m = manager({ now: SAFE_NOW, spies: s });

            await expect(m.restoreFromRepository()).rejects.toThrow(/repository/);
        });
    });

    describe("retention", () => {
        const LONG_AGO = SAFE_NOW - RFQ_SWAP_RETENTION_SECONDS - 1;

        it("drops a terminal record past the window and keeps a fresh one", async () => {
            const store = fakeStore([
                storedSend({ state: "settled", updatedAt: LONG_AGO }),
                storedSend({ rfqId: "b2".repeat(32), state: "settled", updatedAt: SAFE_NOW - 10 }),
            ]);
            const s = spies();
            const m = manager({ repository: store, now: SAFE_NOW, spies: s });

            expect(await m.pruneRetiredSwaps()).toEqual([RFQ_ID]);
            expect([...store.records.keys()]).toEqual(["b2".repeat(32)]);
        });

        it("never drops needs_counterparty, however old", async () => {
            // The money is still at the lockup and the counterparty's move is
            // still what ends the swap — `shouldRetainRfqSwap` encodes this and
            // the manager defers to it rather than restating the rule.
            const store = fakeStore([
                storedSend({ state: "needs_counterparty", updatedAt: LONG_AGO }),
            ]);
            const s = spies();
            const m = manager({ repository: store, now: SAFE_NOW, spies: s });

            expect(await m.pruneRetiredSwaps()).toEqual([]);
            expect(store.records.has(RFQ_ID)).toBe(true);
        });

        it("prunes before the rebuild, so a retired record costs no lookup", async () => {
            const contracts = fakeContracts({ preexisting: [rowFor(LOCKUP, LOCKUP_ADDRESS)] });
            const store = fakeStore([storedSend({ state: "settled", updatedAt: LONG_AGO })]);
            const s = spies();
            const m = manager({
                contracts,
                repository: store,
                now: SAFE_NOW,
                spies: s,
            });

            const result = await m.restoreFromRepository();

            expect(result.pruned).toEqual([RFQ_ID]);
            expect(result.restored).toHaveLength(0);
            expect(result.failed).toHaveLength(0);
        });

        it("keeps a still-monitored swap's origin, so the next pass can rewrite its record", async () => {
            // The reachable orphan: `save` counts a pass as persisted only when
            // BOTH sinks took it, so a canonical write that landed beside a
            // `saveSwap` that keeps rejecting leaves the swap monitored and
            // dirty with a TERMINAL record ageing behind it. Retention judges
            // the stored record, so it retires one the manager is still
            // driving — and dropping the origin with it would leave every
            // later pass throwing `RfqSwapOriginRequired` for a swap that was
            // otherwise fine.
            const store = fakeStore();
            const s = spies();
            s.callbacks.saveSwap = async () => {
                throw new Error("secondary sink unavailable");
            };
            const failures: string[] = [];
            const m = manager({
                indexer: settlingIndexer(),
                repository: store,
                now: SAFE_NOW,
                spies: s,
            });
            m.onSwapFailed((_swap, error) => failures.push(error.message));

            await m.addSwap(lightningSwap(), sendOrigin());
            await m.poll();
            expect(store.records.get(RFQ_ID)?.state).toBe("settled");
            expect(await m.hasSwap(RFQ_ID)).toBe(true);

            // The stored record ages past the window while its swap is still
            // monitored, and retention takes it.
            store.records.get(RFQ_ID)!.updatedAt = LONG_AGO;
            expect(await m.pruneRetiredSwaps()).toEqual([RFQ_ID]);

            s.callbacks.saveSwap = async () => {};
            await m.poll();

            // Recreated from the origin the manager kept, rather than spinning
            // on a swap whose record could never be written again.
            expect(store.records.get(RFQ_ID)?.state).toBe("settled");
            expect(store.records.get(RFQ_ID)?.lockupAddress).toBe(LOCKUP_ADDRESS);
            expect(failures.some((message) => message.includes("origin"))).toBe(false);
        });

        it("is a no-op with no repository wired", async () => {
            const s = spies();
            const m = manager({ now: SAFE_NOW, spies: s });
            expect(await m.pruneRetiredSwaps()).toEqual([]);
        });
    });

    describe("stamping the spend that ended the swap", () => {
        it("records the ark transactions the chain read named", async () => {
            const store = fakeStore();
            const s = spies();
            const swap = lightningSwap();
            const m = manager({
                indexer: fakeIndexer({
                    vtxos: [{ ...LOCKUP_OUTPOINT, spentBy: CLAIM_SPEND.txid, arkTxId: ARK_TXID }],
                    txs: [CLAIM_SPEND],
                }),
                repository: store,
                now: SAFE_NOW,
                spies: s,
            });

            await m.addSwap(swap, sendOrigin());
            await m.poll();

            expect(swap.state).toBe("settled");
            // The counterparty's transaction — nothing local produced it, so no
            // other field on the record can name it.
            expect(swap.lockupSpendTxids).toEqual([ARK_TXID]);
            expect(store.records.get(RFQ_ID)?.lockupSpendTxids).toEqual([ARK_TXID]);
        });

        it("stamps nothing when the indexer named the checkpoint but not the ark tx", async () => {
            // `LockupSpend.txid` is optional, and a checkpoint txid is not
            // what history correlates on. Fewer txids beats a wrong one.
            const store = fakeStore();
            const s = spies();
            const swap = lightningSwap();
            const m = manager({
                indexer: settlingIndexer(),
                repository: store,
                now: SAFE_NOW,
                spies: s,
            });

            await m.addSwap(swap, sendOrigin());
            await m.poll();

            expect(swap.state).toBe("settled");
            expect(swap.lockupSpendTxids).toBeUndefined();
        });

        it("survives the record round trip", async () => {
            const store = fakeStore([
                storedSend({
                    state: "settled",
                    updatedAt: SAFE_NOW - 10,
                    lockupSpendTxids: [ARK_TXID],
                }),
            ]);
            const s = spies();
            const m = manager({
                contracts: fakeContracts({ preexisting: [rowFor(LOCKUP, LOCKUP_ADDRESS)] }),
                repository: store,
                now: SAFE_NOW,
                spies: s,
            });

            const result = await m.restoreFromRepository();

            expect(result.restored[0].lockupSpendTxids).toEqual([ARK_TXID]);
        });
    });
});
