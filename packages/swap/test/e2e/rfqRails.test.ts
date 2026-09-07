/**
 * The two ways a payment rail declines, against the real stack. The unit suite
 * asserts both against a `SwapRailClient` stubbed to answer `eligible: 0` — a
 * value the real client did not produce for an in-pair route until this
 * branch's bounds fix, so the stub was pinning a number rather than a
 * behaviour. Here the refusal comes from the real `resolve()`, and the exit
 * that takes over is priced by arkd's own fee schedule.
 *
 * The `rfq` prefix is the routing, not the subject — see `rfqVerbs.test.ts`.
 * `lightningSendContract` needs the seconds-typed `swap-rfq` profile.
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
    SingleKey,
    Wallet,
} from "@arkade-os/sdk";
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import {
    LIGHTNING_SEND_PAIR,
    lightningSendContract,
    unilateralClaimDelay,
    type RfqQuote,
} from "../../src/protocol";
import {
    type AttestingRfqTransport,
    createSwapClient,
    createSwapPaymentRouter,
    InMemoryAssetSwapRepository,
    LIGHTNING_RAIL,
    ONCHAIN_SWAP_RAIL,
    type SwapClient,
} from "../../src";
import { encodeInvoice } from "../helpers/bolt11";

const OPERATOR_URL = "http://localhost:7070";
const ESPLORA_API_URL = "http://localhost:3000/api";
const arkdExec = "docker exec -t arkd";

const FAUCET_SATS = 30_000;
const LOCKUP_SATS = 1_000;
const INVOICE_SATS = 990;

/**
 * The onchain card's window, and the three sizes around it. Its floor is well
 * clear of `ONCHAIN_DUST_SATS` plus the claim fee the rail grosses up by, so
 * `UNDER_FLOOR_SATS` is refused by the CARD rather than by the rail's own dust
 * check — otherwise that case would pass for the wrong reason.
 */
const MIN_ONCHAIN_SATS = 5_000;
const MAX_ONCHAIN_SATS = 50_000;
const OVER_CEILING_SATS = MAX_ONCHAIN_SATS * 10;
const IN_RANGE_SATS = 20_000;
const UNDER_FLOOR_SATS = 1_000;

/** Somewhere for the exit to pay; the regtest node's own is not needed. */
const BCRT1 = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";

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

const cardOn = (
    quoteCorridor: "lightning" | "onchain",
    min: number,
    max: number,
): DiscoveredMarket =>
    ({
        pair: `BTC/${quoteCorridor}:BTC`,
        base_asset: { id: "btc", name: "Bitcoin", ticker: "BTC", decimals: 8 },
        quote_asset: { id: "btc", name: "Bitcoin", ticker: "BTC", decimals: 8 },
        base_corridor: "arkade",
        quote_corridor: quoteCorridor,
        fee_bps: 0,
        min_base_amount: String(min),
        max_base_amount: String(max),
        min_quote_amount: String(min),
        max_quote_amount: String(max),
        solver: "stub",
        source: "https://registry.example/regtest.json",
        sourceType: "registry",
        discovery_pubkey: DISCOVERY_KEY,
        transports: { nostr: { relays: ["wss://relay.invalid"] } },
    }) as unknown as DiscoveredMarket;

// The lightning card keeps a low floor: the expiry case quotes a 990 sat invoice.
const CARDS = [
    cardOn("lightning", 100, MAX_ONCHAIN_SATS),
    cardOn("onchain", MIN_ONCHAIN_SATS, MAX_ONCHAIN_SATS),
];

const invoice = (): string =>
    encodeInvoice({
        prefix: "lnbcrt",
        amount: `${INVOICE_SATS * 10}n`,
        timestamp: NOW() - 60,
        expiry: 7_200,
        paymentHash: PAYMENT_HASH,
    });

