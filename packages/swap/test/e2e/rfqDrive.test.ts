/**
 * The v2 client's drive against the real regtest stack.
 *
 * What the unit suite cannot prove, and this can: the record bridge works
 * against a real repository, a real contract row and a real indexer. `accept()`
 * writes into the v2 keyspace, and `RfqSwapManager.restoreFromRepository` reads
 * `getAllRfqSwaps()` — two stores that `repository.ts` rules disjoint by design.
 * So a SECOND client built on the same storage either finds the swap and drives
 * it to an outcome, or the whole lifecycle is standing on an empty set.
 *
 * Same stack and same stub-solver posture as `rfqRegister.test.ts`: the solver
 * quotes back the maker's OWN derivation, which is all the trust model lets a
 * maker use from a quote anyway. Nothing here fills a swap — a fill needs a
 * solver that pays the invoice — so what is real is everything the maker side
 * does: arkd's parameters, the covenant, the contract row, the funding
 * transaction, the indexer sync, and the drive's own reading of the lockup.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { execSync } from "child_process";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    ArkAddress,
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    REGTEST_EMULATOR_PUBKEY,
    RestIndexerProvider,
    SingleKey,
    Wallet,
} from "@arkade-os/sdk";
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import { sha256 } from "@noble/hashes/sha2.js";
import {
    LIGHTNING_SEND_PAIR,
    lightningSendContract,
    unilateralClaimDelay,
    type RfqQuote,
} from "../../src";
// The v2 client is still internal to the package — `src/index.ts` exports the
// v1 facade under the same name — so it is imported by path, as the unit suite
// does. M8 is what slims the root export to the v2 surface.
import { createSwapClient, type SwapClient } from "../../src/client/client";
import type { SwapUpdate } from "../../src/client/outcome";
import { InMemoryAssetSwapRepository } from "../../src/repository";
import type { AttestingRfqTransport } from "../../src/client/transport";
import type { CorridorSwapRecord } from "../../src/client/record";
import { encodeInvoice } from "../helpers/bolt11";

const OPERATOR_URL = "http://localhost:7070";
const ESPLORA_API_URL = "http://localhost:3000/api";
const arkdExec = "docker exec -t arkd";

const FAUCET_SATS = 30_000;
const LOCKUP_SATS = 1_000;

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

const indexer = new RestIndexerProvider(OPERATOR_URL);
let wallet: Wallet;
let emulatorPubkey: Uint8Array;
let operatorPubkey: Uint8Array;
let claimDelay: number;
let hrp: string;

const NOW = () => Math.floor(Date.now() / 1000);

/** The solver's key: this side never signs with it, it only binds the script. */
const SOLVER = schnorr.getPublicKey(new Uint8Array(32).fill(7));
const RECEIVER_PK_SCRIPT = Uint8Array.from([0x51, 0x20, ...SOLVER]);
const PREIMAGE = new Uint8Array(32).fill(11);
const PAYMENT_HASH = hex.encode(sha256(PREIMAGE));
const DISCOVERY_KEY = hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(4)));

/** The card the client resolves the route against. Injected, not fetched: the
 * registry is not part of what this exercises. */
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
    // A corridor card with no relays is unaddressable and is dropped from the
    // candidate set. Never dialled here — `transportFor` is injected — but the
    // card has to be one the client would be able to reach.
    transports: { nostr: { relays: ["wss://relay.invalid"] } },
} as unknown as DiscoveredMarket;

/** The invoice the send route is quoted against. */
const invoice = (): string =>
    encodeInvoice({
        prefix: "lnbcrt",
        amount: "10u",
        timestamp: NOW() - 60,
        expiry: 7_200,
        paymentHash: PAYMENT_HASH,
    });

/**
 * A solver that quotes back the maker's own derivation, and attests to the
 * card's own key so the responder check runs for real rather than being
 * skipped.
 */
const stubTransport = (): AttestingRfqTransport => ({
    attestedResponder: DISCOVERY_KEY,
    async requestQuote(payload) {
        const profile = (payload as { profile: Record<string, unknown> }).profile;
        // Far enough out to clear the send leg's headroom gate against the
        // invoice's own expiry.
        const refundLocktime = NOW() + 200 * 3600;
        const contract = lightningSendContract({
            solverPubkey: SOLVER,
            refundLocktime,
            operatorPubkey,
            paymentHash: PAYMENT_HASH,
            claimDelay,
            emulatorPubkey,
            senderPubkey: hex.decode(profile.client_refund_pubkey as string),
            receiverPkScript: RECEIVER_PK_SCRIPT,
            refundPkScript: ArkAddress.decode(profile.refund_address as string).pkScript,
        });
        return {
            v: 1,
            type: "rfq_quote",
            rfq_id: payload.rfq_id as string,
            pair: LIGHTNING_SEND_PAIR,
            from_amount: LOCKUP_SATS,
            to_amount: LOCKUP_SATS,
            solver_pubkey: hex.encode(SOLVER),
            valid_until: NOW() + 3600,
            refund_locktime: refundLocktime,
            profile: {
                receiver_pk_script: hex.encode(RECEIVER_PK_SCRIPT),
                lockup_address: contract.address(hrp, operatorPubkey).encode(),
            },
        } satisfies RfqQuote;
    },
    async status() {
        return null;
    },
    async close() {},
});

