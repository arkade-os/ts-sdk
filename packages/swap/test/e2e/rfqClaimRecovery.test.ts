/**
 * A Lightning receive claim that arkd accepted but never finalized, recovered by the drive against
 * the real stack. The unit suite stubs the two arkd behaviours recovery rests on: the indexer
 * serving the accepted checkpoint with the operator's signature, and arkd taking a finalize sent
 * later, by another call, with that signature carried over. Here both are real.
 *
 * The trader's wallet submits two-step (`oneShotSubmit: false`) and the operator wrapper drops the
 * claim's finalize before it reaches arkd, as a crash between submit and finalize would. The solver
 * is a stub that quotes back the trader's own derivation (as in `rfqVerbs.test.ts`); arkd's CLI
 * wallet funds the lockup in its place.
 *
 * `rfq` prefix: the seconds-typed `swap-rfq` stack (see `.env.regtest.rfq`).
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
    RestOperatorProvider,
    SingleKey,
    Wallet,
} from "@arkade-os/sdk";
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import {
    LIGHTNING_RECEIVE_PAIR,
    lightningReceiveContract,
    unilateralClaimDelay,
    type RfqQuote,
} from "../../src/protocol";
import {
    createSwapClient,
    InMemoryAssetSwapRepository,
    quoteIdOfSwapId,
    type CorridorSwapRecord,
} from "../../src";
import { walletOperator, type SwapOperator } from "../../src/refund";
import type { AttestingRfqTransport } from "../../src/client/transport";
import { encodeInvoice } from "../helpers/bolt11";

const OPERATOR_URL = "http://localhost:7070";
const ESPLORA_API_URL = "http://localhost:3000/api";
const arkdExec = "docker exec -t arkd";

/** What the trader receives on Arkade, so what the lockup must carry. */
const RECEIVE_SATS = 2_000;
/** What the payer is invoiced; the stub's spread is the difference. */
const INVOICE_SATS = 2_010;

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
    { timeout = 90_000, interval = 500, what = "condition" } = {},
): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`timeout waiting for ${what}`);
};

const NOW = () => Math.floor(Date.now() / 1000);

const SOLVER = schnorr.getPublicKey(new Uint8Array(32).fill(7));
const SOLVER_PK_SCRIPT = Uint8Array.from([0x51, 0x20, ...SOLVER]);
const DISCOVERY_KEY = hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(4)));

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

const indexer = new RestIndexerProvider(OPERATOR_URL);
let wallet: Wallet;
let emulatorPubkey: Uint8Array;
let operatorPubkey: Uint8Array;
let claimDelay: number;
let hrp: string;

/** A solver that quotes back the trader's own receive derivation. */
const stubTransport = (): AttestingRfqTransport => ({
    attestedResponder: DISCOVERY_KEY,
    async requestQuote(payload) {
        const profile = (payload as { profile: Record<string, unknown> }).profile;
        const refundLocktime = NOW() + 200 * 3600;
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
            v: 1 as const,
            type: "rfq_quote" as const,
            rfq_id: payload.rfq_id as string,
            solver_pubkey: hex.encode(SOLVER),
            valid_until: NOW() + 3600,
            refund_locktime: refundLocktime,
            pair: LIGHTNING_RECEIVE_PAIR,
            from_amount: INVOICE_SATS,
            to_amount: RECEIVE_SATS,
            profile: {
                payment_hash: paymentHash,
                invoice: encodeInvoice({
                    prefix: "lnbcrt",
                    amount: `${INVOICE_SATS * 10}n`,
                    timestamp: NOW() - 60,
                    expiry: 7_200,
                    paymentHash,
                }),
                lockup_address: contract.address(hrp, operatorPubkey).encode(),
                solver_refund_pk_script: hex.encode(SOLVER_PK_SCRIPT),
            },
        } satisfies RfqQuote;
    },
    async status() {
        return null;
    },
    async close() {},
});