/** The `rfqVerbs` stub's send leg, with the quote's lifetime opened up. */
const stubTransport = (validForSeconds: number): AttestingRfqTransport => ({
    attestedResponder: DISCOVERY_KEY,
    async requestQuote(payload) {
        const profile = (payload as { profile: Record<string, unknown> }).profile;
        const refundLocktime = NOW() + 200 * 3600;
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
            v: 1,
            type: "rfq_quote",
            rfq_id: payload.rfq_id as string,
            solver_pubkey: hex.encode(SOLVER),
            valid_until: NOW() + validForSeconds,
            refund_locktime: refundLocktime,
            pair: LIGHTNING_SEND_PAIR,
            from_amount: LOCKUP_SATS,
            to_amount: INVOICE_SATS,
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

const clientOn = (validForSeconds = 3_600): SwapClient =>
    createSwapClient({
        wallet,
        repository,
        discovery: { snapshot: CARDS },
        transportFor: () => stubTransport(validForSeconds),
    });

beforeAll(async () => {
    wallet = await Wallet.create({
        identity: SingleKey.fromRandomBytes(),
        arkServerUrl: OPERATOR_URL,
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

describe("a rail that refuses (regtest)", () => {
    it("keeps the swap rail for a size the card serves, ranked ahead of the exit", async () => {
        const client = clientOn();
        const router = createSwapPaymentRouter(wallet, client, { claimFeeRateSatVb: 2 });

        const options = await router.options({ raw: BCRT1, amount: IN_RANGE_SATS });

        expect(options.map((o) => o.railId)).toEqual([ONCHAIN_SWAP_RAIL, "onchain"]);
        await client[Symbol.asyncDispose]();
    }, 120_000);

    it("drops it past the card's ceiling and lets the real exit win, with no error", async () => {
        const client = clientOn();
        const router = createSwapPaymentRouter(wallet, client, { claimFeeRateSatVb: 2 });

        // The refusal is network-free: no solver hears this amount.
        const resolution = await client.resolve({
            to: BCRT1,
            amount: BigInt(OVER_CEILING_SATS),
            amountOn: "take",
        });
        expect(resolution.eligible).toBe(0);

        const options = await router.options({ raw: BCRT1, amount: OVER_CEILING_SATS });
        expect(options.map((o) => o.railId)).toEqual(["onchain"]);

        // And the fallback is a real quote: arkd's own fee schedule priced it.
        const quote = await router.route({ raw: BCRT1, amount: OVER_CEILING_SATS });
        expect(quote.railId).toBe("onchain");
        expect(quote.amount).toBe(OVER_CEILING_SATS);
        expect(quote.total).toBe(quote.amount + quote.fee);

        await client[Symbol.asyncDispose]();
    }, 120_000);

    it("refuses a size under the card's floor the same way", async () => {
        const client = clientOn();
        const router = createSwapPaymentRouter(wallet, client, { claimFeeRateSatVb: 2 });

        // Clear of the rail's own dust check even after the claim-fee gross-up,
        // so it is the CARD refusing this size and not the rail.
        const resolution = await client.resolve({
            to: BCRT1,
            amount: BigInt(UNDER_FLOOR_SATS),
            amountOn: "take",
        });
        expect(resolution.eligible).toBe(0);

        const options = await router.options({ raw: BCRT1, amount: UNDER_FLOOR_SATS });
        expect(options.map((o) => o.railId)).toEqual(["onchain"]);
        await client[Symbol.asyncDispose]();
    }, 120_000);
});

describe("a quote that expires (regtest)", () => {
    it("fails the send with QuoteExpired, having funded nothing", async () => {
        const client = clientOn(2);
        const router = createSwapPaymentRouter(wallet, client, { claimFeeRateSatVb: 2 });
        const before = (await repository.getAllSwapRecords()).length;

        const quote = await router.route({ raw: invoice() });
        expect(quote.railId).toBe(LIGHTNING_RAIL);
        const expiresAt = quote.meta?.expiresAt as number;
        expect(expiresAt).toBeGreaterThan(0);

        // Against the quote's own deadline, so this cannot race it.
        await waitFor(async () => NOW() > expiresAt, { timeout: 30_000, interval: 250 });

        const handle = await quote.send();
        const seen: { status: string; error?: unknown }[] = [];
        handle.subscribe((u) => seen.push({ status: u.status, error: u.error }));

        // Bounded: a refusal is immediate, so a client that funds instead fails
        // here by name rather than by running the whole case out of time.
        await expect(handle.settled({ timeoutMs: 30_000 })).rejects.toMatchObject({
            name: "QuoteExpired",
        });
        expect(seen.at(-1)).toMatchObject({ status: "failed" });
        expect((seen.at(-1)?.error as Error).name).toBe("QuoteExpired");
        // The refusal came before persistence, which is the whole point of it.
        expect(await repository.getAllSwapRecords()).toHaveLength(before);

        await client[Symbol.asyncDispose]();
    }, 180_000);
});
