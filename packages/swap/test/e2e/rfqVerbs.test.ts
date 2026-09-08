/**
 * The verbs and the `lightning` rail against the real regtest stack.
 *
 * What the unit suite cannot prove, and this can: that the delegating arm of
 * `pay` moves real value through the real wallet, that `receive`'s artifact is
 * durable in a real repository before the call returns, and — the clause only a
 * rail can carry — that `RouteResult.swapId` round-trips from a payment handle
 * back to `client.swaps()`.
 *
 * Same stack and same stub-solver posture as `rfqDrive.test.ts`: the solver
 * quotes back the maker's OWN derivation, which is all the trust model lets a
 * maker use from a quote anyway. Nothing here fills a swap — a fill needs a
 * solver that pays the invoice — so what is real is everything the maker side
 * does.
 *
 * The `rfq` prefix on the filename is the ROUTING, not the subject: it is what
 * puts the file on the seconds-typed `swap-rfq` profile and keeps it off the
 * block-typed `swap` one (`packages/swap/package.json`'s two e2e scripts split
 * on exactly that prefix). `lightningSendContract` emits seconds-typed
 * timelocks and `unilateralClaimDelay` refuses a server exit delay below 512s,
 * so on the offer suite's arkd (`ARKD_UNILATERAL_EXIT_DELAY=20`) this suite
 * throws in `beforeAll` before a single verb runs. See `.env.regtest.rfq`.
 *
 * `exchange` is not here. Its route is `arkade <-> arkade`, which needs an
 * issued asset and a live price feed rather than a stubbed RFQ answer, and the
 * offer primitive it funds already has `offerCancel.test.ts` on the block stack.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { execSync } from "child_process";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
    ArkAddress,
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    REGTEST_EMULATOR_PUBKEY,
    RestArkProvider,
    SingleKey,
    Wallet,
} from "@arkade-os/sdk";
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import {
    LIGHTNING_RECEIVE_PAIR,
    LIGHTNING_SEND_PAIR,
    lightningReceiveContract,
    lightningSendContract,
    unilateralClaimDelay,
    type RfqQuote,
} from "../../src/protocol";
import {
    btcOn,
    createSwapClient,
    createSwapPaymentRouter,
    InMemoryAssetSwapRepository,
    LIGHTNING_RAIL,
    InsufficientFunds,
    type SwapClient,
    quoteIdOfSwapId,
} from "../../src";
import type { AttestingRfqTransport } from "../../src/client/transport";
import { encodeInvoice } from "../helpers/bolt11";

const OPERATOR_URL = "http://localhost:7070";
const ESPLORA_API_URL = "http://localhost:3000/api";
const arkdExec = "docker exec -t arkd";

const FAUCET_SATS = 30_000;
const LOCKUP_SATS = 1_000;
/** What the payee is paid; the stub's spread is the difference. */
const INVOICE_SATS = 990;

const xOnly = (key: Uint8Array): Uint8Array => (key.length === 32 ? key : key.slice(1));

const execCommand = (command: string): string => {
    const result = execSync(command, { encoding: "utf8" })
        .replace(/\r/g, "")
        .split("\n")
        .filter((line) => !line.includes("WARN"))
        .join("\n")
        .trim();
    if (result.startsWith("error:")) throw new Error(result);
    return result;
};

const waitFor = async (
    fn: () => Promise<boolean>,
    { timeout = 60_000, interval = 500 } = {},
): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error("timeout in waitFor");
};

let wallet: Wallet;
let emulatorPubkey: Uint8Array;
let operatorPubkey: Uint8Array;
let claimDelay: number;
let hrp: string;

const NOW = () => Math.floor(Date.now() / 1000);

const SOLVER = schnorr.getPublicKey(new Uint8Array(32).fill(7));
const SOLVER_PK_SCRIPT = Uint8Array.from([0x51, 0x20, ...SOLVER]);
const PREIMAGE = new Uint8Array(32).fill(11);
const PAYMENT_HASH = hex.encode(sha256(PREIMAGE));
const DISCOVERY_KEY = hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(4)));

