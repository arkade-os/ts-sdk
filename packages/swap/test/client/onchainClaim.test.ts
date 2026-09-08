/**
 * The `arkade -> onchain` withdrawal, made recipient-exact and self-claiming.
 *
 * Two defects shared one root: the take leg was forwarded verbatim, so the
 * claim's miner fee came out of the recipient's payout; and no L1 claim
 * callback was wired by default, so the swap parked at `needs_recovery` with
 * the fill sitting on L1. The fix also shares one root: the corridor carries
 * a fee rate, which prices BOTH the gross-up on the quote path and the
 * default claim the drive synthesizes. These tests pin each half, and the
 * places the rate is allowed to come from — the per-network floor table, the
 * caller's override, or a deliberate `null` that keeps manual mode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import { sha256 } from "@noble/hashes/sha2.js";
import { SingleKey } from "@arkade-os/sdk";
import { createSwapClient } from "../../src/client/client";
import { createSwapDrive } from "../../src/client/drive";
import { ONCHAIN_CLAIM_FEE_RATE_SATVB, resolveCorridorDeps } from "../../src/client/corridors/deps";
import { ONCHAIN_CLAIM_VSIZE, ONCHAIN_DUST_SATS, onchainHtlcScript } from "../../src/onchainHtlc";
import { RFQ_CONFIGURATION_REFUSAL } from "../../src/swapManager";
import {
    EMULATOR_PUBKEY_HEX,
    clockAt,
    feedServing,
    hdWallet,
    lightningCard,
    onchainCard,
    solverFor,
    solverTransport,
    spotCard,
} from "./fixtures";
import {
    BEFORE,
    REFUND_LOCKTIME,
    SEND_LOCKUP,
    corridorRecord,
    fakeContracts,
    fakeCorridors,
    fakeIndexer,
    fakeOperator,
    fakeWallet,
    memoryRepository,
} from "./driveFixtures";
import { corridorBaseFor } from "./corridors/fixtures";

const NOW = 1_700_000_000;
const CLOCK = clockAt(NOW);
const BCRT1 = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";

/** The claim fee the regtest floor prices: the claim's vsize at 1 sat/vB. */
const DEFAULT_CLAIM_FEE = BigInt(
    Math.ceil(ONCHAIN_CLAIM_VSIZE * (ONCHAIN_CLAIM_FEE_RATE_SATVB.regtest ?? 0)),
);

const setup = async (
    over: {
        corridors?: Parameters<typeof createSwapClient>[0]["corridors"];
        answer?: Parameters<typeof solverTransport>[0];
        onchain?: DiscoveredMarket;
    } = {},
) => {
    const wallet = await hdWallet();
    const transport = solverTransport(over.answer ?? solverFor(CLOCK));
    const feed = feedServing();
    const client = createSwapClient({
        wallet,
        discovery: { snapshot: [lightningCard, over.onchain ?? onchainCard, spotCard] },
        emulatorPubkey: EMULATOR_PUBKEY_HEX,
        transportFor: () => transport,
        fetchImpl: feed.fetch,
        ...(over.corridors === undefined ? {} : { corridors: over.corridors }),
    });
    return { client, transport, wallet };
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
    vi.useRealTimers();
});