/** One storage, shared across both clients: that sharing IS the bridge test. */
const repository = new InMemoryAssetSwapRepository();

const clientOn = (): SwapClient =>
    createSwapClient({
        wallet,
        repository,
        discovery: { snapshot: [CARD] },
        transportFor: () => stubTransport(),
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

    // The stub has to derive the same script the maker will, so it reads the
    // server through the same seam the quote path uses.
    const info = await wallet.getArkadeInfo();
    operatorPubkey = xOnly(hex.decode(info.signerPubkey));
    claimDelay = unilateralClaimDelay(Number(info.unilateralExitDelay));
    hrp = ArkAddress.decode(address).hrp;
    emulatorPubkey = xOnly(hex.decode(REGTEST_EMULATOR_PUBKEY));
}, 180_000);

describe("the v2 drive (regtest)", () => {
    let swapId: string;
    let lockupScript: string;

    it("persists, funds and adopts an accepted swap", async () => {
        const client = clientOn();
        const seen: SwapUpdate[] = [];
        client.onUpdate((update) => seen.push(update));

        const quote = await client.quote({ to: invoice() });
        const swap = await client.accept(quote);
        swapId = swap.id;

        // The record is durable and the funding is broadcast, and NOTHING has
        // read the lockup yet: `accept()` returns once the record is at rest and
        // does not wait on a pass.
        expect(swap.fundingTxid).toEqual(expect.any(String));
        expect(swap.outcome).toBe("funding");

        const stored = (await repository.getSwapRecord(swapId)) as CorridorSwapRecord;
        expect(stored.family).toBe("rfq");
        lockupScript = stored.lockupPkScript;

        // The row that makes the record rebuildable was written before the
        // address could be funded.
        const contracts = await wallet.getContractManager();
        const [row] = await contracts.getContracts({ script: lockupScript });
        expect(row?.address).toBe(stored.lockupAddress);

        // And the drive adopts it: the first pass reads the real lockup off the
        // real indexer and the swap becomes `funded`.
        await waitFor(async () => seen.some((u) => u.outcome === "funded"));
        await client[Symbol.asyncDispose]();
    }, 180_000);

    it("finds that swap again from a second client's construction restore", async () => {
        // The bridge, end to end. `accept()` wrote `saveSwapRecord`; the manager
        // restores from `getAllRfqSwaps()`; and the two stores are disjoint by
        // design — so without the adapter this client sees nothing at all.
        const client = clientOn();
        const seen: SwapUpdate[] = [];
        client.onUpdate((update) => seen.push(update));

        await client.ready;
        await waitFor(async () => seen.some((u) => u.swap.id === swapId && u.outcome === "funded"));

        const update = seen.filter((u) => u.swap.id === swapId).at(-1);
        // The raw word underneath is the manager's own, read from chain rather
        // than replayed off the record.
        expect(update?.detail).toMatchObject({ family: "rfq", state: "pending" });
        expect(update?.swap.fundingTxid).toEqual(expect.any(String));
        await client[Symbol.asyncDispose]();
    }, 180_000);

    it("reconciles two drivers on one seed rather than corrupting the record", async () => {
        // §3's rule, against the real store: concurrent drivers are WASTEFUL,
        // not unsafe. Both read the same lockup, both reach the same verdict,
        // and every push either of them could make is evidence-gated — so the
        // worst case is a duplicate round trip, never two records or a state
        // one of them invented.
        const a = clientOn();
        const b = clientOn();
        const seenA: SwapUpdate[] = [];
        const seenB: SwapUpdate[] = [];
        a.onUpdate((u) => seenA.push(u));
        b.onUpdate((u) => seenB.push(u));

        await Promise.all([a.ready, b.ready]);
        await waitFor(async () =>
            [seenA, seenB].every((seen) =>
                seen.some((u) => u.swap.id === swapId && u.outcome === "funded"),
            ),
        );

        // One record, and it is still the one `accept()` wrote: the manager's
        // mutable half is merged onto the v2 record rather than replacing it.
        const records = await repository.getAllSwapRecords();
        expect(records.filter((r) => r.id === swapId)).toHaveLength(1);
        const stored = (await repository.getSwapRecord(swapId)) as CorridorSwapRecord;
        expect(stored.lockupPkScript).toBe(lockupScript);
        expect(stored.state).toBe("pending");

        await a[Symbol.asyncDispose]();
        await b[Symbol.asyncDispose]();
    }, 180_000);

    it("leaves the record and the contract row behind when it disposes", async () => {
        // Dispose is terminal for the instance and for nothing else: a new
        // client restores and resumes, and dropping the registration would
        // unwatch a funded lockup.
        const stored = await repository.getSwapRecord(swapId);
        expect(stored).toBeDefined();

        const contracts = await wallet.getContractManager();
        const [row] = await contracts.getContracts({ script: lockupScript });
        expect(row).toBeDefined();

        const { vtxos } = await indexer.getVtxos({ scripts: [lockupScript] });
        expect(vtxos.length).toBeGreaterThan(0);
    }, 60_000);
});