beforeAll(async () => {
    wallet = await Wallet.create({
        identity: SingleKey.fromRandomBytes(),
        arkProvider: new RestOperatorProvider(OPERATOR_URL),
        onchainProvider: new EsploraProvider(ESPLORA_API_URL, {
            forcePolling: true,
            pollingInterval: 2000,
        }),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        settlementConfig: false,
        // The path whose finalize can be lost: one-shot finalizes inside the submit.
        oneShotSubmit: false,
    });

    // arkd's CLI wallet stands in for the solver that funds the lockup.
    const note = execCommand(`${arkdExec} arkd note --amount 50000`);
    execCommand(`${arkdExec} ark redeem-notes -n ${note} --password secret`);

    const info = await wallet.getArkadeInfo();
    operatorPubkey = xOnly(hex.decode(info.signerPubkey));
    claimDelay = unilateralClaimDelay(Number(info.unilateralExitDelay));
    hrp = ArkAddress.decode(await wallet.getAddress()).hrp;
    emulatorPubkey = xOnly(hex.decode(REGTEST_EMULATOR_PUBKEY));
}, 180_000);

describe("a claim arkd accepted but never finalized (regtest)", () => {
    it("is finalized by the drive, and the receive settles with the sats spendable", async () => {
        // Nothing spendable to start: the closing balance has one possible cause.
        expect((await wallet.getBalance()).available).toBe(0);

        const base = walletOperator(wallet);
        const submitted: string[] = [];
        const finalizes: string[] = [];
        const landed: string[] = [];
        let released = false;
        const operator: SwapOperator = {
            getInfo: base.getInfo,
            submitTx: async (...args) => {
                const result = await base.submitTx(...args);
                submitted.push(result.arkTxid);
                return result;
            },
            // Every finalize is dropped before it reaches arkd until the test has seen the claim
            // pending; from then on they go through.
            finalizeTx: async (arkTxid, checkpoints) => {
                finalizes.push(arkTxid);
                if (!released) throw new Error("connection reset before the finalize reached arkd");
                await base.finalizeTx(arkTxid, checkpoints);
                landed.push(arkTxid);
            },
        };

        const repository = new InMemoryAssetSwapRepository();
        const client = createSwapClient({
            wallet,
            repository,
            operator,
            discovery: { snapshot: [CARD] },
            transportFor: () => stubTransport(),
        });

        const request = await client.receive({ amount: BigInt(RECEIVE_SATS), via: "lightning" });
        const stored = (await repository.getSwapRecord(
            quoteIdOfSwapId(request.id),
        )) as CorridorSwapRecord;
        const lockupScript = stored.lockupPkScript;

        execCommand(
            `${arkdExec} ark send --to ${stored.lockupAddress} --amount ${RECEIVE_SATS} --password secret`,
        );

        // The drive claims, arkd accepts the submit, and the finalize never arrives: the lockup
        // is spent by a claim arkd holds accepted, and no claimed sats exist yet.
        await waitFor(async () => finalizes.length > 0, { what: "the claim's dropped finalize" });
        expect(submitted).toHaveLength(1);
        const [claimTxid] = submitted;
        expect(finalizes[0]).toBe(claimTxid);
        const { vtxos: pending } = await indexer.getVtxos({
            scripts: [lockupScript],
            pendingOnly: true,
        });
        expect(pending.map((vtxo) => vtxo.arkTxId)).toEqual([claimTxid]);
        expect((await wallet.getBalance()).available).toBe(0);

        released = true;

        // The drive finds the claim pending and finalizes that same ark tx: no second claim.
        await waitFor(
            async () =>
                (await client.swaps()).find((swap) => swap.id === request.id)?.outcome ===
                "claimed",
            { what: "the receive to settle" },
        );
        expect(submitted).toEqual([claimTxid]);
        expect(landed).toEqual([claimTxid]);
        expect(
            (await indexer.getVtxos({ scripts: [lockupScript], pendingOnly: true })).vtxos,
        ).toEqual([]);
        await waitFor(async () => (await wallet.getBalance()).available >= RECEIVE_SATS, {
            what: "the claimed sats to be spendable",
        });

        await client[Symbol.asyncDispose]();
    }, 240_000);
});