describe("the recipient-exact take leg", () => {
    it("asks the solver for the amount plus the claim the recipient will pay", async () => {
        const { client, transport } = await setup();
        const quote = await client.quote({ to: BCRT1, amount: 99_000n, amountOn: "take" });

        // The wire's take pin is the GROSSED one: what the recipient nets
        // after the claim's fee is exactly the requested amount.
        expect(transport.sent[0]).toMatchObject({ amount: "99152", amount_side: "to" });
        // The quote restates it recipient-exact, and the fee carries both
        // halves of the cost — the solver's spread and the claim the trader
        // pays for out of the payout.
        expect(quote.take.amount).toBe(99_000n);
        expect(quote.fee.amount).toBe(quote.give.amount - quote.take.amount);
        // The floor table's own arithmetic, not a second constant: 152 vB at
        // the regtest floor, over the double's 848 sat spread.
        expect(quote.fee.amount).toBe(1_000n);
        expect(quote.give.amount).toBe(100_000n);
        expect(DEFAULT_CLAIM_FEE).toBe(152n);
    });

    it("prices the same gross-up off a BIP21 destination pin", async () => {
        const { client } = await setup();
        const quote = await client.quote({ to: `bitcoin:${BCRT1}?amount=0.00099` });
        expect(quote.take.amount).toBe(99_000n);
        expect(quote.fee.amount).toBe(1_000n);
    });

    it("grosses up by the caller's fee rate when one overrides the floor", async () => {
        const { client, transport } = await setup({
            corridors: { onchain: { claimFeeRateSatVb: 3 } },
        });
        const quote = await client.quote({ to: BCRT1, amount: 99_000n, amountOn: "take" });
        // 152 vB at 3 sat/vB is 456, and the recipient's pin is unchanged:
        // the GROSSED take is what the solver is asked for, and the double's
        // spread shrinks around it — the reported fee absorbs exactly the
        // claim fee, holding `give = take + fee`.
        expect(transport.sent[0]).toMatchObject({ amount: "99456", amount_side: "to" });
        expect(quote.take.amount).toBe(99_000n);
        expect(quote.fee.amount).toBe(quote.give.amount - quote.take.amount);
        expect(quote.fee.amount).toBe(544n + 456n);
    });

    it("forwards the take leg verbatim when the corridor cannot price a claim", async () => {
        // `claimFeeRateSatVb: null` is manual mode's whole signal: no
        // gross-up, no default claim, and no invented fee.
        const { client, transport } = await setup({
            corridors: { onchain: { claimFeeRateSatVb: null } },
        });
        const quote = await client.quote({ to: BCRT1, amount: 99_000n, amountOn: "take" });
        expect(transport.sent[0]).toMatchObject({ amount: "99000", amount_side: "to" });
        expect(quote.take.amount).toBe(99_000n);
        expect(quote.fee.amount).toBe(1_000n);
    });

    it("leaves the give-pinned case on the wire's own arithmetic", async () => {
        const { client, transport } = await setup();
        const quote = await client.quote({ to: BCRT1, amount: 100_000n, amountOn: "give" });
        expect(transport.sent[0]).toMatchObject({ amount: "100000", amount_side: "from" });
        expect(quote.give.amount).toBe(100_000n);
        expect(quote.take.amount).toBe(99_000n);
        expect(quote.fee.amount).toBe(1_000n);
    });
});

describe("the dust floor", () => {
    it("refuses a payout the claim could not build, before anything is funded", async () => {
        // The card's own minimum (1000 sats) sits above the dust floor, so the
        // stock card refuses a 200 sat take as an unserved route long before
        // the claim is priced. Drop the minimum so the FLOOR is what answers.
        const { client, transport } = await setup({
            onchain: { ...onchainCard, min_base_amount: "1", min_quote_amount: "1" },
        });
        // 200 sats pinned for the recipient: net of the 152 sat claim fee
        // that is a 200 sat payout, which `buildHtlcClaim` would refuse at
        // claim time with the lockup already funded.
        const error = await client
            .quote({ to: BCRT1, amount: 200n, amountOn: "take" })
            .catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toMatch(/dust limit/);
        expect(String(error)).toMatch(String(ONCHAIN_DUST_SATS));
        // The refusal is after the round trip — it is the SOLVER's take leg
        // that fails the floor — and before any funding exists.
        expect(transport.sent).toHaveLength(1);
        expect(200n).toBeLessThan(ONCHAIN_DUST_SATS);
    });
});