/** One card, both directions: `arkade:BTC <-> lightning:BTC`. */
const CARD: DiscoveredMarket = {
    pair: "BTC/lightning:BTC",
    base_asset: { id: "btc", name: "Bitcoin", ticker: "BTC", decimals: 8 },
    quote_asset: { id: "btc", name: "Bitcoin", ticker: "BTC", decimals: 8 },
    base_corridor: "arkade",
    quote_corridor: "lightning",
    fee_bps: 0,
    min_base_amount: "100",
    max_base_amount: "50000000",
    min_quote_amount: "100",
    max_quote_amount: "50000000",
    solver: "stub",
    source: "https://registry.example/regtest.json",
    sourceType: "registry",
    discovery_pubkey: DISCOVERY_KEY,
    transports: { nostr: { relays: ["wss://relay.invalid"] } },
} as unknown as DiscoveredMarket;

const invoiceFor = (paymentHash: string, sats: number): string =>
    encodeInvoice({
        prefix: "lnbcrt",
        amount: `${sats * 10}n`,
        timestamp: NOW() - 60,
        expiry: 7_200,
        paymentHash,
    });

/** The invoice `pay` is quoted against. */
const invoice = (): string => invoiceFor(PAYMENT_HASH, INVOICE_SATS);

/**
 * A solver that quotes back the maker's own derivation on both legs, and
 * attests to the card's own key so the responder check runs for real.
 */
const stubTransport = (
    amounts: { from: number; to: number } = { from: LOCKUP_SATS, to: INVOICE_SATS },
): AttestingRfqTransport => ({
    attestedResponder: DISCOVERY_KEY,
    async requestQuote(payload) {
        const profile = (payload as { profile: Record<string, unknown> }).profile;
        // Far enough out to clear both legs' headroom gates.
        const refundLocktime = NOW() + 200 * 3600;
        const base = {
            v: 1 as const,
            type: "rfq_quote" as const,
            rfq_id: payload.rfq_id as string,
            solver_pubkey: hex.encode(SOLVER),
            valid_until: NOW() + 3600,
            refund_locktime: refundLocktime,
        };
        if (payload.pair === LIGHTNING_RECEIVE_PAIR) {
            const paymentHash = profile.payment_hash as string;
            const contract = lightningReceiveContract({
                solverPubkey: SOLVER,
                refundLocktime,
                operatorPubkey,
                paymentHash,
                claimDelay,
                emulatorPubkey,
                solverRefundPkScript: SOLVER_PK_SCRIPT,
                payoutPubkey: hex.decode(profile.payout_pubkey as string),
                payoutPkScript: ArkAddress.decode(profile.payout_address as string).pkScript,
            });
            return {
                ...base,
                pair: LIGHTNING_RECEIVE_PAIR,
                from_amount: amounts.from,
                to_amount: amounts.to,
                profile: {
                    payment_hash: paymentHash,
                    invoice: invoiceFor(paymentHash, amounts.from),
                    lockup_address: contract.address(hrp, operatorPubkey).encode(),
                    solver_refund_pk_script: hex.encode(SOLVER_PK_SCRIPT),
                },
            } satisfies RfqQuote;
        }
        const contract = lightningSendContract({
            solverPubkey: SOLVER,
            refundLocktime,
            operatorPubkey,
            paymentHash: PAYMENT_HASH,
            claimDelay,
            emulatorPubkey,
            senderPubkey: hex.decode(profile.client_refund_pubkey as string),
            receiverPkScript: SOLVER_PK_SCRIPT,
            refundPkScript: ArkAddress.decode(profile.refund_address as string).pkScript,
        });
        return {
            ...base,
            pair: LIGHTNING_SEND_PAIR,
            from_amount: amounts.from,
            to_amount: amounts.to,
            profile: {
                receiver_pk_script: hex.encode(SOLVER_PK_SCRIPT),
                lockup_address: contract.address(hrp, operatorPubkey).encode(),
            },
        } satisfies RfqQuote;
    },
    async status() {
        return null;
    },
    async close() {},
});

const repository = new InMemoryAssetSwapRepository();

