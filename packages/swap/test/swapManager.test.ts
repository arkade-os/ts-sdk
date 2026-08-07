/**
 * Driving a set of funded swaps to their end.
 *
 * The tests that matter most are the ones about WHEN, not how — the manager
 * holds no keys, so everything it can get wrong is a matter of timing:
 * claiming the L1 fill inside a window that two different functions describe
 * differently, refusing to claim once that window shuts, and still taking the
 * lockup back in every case where the swap died instead of settling.
 */
import { describe, expect, it, vi } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";

import type { RfqStatus, RfqTransport } from "../src/rfq";
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
import { REFUND_MTP_LAG_SECONDS } from "../src/refund";
import {
    RfqSwapManager,
    isRfqSwapTerminal,
    nextOnchainAction,
    type ArkadeRefundResult,
    type LightningSendSwap,
    type OnchainSendSwap,
    type RfqSwap,
    type RfqSwapActionName,
    type RfqSwapManagerCallbacks,
    type RfqSwapState,
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

const FILL: ChainUtxo = {
    txid: "11".repeat(32),
    vout: 0,
    amount: BigInt(100_000),
    confirmations: 3,
};

const lightningSwap = (over: Partial<LightningSendSwap> = {}): LightningSendSwap => ({
    kind: "lightning_send",
    rfqId: RFQ_ID,
    state: "pending",
    refundLocktime: REFUND_LOCKTIME,
    createdAt: 1,
    updatedAt: 1,
    ...over,
});

const onchainSwap = (over: Partial<OnchainSendSwap> = {}): OnchainSendSwap => ({
    kind: "onchain_send",
    rfqId: RFQ_ID,
    state: "pending",
    refundLocktime: REFUND_LOCKTIME,
    createdAt: 1,
    updatedAt: 1,
    htlc: htlcOf(),
    minConfirmations: 2,
    ...over,
});

const statusOf = (state: string): RfqStatus => ({
    v: 1,
    type: "rfq_status",
    rfq_id: RFQ_ID,
    state,
    updated_at: 1,
    profile: {},
});

/** A transport serving a scripted sequence, repeating the last entry. `null`
 * is "the solver has no record yet"; an Error is thrown from `status()`. */
const fakeTransport = (states: (string | null | Error)[]): RfqTransport & { calls: number } => {
    const transport = {
        calls: 0,
        async requestQuote() {
            throw new Error("not used");
        },
        async status() {
            const state = states[Math.min(transport.calls, states.length - 1)];
            transport.calls += 1;
            if (state instanceof Error) throw state;
            return state === null ? null : statusOf(state);
        },
        async close() {},
    };
    return transport as unknown as RfqTransport & { calls: number };
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

interface Spies {
    callbacks: RfqSwapManagerCallbacks;
    claims: { rfqId: string; utxo: ChainUtxo }[];
    refunds: string[];
    saved: RfqSwapState[];
    actions: RfqSwapActionName[];
}

const spies = (
    over: {
        claim?: () => Promise<{ txid: string }>;
        refund?: () => Promise<ArkadeRefundResult>;
    } = {},
): Spies => {
    const claims: { rfqId: string; utxo: ChainUtxo }[] = [];
    const refunds: string[] = [];
    const saved: RfqSwapState[] = [];
    return {
        claims,
        refunds,
        saved,
        actions: [],
        callbacks: {
            async claimOnchain(swap, utxo) {
                claims.push({ rfqId: swap.rfqId, utxo });
                return over.claim ? over.claim() : { txid: "dd".repeat(32) };
            },
            async refundArkade(swap) {
                refunds.push(swap.rfqId);
                return over.refund ? over.refund() : { arkTxid: "ee".repeat(32), amount: 100_000 };
            },
            async saveSwap(swap) {
                saved.push(swap.state);
            },
        },
    };
};

/** A manager wired to the given seams, never started — the tests drive `poll()`
 * so nothing depends on a timer. */
const manager = (input: {
    transport: RfqTransport;
    chain?: ChainSource;
    now: number | (() => number);
    spies: Spies;
    enableAutoActions?: boolean;
}): RfqSwapManager => {
    const m = new RfqSwapManager(
        { transport: input.transport, chain: input.chain },
        {
            now: typeof input.now === "function" ? input.now : () => input.now as number,
            enableAutoActions: input.enableAutoActions,
            events: { onActionExecuted: (_s, a) => input.spies.actions.push(a) },
        },
    );
    m.setCallbacks(input.spies.callbacks);
    return m;
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

describe("RfqSwapManager — the onchain-send L1 half", () => {
    it("claims a confirmed fill and records the txid", async () => {
        const s = spies();
        const swap = onchainSwap();
        const m = manager({
            transport: fakeTransport(["funded"]),
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
            transport: fakeTransport(["funded"]),
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
            transport: fakeTransport(["funded"]),
            chain: fakeChain({ utxos: [FILL], mtp: HTLC_LOCKTIME + 1 }),
            now: past,
            spies: s,
        });
        await m.addSwap(swap);
        await m.poll();

        expect(s.claims).toHaveLength(0);
        expect(s.refunds).toEqual([RFQ_ID]);
        expect(swap.state).toBe("refunded");
        expect(swap.refundArkTxid).toBe("ee".repeat(32));
    });

    it("remembers the fill's outpoint, so a spent HTLC is not read back as unfunded", async () => {
        const s = spies();
        const chain = fakeChain({ utxos: [FILL], mtp: SAFE_NOW });
        const swap = onchainSwap();
        const m = manager({
            transport: fakeTransport(["funded"]),
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
            transport: fakeTransport(["funded"]),
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
            transport: fakeTransport(["funded"]),
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
            transport: fakeTransport(["funded"]),
            chain: fakeChain({ utxos: [] }),
            now: REFUND_LOCKTIME + 60,
            spies: s,
        });
        await m.addSwap(swap);
        await m.poll();

        expect(s.refunds).toEqual([RFQ_ID]);
        expect(swap.state).toBe("refunded");
    });

    it("still refunds a swap the solver never filled at all", async () => {
        // `unfunded` at refundLocktime means the solver never came — the one
        // case a manager that treats "keep waiting for the fill" as the end of
        // the pass would sit on forever with the lockup stranded.
        const s = spies();
        const swap = onchainSwap();
        const m = manager({
            transport: fakeTransport(["quoted"]),
            chain: fakeChain({ utxos: [] }),
            now: REFUND_LOCKTIME + 60,
            spies: s,
        });
        await m.addSwap(swap);
        await m.poll();

        expect(swap.state).toBe("refunded");
        expect(s.refunds).toEqual([RFQ_ID]);
    });

    it("claims even while the solver's status route is down", async () => {
        // The L1 claim is on a consensus deadline; the solver's uptime has no
        // bearing on it, so a failing status() must not stall the pass.
        const s = spies();
        const swap = onchainSwap();
        const m = manager({
            transport: fakeTransport([new Error("502 from the solver")]),
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
            { transport: fakeTransport(["funded"]) },
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
        // failure is the trap this manager does not inherit from Boltz's
        expect(completed).toHaveLength(0);
    });

    it("treats a chain read that failed as nothing learned, not as an answer", async () => {
        const s = spies();
        const swap = onchainSwap();
        const m = manager({
            transport: fakeTransport(["funded"]),
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
            transport: fakeTransport(["funded"]),
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
    it("ends on the solver's own resolution, without pushing a refund", async () => {
        for (const [state, expected] of [
            ["settled", "settled"],
            ["refunded", "refunded"],
        ] as const) {
            const s = spies();
            const swap = lightningSwap();
            const m = manager({
                transport: fakeTransport([state]),
                // past the refund deadline, and the lockup looked funded
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

    it("still refunds a swap whose negotiation died — refused, expired or stuck", async () => {
        // Terminal for the NEGOTIATION, but a trader can be holding a funded
        // lockup in every one of them.
        for (const state of ["refused", "expired", "stuck"]) {
            const s = spies();
            const swap = lightningSwap();
            const m = manager({
                transport: fakeTransport([state]),
                now: REFUND_LOCKTIME + 1,
                spies: s,
            });
            await m.addSwap(swap);
            await m.poll();

            expect(swap.state).toBe("refunded");
            expect(s.refunds).toEqual([RFQ_ID]);
        }
    });

    it("does nothing while the refund window is shut", async () => {
        const s = spies();
        const swap = lightningSwap();
        const m = manager({
            transport: fakeTransport(["quoted"]),
            now: REFUND_LOCKTIME - 1,
            spies: s,
        });
        await m.addSwap(swap);
        await m.poll();

        expect(s.refunds).toHaveLength(0);
        expect(swap.state).toBe("pending");
        expect(swap.rfqState).toBe("quoted");
    });

    it("retries a push refused while median-time-past lags, at the poll cadence", async () => {
        let attempts = 0;
        const s = spies({
            refund: async () => {
                if (++attempts <= 2) throw new Error("FORFEIT_CLOSURE_LOCKED");
                return { arkTxid: "ee".repeat(32), amount: 100_000 };
            },
        });
        const swap = lightningSwap();
        const m = manager({
            transport: fakeTransport(["quoted"]),
            now: REFUND_LOCKTIME + 1,
            spies: s,
        });
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
            transport: fakeTransport(["quoted"]),
            now: REFUND_LOCKTIME + REFUND_MTP_LAG_SECONDS,
            spies: s,
        });
        await m.addSwap(swap);
        await m.poll();

        expect(swap.state).toBe("failed");
        expect(swap.failure).toMatch(/FORFEIT_CLOSURE_LOCKED/);
    });

    it("treats an empty lockup as nothing left to do", async () => {
        const s = spies({ refund: async () => null });
        const swap = lightningSwap();
        const m = manager({
            transport: fakeTransport(["stuck"]),
            now: REFUND_LOCKTIME + 1,
            spies: s,
        });
        await m.addSwap(swap);
        await m.poll();

        expect(swap.state).toBe("refunded");
        expect(swap.refundArkTxid).toBeUndefined();
    });
});

describe("RfqSwapManager — bookkeeping", () => {
    it("persists every state change through saveSwap", async () => {
        const s = spies();
        const swap = lightningSwap();
        const m = manager({
            transport: fakeTransport(["settled"]),
            now: SAFE_NOW,
            spies: s,
        });
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
                return { arkTxid: "ee".repeat(32), amount: 1 };
            },
        });
        const swap = lightningSwap();
        const m = manager({
            transport: fakeTransport(["quoted"]),
            now: REFUND_LOCKTIME + 1,
            spies: s,
        });
        m["monitored"].set(swap.rfqId, swap);

        await Promise.all([m.poll(), m.poll(), m.poll()]);
        expect(overlapped).toBe(false);
        expect(s.refunds).toHaveLength(1);
    });

    it("observes without acting when auto actions are off", async () => {
        const s = spies();
        const swap = onchainSwap();
        const m = manager({
            transport: fakeTransport(["funded"]),
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
            { transport: fakeTransport(["settled"]) },
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
            transport: fakeTransport(["funded"]),
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
        const m = manager({ transport: fakeTransport(["settled"]), now: SAFE_NOW, spies: s });
        m["monitored"].set(swap.rfqId, swap);
        const waiting = m.waitForSwapCompletion(RFQ_ID).then(() => order.push("resolved"));
        await m.poll();
        await waiting;

        expect(order).toEqual(["saved:settled", "resolved"]);
    });

    it("resolves a refund rather than rejecting it", async () => {
        const s = spies();
        const swap = lightningSwap();
        const m = manager({
            transport: fakeTransport(["stuck"]),
            now: REFUND_LOCKTIME + 1,
            spies: s,
        });
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
            transport: fakeTransport(["quoted"]),
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
            { transport: fakeTransport(["settled"]) },
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
            const transport = fakeTransport(["quoted"]);
            const m = manager({ transport, now: SAFE_NOW, spies: s });
            await m.start([lightningSwap()]);
            expect(transport.calls).toBe(1); // start polls immediately

            await vi.advanceTimersByTimeAsync(5_000);
            expect(transport.calls).toBe(2);

            await m.stop();
            await vi.advanceTimersByTimeAsync(20_000);
            expect(transport.calls).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });
});