describe("the fee-rate dep itself", () => {
    it("defaults to the network's floor, and the override wins", () => {
        expect(resolveCorridorDeps("onchain", undefined, corridorBaseFor("regtest"))).toMatchObject(
            { claimFeeRateSatVb: ONCHAIN_CLAIM_FEE_RATE_SATVB.regtest },
        );
        expect(
            resolveCorridorDeps(
                "onchain",
                { onchain: { claimFeeRateSatVb: 7 } },
                corridorBaseFor("regtest"),
            ).claimFeeRateSatVb,
        ).toBe(7);
        // The vsize estimate defaults too, and feeds nothing but the
        // gross-up — the claim build measures its own transaction.
        expect(
            resolveCorridorDeps("onchain", undefined, corridorBaseFor("regtest")).claimVsize,
        ).toBe(ONCHAIN_CLAIM_VSIZE);
    });

    it("reads the fee rate overridden to nothing as no default — manual mode, not a refusal", () => {
        // The fee policy's `null` breaks the override matrix's rule on
        // purpose: disabling a default is not disabling a dep, and a corridor
        // that refuses to resolve here could not quote at all, which is the
        // opposite of manual mode.
        const deps = resolveCorridorDeps(
            "onchain",
            { onchain: { claimFeeRateSatVb: null } },
            corridorBaseFor("regtest"),
        );
        expect(deps.claimFeeRateSatVb).toBeUndefined();
        expect(deps.chain).toBeDefined();
    });
});

// ── The default claim, end-to-end at the drive ──────────────────────────────

/** A wallet whose identity key is the HTLC's payout key — SENDER's. */
const SENDER = SingleKey.fromRandomBytes();
/** P, and the only hash of it the record needs. */
const PREIMAGE = new Uint8Array(32).fill(11);
const CLAIM_PAYMENT_HASH = hex.encode(sha256(PREIMAGE));
const realNow = (): number => Math.floor(Date.now() / 1000);
/**
 * The HTLC's refund deadline: past the drive's fake clock AND past the
 * claim's own wall-clock margin, so both `nextOnchainAction` and
 * `claimOnchainFill` agree the window is open. The Arkade lockup's own
 * REFUND_LOCKTIME + 200h keeps the protocol's timelock order as well.
 */
const HTLC_LOCKTIME = REFUND_LOCKTIME + 200 * 3600;

/**
 * The record `accept()` would have written for an `arkade -> onchain` swap
 * whose claim key is SENDER's: a real HTLC (the restore rebuilds and
 * address-checks it, so a fixture-shaped one is not an option), the claim
 * secret carried stored, and the payout script the quote pinned.
 */
const onchainSendRecord = async () => {
    const payoutPubkey = await SENDER.xOnlyPublicKey();
    const solverRefundKey = await SingleKey.fromRandomBytes().xOnlyPublicKey();
    const htlc = onchainHtlcScript(
        {
            paymentHash: CLAIM_PAYMENT_HASH,
            claimKey: payoutPubkey,
            refundKey: solverRefundKey,
            refundLocktime: HTLC_LOCKTIME,
        },
        "regtest",
    );
    const payoutPkScript = Uint8Array.from([0x51, 0x20, ...payoutPubkey]);
    const profile = {
        signer: { signingDescriptor: `tr(${hex.encode(payoutPubkey)})` },
        hashlock: { paymentHash: CLAIM_PAYMENT_HASH, preimageHex: hex.encode(PREIMAGE) },
        claimKey: hex.encode(payoutPubkey),
        refundKey: hex.encode(solverRefundKey),
        htlcLocktime: HTLC_LOCKTIME,
        network: "regtest",
        htlcAddress: htlc.address,
        minConfirmations: 1,
        payoutPkScript: hex.encode(payoutPkScript),
    };
    return {
        htlc,
        payoutPkScript,
        record: corridorRecord({
            kind: "onchain_send",
            fundingTxid: "aa".repeat(32),
            profile,
        }),
    };
};

/** An L1 view where the fill is one confirmed output deep and the window is open. */
const chainWithFill = (
    htlc: { pkScript: Uint8Array },
    amount: bigint,
): { chain: object; broadcasts: string[] } => {
    const broadcasts: string[] = [];
    const chain = {
        getScriptUtxos: async (pkScript: Uint8Array) =>
            hex.encode(pkScript) === hex.encode(htlc.pkScript)
                ? [{ txid: "bb".repeat(32), vout: 0, amount, confirmations: 3 }]
                : [],
        getSpendingTx: async () => null,
        broadcast: async (txHex: string) => {
            broadcasts.push(txHex);
            return "cc".repeat(32);
        },
        getMtp: async () => realNow(),
    };
    return { chain, broadcasts };
};