const clientOn = (amounts?: { from: number; to: number }): SwapClient =>
    createSwapClient({
        wallet,
        repository,
        discovery: { snapshot: [CARD] },
        transportFor: () => stubTransport(amounts),
    });

beforeAll(async () => {
    wallet = await Wallet.create({
        identity: SingleKey.fromRandomBytes(),
        arkProvider: new RestArkProvider(OPERATOR_URL),
        onchainProvider: new EsploraProvider(ESPLORA_API_URL, {
            forcePolling: true,
            pollingInterval: 2000,
        }),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        settlementConfig: false,
    });

    const note = execCommand(`${arkdExec} arkd note --amount 200000`);
    execCommand(`${arkdExec} ark redeem-notes -n ${note} --password secret`);
    const address = await wallet.getAddress();
    execCommand(`${arkdExec} ark send --to ${address} --amount ${FAUCET_SATS} --password secret`);
    await waitFor(async () => (await wallet.getVtxos()).length > 0);

    const info = await wallet.getArkadeInfo();
    operatorPubkey = xOnly(hex.decode(info.signerPubkey));
    claimDelay = unilateralClaimDelay(Number(info.unilateralExitDelay));
    hrp = ArkAddress.decode(address).hrp;
    emulatorPubkey = xOnly(hex.decode(REGTEST_EMULATOR_PUBKEY));
}, 180_000);

describe("the verbs (regtest)", () => {
    it("pays a bolt11 and answers with the swap it funded", async () => {
        const client = clientOn();
        const result = await client.pay(invoice());

        expect(result.kind).toBe("swap");
        if (result.kind !== "swap") return;
        expect(result.swap.take.amount).toBe(BigInt(INVOICE_SATS));
        expect(result.swap.give.amount).toBe(BigInt(LOCKUP_SATS));
        expect(result.swap.fundingTxid).toEqual(expect.any(String));

        // The record the verb never mentions is there under the bare quote id.
        expect(await repository.getSwapRecord(quoteIdOfSwapId(result.swap.id))).toBeDefined();
        // And the tagged id round-trips to the history read.
        const swaps = await client.swaps();
        expect(swaps.map((s) => s.id)).toContain(result.swap.id);

        await client[Symbol.asyncDispose]();
    }, 180_000);

    it("refuses to fund a quote over the ceiling, before anything moves", async () => {
        const client = clientOn();
        const before = (await repository.getAllSwapRecords()).length;
        // The stub's spread is LOCKUP_SATS - INVOICE_SATS, on the give leg.
        const maxFee = { amount: 1n, asset: btcOn("arkade", "regtest") };

        await expect(client.pay(invoice(), { maxFee })).rejects.toMatchObject({
            name: "MaxFeeExceeded",
            fee: BigInt(LOCKUP_SATS - INVOICE_SATS),
            maxFee: 1n,
        });
        expect(await repository.getAllSwapRecords()).toHaveLength(before);

        await client[Symbol.asyncDispose]();
    }, 120_000);

    it("sends a plain Arkade address through the wallet, with no swap behind it", async () => {
        const client = clientOn();
        const before = (await repository.getAllSwapRecords()).length;
        const destination = await wallet.getAddress();

        const result = await client.pay(destination, { amount: 500n });

        expect(result.kind).toBe("payment");
        if (result.kind !== "payment") return;
        expect(result.txid).toMatch(/^[0-9a-f]{64}$/);
        // Same asset, same rail, rate 1: nothing was recorded.
        expect(await repository.getAllSwapRecords()).toHaveLength(before);

        await client[Symbol.asyncDispose]();
    }, 120_000);

    it("returns a receive artifact that is already durable", async () => {
        const client = clientOn();
        const request = await client.receive({ amount: BigInt(INVOICE_SATS), via: "lightning" });

        expect(request.artifact).toMatchObject({ kind: "invoice" });
        expect(request.take.amount).toBe(BigInt(INVOICE_SATS));
        // The ordering: the record and its claim secret are at rest before the
        // invoice can reach a payer.
        const stored = await repository.getSwapRecord(quoteIdOfSwapId(request.id));
        expect(stored?.artifact).toMatchObject({ kind: "invoice" });
        // A receive funds nothing — the payer paying the invoice is the accept.
        expect(stored?.fundingTxid).toBeUndefined();

        await client[Symbol.asyncDispose]();
    }, 180_000);
});