describe("the wallet-backed default claim", () => {
    it("claims the fill itself when no claim callback is wired, at the default rate", async () => {
        const { htlc, record } = await onchainSendRecord();
        const { chain, broadcasts } = chainWithFill(htlc, 99_152n);
        const repository = memoryRepository();
        await repository.saveSwapRecord(record);
        const contracts = fakeContracts([SEND_LOCKUP]);
        const corridors = fakeCorridors({ chain, claimFeeRateSatVb: 1 });
        const { wallet } = fakeWallet({ contracts, identity: SENDER });
        const drive = createSwapDrive({
            wallet,
            repository,
            corridors,
            operator: fakeOperator(),
            indexer: fakeIndexer({ vtxos: [{ txid: "99".repeat(32), vout: 0, spentBy: "" }] }),
            contracts,
            now: () => BEFORE,
            pollIntervalMs: 10 * 60 * 1000,
        });
        await drive.ready;
        await drive.idle();

        // The fill was claimed, not parked: one broadcast went out, and the
        // swap never read as `needs_recovery` for want of a callback.
        expect(broadcasts).toHaveLength(1);
        expect(drive.swap("q1")?.outcome).toBe("funded");
        expect(drive.swap("q1")?.blockedReason).toBeUndefined();
        await drive.dispose();
    });

    it("keeps manual mode when the corridor carries no fee rate", async () => {
        const { htlc, record } = await onchainSendRecord();
        const { chain, broadcasts } = chainWithFill(htlc, 99_152n);
        const repository = memoryRepository();
        await repository.saveSwapRecord(record);
        const contracts = fakeContracts([SEND_LOCKUP]);
        // No claim, and no rate to build one from: the drive synthesizes
        // nothing, and the manager says exactly which callback is missing.
        const corridors = fakeCorridors({ chain });
        const { wallet } = fakeWallet({ contracts, identity: SENDER });
        const drive = createSwapDrive({
            wallet,
            repository,
            corridors,
            operator: fakeOperator(),
            indexer: fakeIndexer({ vtxos: [{ txid: "99".repeat(32), vout: 0, spentBy: "" }] }),
            contracts,
            now: () => BEFORE,
            pollIntervalMs: 10 * 60 * 1000,
        });
        await drive.ready;
        await drive.idle();

        expect(broadcasts).toHaveLength(0);
        expect(drive.swap("q1")?.outcome).toBe("needs_recovery");
        expect(drive.swap("q1")?.blockedReason).toBe(
            RFQ_CONFIGURATION_REFUSAL.noClaimOnchainCallback,
        );
        await drive.dispose();
    });

    it("prefers the caller's claim callback over the default it would have built", async () => {
        const { htlc, record } = await onchainSendRecord();
        const { chain, broadcasts } = chainWithFill(htlc, 99_152n);
        const repository = memoryRepository();
        await repository.saveSwapRecord(record);
        const contracts = fakeContracts([SEND_LOCKUP]);
        const claim = vi.fn(async () => ({ txid: "dd".repeat(32) }));
        const corridors = fakeCorridors({ chain, claim, claimFeeRateSatVb: 1 });
        const { wallet } = fakeWallet({ contracts, identity: SENDER });
        const drive = createSwapDrive({
            wallet,
            repository,
            corridors,
            operator: fakeOperator(),
            indexer: fakeIndexer({ vtxos: [{ txid: "99".repeat(32), vout: 0, spentBy: "" }] }),
            contracts,
            now: () => BEFORE,
            pollIntervalMs: 10 * 60 * 1000,
        });
        await drive.ready;
        await drive.idle();

        expect(claim).toHaveBeenCalledTimes(1);
        expect(broadcasts).toHaveLength(0);
        await drive.dispose();
    });
});