describe("the lightning rail through a real router (regtest)", () => {
    it("routes an invoice, funds it, and hands back a swapId swaps() knows", async () => {
        const client = clientOn();
        const router = createSwapPaymentRouter(wallet, client, { claimFeeRateSatVb: 2 });

        const quote = await router.route({ raw: invoice() });
        expect(quote.railId).toBe(LIGHTNING_RAIL);
        // Receiver-exact: the payee is paid the invoice and the spread is on top.
        expect(quote.amount).toBe(INVOICE_SATS);
        expect(quote.total).toBe(quote.amount + quote.fee);

        const handle = await quote.send();
        const seen: { status: string; swapId?: string }[] = [];
        handle.subscribe((u) => seen.push({ status: u.status, ...(u.result ?? {}) }));

        // The lockup is funded and the drive adopts it. Nothing fills it, so
        // `"sent"` is where this stops — which is exactly what `funded` means.
        await waitFor(async () => seen.some((u) => u.status === "sent"));

        // The clause only a rail carries: the handle's own result id is the
        // tagged form, and it names a swap the client's history read holds as
        // funded — the two views joined on one identity.
        const swapId = seen.find((u) => u.status === "sent")?.swapId;
        expect(swapId).toMatch(/^rfq:/);
        const swaps = await client.swaps();
        expect(swaps.find((s) => s.id === swapId)?.outcome).toBe("funded");

        await client[Symbol.asyncDispose]();
    }, 240_000);
});

/**
 * The drain, on the side of the SDK that cannot take one.
 *
 * `offerCancel.test.ts` funds an offer with the entire balance and it works,
 * because an asset swap denominates its fee on the TAKE leg. A corridor route
 * is the other way round: the invoice is the take leg verbatim and the give leg
 * is the invoice PLUS the corridor's fee (`quoteRfq.ts`). So the same instinct —
 * "send everything I have" — is unfundable here by exactly the spread, and the
 * two tests below are the refusal and the amount that does fit, which is what a
 * product's "send max" button has to compute.
 *
 * These run last on purpose: the second one locks up every remaining sat, and a
 * corridor lockup has no cancel to hand it back.
 */
describe("a corridor drain (regtest)", () => {
    /** The solver's spread — what the give leg carries and the take leg does not. */
    const SPREAD = 10;

    it("refuses an invoice for the whole balance, by exactly the corridor fee", async () => {
        const { available } = await wallet.getBalance();
        expect(available).toBeGreaterThan(SPREAD);

        // Asking the payee to receive everything asks this wallet for everything
        // plus the fee.
        const client = clientOn({ from: available + SPREAD, to: available });
        await expect(client.pay(invoiceFor(PAYMENT_HASH, available))).rejects.toBeInstanceOf(
            InsufficientFunds,
        );

        // And it is refused before the lockup is funded, not after: the balance
        // is untouched, which is the whole value of checking at `accept` time.
        expect((await wallet.getBalance()).available).toBe(available);
        await client[Symbol.asyncDispose]();
    }, 180_000);

    it("funds the drain that leaves the fee behind", async () => {
        const { available } = await wallet.getBalance();
        const payee = available - SPREAD;

        const client = clientOn({ from: available, to: payee });
        const result = await client.pay(invoiceFor(PAYMENT_HASH, payee));

        expect(result.kind).toBe("swap");
        if (result.kind !== "swap") return;
        expect(result.swap.give.amount).toBe(BigInt(available));
        expect(result.swap.take.amount).toBe(BigInt(payee));
        expect(result.swap.fundingTxid).toEqual(expect.any(String));

        // Every sat is in the lockup now — owned, escrowed, and out of generic
        // reach, the same shape the offer drain leaves behind.
        await waitFor(async () => (await wallet.getBalance()).available === 0);
        await client[Symbol.asyncDispose]();
    }, 180_000);
});
