/**
 * E2E — `lightning:BTC->arkade:BTC` against the REFERENCE SOLVER.
 *
 * This is the only test in the repo that can answer issue #712's second
 * acceptance question — "the claim reveals the preimage and the swap settles
 * end to end against the reference service" — because it is the only one where
 * the other side of the swap is the real solver rather than a stub of our own
 * making. Everything else on this corridor is unit-tested against fixtures we
 * wrote, which proves we agree with ourselves.
 *
 * WHAT THE ROUND TRIP PROVES, and why the last assertion is the whole point.
 * The solver never learns `P` from anyone: not from the request (which carries
 * only `H`), not from the claim packet (covclaimd cannot open this covenant
 * today — see the header of `claim.ts`), and not from us. The ONLY way it can
 * settle the payer's held HTLC is by reading `P` back out of the Arkade
 * transaction we used to claim its lockup. So when the payer's own Lightning
 * node reports its payment `SUCCEEDED` carrying a preimage equal, byte for
 * byte, to the `P` this test generated and never disclosed, that single
 * equality has transitively proved the entire corridor:
 *
 *   - our request produced a covenant the solver derived identically (it funded
 *     the address we derived locally, or nothing would ever have appeared);
 *   - our claim spent the collaborative leaf correctly and the Ark server
 *     accepted it;
 *   - `ConditionWitness` survived the round trip to the solver's reader;
 *   - and the payer actually paid, which is the only thing that makes any of
 *     the rest worth doing.
 *
 * No fake can establish that last step: a fake backend can only report what the
 * test told it. This is why the runbook below asks for real Lightning even
 * though the corridor would technically function against the solver's
 * file-backed fake.
 *
 * THE CLIENT CLAIMS, AND IT CLAIMS THROUGH `RfqSwapManager`. The covenant's
 * `receiver` is us, so the collaborative claim leaf (`preimage + receiver + ark
 * server`) is ours to spend with no covclaimd in the loop. Driving it through
 * the manager rather than calling `claimReceiveLockup` directly is deliberate:
 * the manager's receive arm is what an integrator actually runs, and its state
 * machine — funded-value gate, `claimed` on submission, `settled` only on a
 * hash-verified chain read — is exercised here against a real indexer instead
 * of a scripted one.
 *
 * ═══ PREREQUISITES ═══════════════════════════════════════════════════════════
 *
 * This test is OPT-IN and skips loudly without `SWAP_SOLVER_URL`, because it
 * needs a process the regtest stack does not start: the reference solver. The
 * rest of the `rfq*` suite must stay runnable without it.
 *
 * 1. The seconds-typed stack, NOT the offer one. RFQ covenants carry
 *    seconds-typed unilateral tiers and `unilateralClaimDelay` refuses a server
 *    exit delay below 512s, so the block-typed `swap` profile cannot serve this
 *    corridor at all. Switching profiles needs a RESET, not a `down` — they
 *    share ports:
 *
 *      pnpm run regtest:reset:swap-rfq
 *      pnpm run regtest:up:swap-rfq
 *      pnpm run regtest:setup:swap-rfq
 *
 * 2. The reference solver (`lightning-swap-service-nostr`), serving this
 *    corridor over HTTP, with its Arkade wallet FUNDED AND SETTLED — on this
 *    leg the SOLVER funds the lockup out of its own balance. Its own docs
 *    (`docs/runbook.md`) are authoritative; the short version, from a checkout
 *    beside this one and an env file copied from `.env.regtest.lnd.example`
 *    (which already points `LN_BACKEND=lnd` at the stack's `boltz-lnd`, and
 *    arkd/emulator at the ports above):
 *
 *      cd ../lightning-swap-service-nostr && pnpm install && pnpm build
 *      node --env-file=.env.regtest.lnd scripts/regtest-fund.mjs ../ts-sdk/regtest
 *      node --experimental-eventsource --env-file=.env.regtest.lnd \
 *        scripts/regtest-settle.mjs
 *      node --experimental-eventsource --env-file=.env.regtest.lnd dist/cli.js serve
 *
 *    Three things there are load-bearing rather than incidental. `serve` is the
 *    API PLUS the watch loop — a bare API host quotes and then never funds.
 *    `--experimental-eventsource` is required, not optional: without it the
 *    Arkade SDK's `ContractWatcher` throws out of its listen loop and the
 *    process changes nothing while looking healthy. And the wallet must be
 *    SETTLED, not merely funded, because preconfirmed balance cannot fund a
 *    lockup.
 *
 * 3. Both LND nodes up with a live channel between them — `boltz-lnd` is the
 *    solver's own node and `lnd` is the free counterparty that plays the payer:
 *
 *      docker exec lnd lncli --network=regtest listchannels
 *
 * 4. Then:
 *
 *      SWAP_SOLVER_URL=http://localhost:8787 \
 *        pnpm run regtest:test:swap-rfq test/e2e/rfqLightningReceive.test.ts
 *
 * ═══ TIMING ══════════════════════════════════════════════════════════════════
 *
 * Two of the solver's constants bound this test and are worth knowing before
 * reading a failure as a bug:
 *
 *   - the hold invoice's window is 10 minutes (`DEFAULT_HOLD_INVOICE_WINDOW`),
 *     so a test paused at a breakpoint past that point fails at the payment,
 *     not in our code;
 *   - the solver refuses to fund unless the held HTLC has at least 90 minutes
 *     left before its CLTV timeout (`MIN_SETTLE_WINDOW`). That is a property of
 *     the PAYER's route, so `settle_window_too_short` in the solver's log means
 *     the channel's CLTV delta, not this test.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import bolt11 from "light-bolt11-decoder";
import {
    ArkAddress,
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    RestEmulatorProvider,
    RestIndexerProvider,
    SingleKey,
    Wallet,
} from "@arkade-os/sdk";
import {
    RfqSwapManager,
    httpTransport,
    paymentHashOf,
    preimageForRfqSecrets,
    pushClaim,
    requestLightningReceive,
    senderIdentityForRfqSecrets,
    type InvoiceFacts,
    type LightningReceiveSwap,
    type RfqSwapManagerCallbacks,
} from "../../src";

const ARK_URL = "http://localhost:7070";
const EMULATOR_URL = "http://localhost:7073";
const ESPLORA_API_URL = "http://localhost:3000/api";

/** The opt-in. Absent, this file skips — see the header. */
const SOLVER_URL = process.env.SWAP_SOLVER_URL;
/** The payer: the stack's free LND node, the one the solver does NOT use. */
const PAYER_CONTAINER = process.env.E2E_LN_COUNTERPARTY_CONTAINER ?? "lnd";

/** What we ask to RECEIVE. The solver's fee rides on top, so the invoice the
 * payer is asked for is larger — which is exactly what `maxPayAmount` bounds. */
const RECEIVE_SATS = 5_000;
/** A deliberately generous ceiling: this asserts the gate is wired, not that we
 * can predict the reference solver's fee schedule. */
const MAX_PAY_SATS = 25_000;

const run = promisify(execFile);

/**
 * covclaimd's key, and it is a placeholder ON PURPOSE.
 *
 * `requestLightningReceive` requires one because the claim packet seals `P` to
 * it, but covclaimd cannot claim this covenant today, so nothing ever opens
 * what we seal here — the packet rides the wire inert. A test that stood up a
 * real covclaimd would be asserting nothing more, and would add a dependency
 * the corridor does not have.
 */
const COVCLAIMD_PUBKEY = secp256k1.getPublicKey(new Uint8Array(32).fill(11), true);

/**
 * The caller-supplied BOLT11 decoder the corridor requires (D6).
 *
 * `@arkade-os/swap` ships no BOLT11 dependency — the invoice on this leg is the
 * SOLVER's, so the SDK owns the comparison and the caller owns the parsing.
 * This is a devDependency for exactly that reason: it stands in for the decoder
 * an integrator already has, and importing it here does not put one in the
 * package's dependency graph.
 */
const decodeInvoice = (raw: string): InvoiceFacts => {
    const decoded = bolt11.decode(raw);
    const section = (name: string): unknown =>
        decoded.sections.find((s: { name: string }) => s.name === name)?.value;
    const millisats = BigInt((section("amount") as string | undefined) ?? "0");
    return {
        raw,
        paymentHash: String(section("payment_hash") ?? ""),
        amountSats: Number(millisats / 1000n),
        expiresAt: Number(section("timestamp") ?? 0) + (decoded.expiry ?? 3600),
    };
};

const xOnly = (key: Uint8Array): Uint8Array => (key.length === 32 ? key : key.slice(1));

/** One `lncli` round trip in the payer's container, parsed as JSON. */
const lncli = async <T>(args: readonly string[]): Promise<T> => {
    const { stdout } = await run(
        "docker",
        ["exec", PAYER_CONTAINER, "lncli", "--network=regtest", ...args],
        { timeout: 30_000 },
    );
    return JSON.parse(stdout) as T;
};

interface PaymentView {
    payment_hash: string;
    status: "IN_FLIGHT" | "SUCCEEDED" | "FAILED" | "INITIATED";
    /** `P`, hex — all zeroes until the payment succeeds. */
    payment_preimage: string;
}

/**
 * Pay a HOLD invoice, and do not wait for it.
 *
 * A hold invoice does not settle when it is paid — that is the point of one —
 * so `payinvoice` blocks for as long as the solver holds the HTLC, which here
 * is the whole rest of the test. Detached, unref'd, and with its `error` event
 * swallowed: an unhandled one would take vitest's fork down with it.
 */
const payFromCounterparty = (invoice: string): { stop: () => void } => {
    const child = spawn(
        "docker",
        [
            "exec",
            PAYER_CONTAINER,
            "lncli",
            "--network=regtest",
            "payinvoice",
            "--force",
            "--timeout",
            "600s",
            invoice,
        ],
        { stdio: "ignore" },
    );
    child.unref();
    child.on("error", () => {});
    return { stop: () => !child.killed && child.kill() };
};

const paymentOf = async (paymentHash: string): Promise<PaymentView | null> => {
    const listed = await lncli<{ payments: PaymentView[] }>([
        "listpayments",
        "--include_incomplete",
        "--max_payments",
        "200",
    ]);
    return listed.payments.find((payment) => payment.payment_hash === paymentHash) ?? null;
};

const waitFor = async (
    fn: () => Promise<boolean>,
    { timeout = 120_000, interval = 1_000, what = "condition" } = {},
): Promise<void> => {
    const start = Date.now();
    let last: unknown;
    while (Date.now() - start < timeout) {
        try {
            if (await fn()) return;
        } catch (error) {
            last = error;
        }
        await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
};

if (!SOLVER_URL) {
    // Loud, never silent: a suite that quietly passes with nothing connected
    // rots into one that cannot pass at all, and nobody finds out for months.
    console.warn(
        "\n[rfqLightningReceive] SKIPPED — set SWAP_SOLVER_URL to run this against the reference solver.\n" +
            "  It needs the seconds-typed `swap-rfq` stack, the solver's `serve` with its Arkade wallet funded,\n" +
            "  and both LND nodes channelled. See this file's header for the runbook.\n",
    );
}

let wallet: Wallet;
let emulatorPubkey: Uint8Array;
const indexer = new RestIndexerProvider(ARK_URL);
const ark = new RestArkProvider(ARK_URL);

describe.skipIf(!SOLVER_URL)("lightning:BTC -> arkade:BTC against the reference solver", () => {
    beforeAll(async () => {
        wallet = await Wallet.create({
            identity: SingleKey.fromRandomBytes(),
            arkServerUrl: ARK_URL,
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

        // Stands in for the one-time, out-of-band read of the solver's registry
        // card that a real integration does before ever calling this.
        const emulatorInfo = await new RestEmulatorProvider(EMULATOR_URL).getInfo();
        emulatorPubkey = xOnly(hex.decode(emulatorInfo.signerPubkey));

        // Nothing funds this wallet, deliberately. On the receive leg the trader
        // pays over Lightning and the solver funds the Arkade side, so a client
        // with an empty Arkade balance must be able to complete the whole swap
        // — and if some path ever starts needing local sats, this is where it
        // surfaces rather than being masked by a faucet call.
    }, 120_000);

    it("receives over Lightning: quote, pay, claim, and the solver settles with our own preimage", async () => {
        const swap = await requestLightningReceive(
            wallet,
            ARK_URL,
            emulatorPubkey,
            httpTransport(SOLVER_URL as string),
            {
                amount: RECEIVE_SATS,
                amountSide: "to",
                covclaimdPubkey: COVCLAIMD_PUBKEY,
                decodeInvoice,
                maxPayAmount: MAX_PAY_SATS,
            },
        );

        // `P` is ours and has never left this process. Everything below turns on
        // that staying true until our own claim publishes it.
        const preimage = await preimageForRfqSecrets(wallet, swap.secrets);
        const paymentHash = paymentHashOf(preimage);

        // The invoice gate had something real to check: this is the solver's
        // own BOLT11, and it commits to OUR hash for the amount it quoted.
        // `requestLightningReceive` already refused every other case before
        // returning — asserting it here says the fixture-level tests were
        // describing this wire, not one of our own invention.
        const decoded = decodeInvoice(swap.invoice);
        expect(decoded.paymentHash).toBe(paymentHash);
        expect(decoded.amountSats).toBe(swap.payAmount);
        expect(swap.payAmount).toBeGreaterThanOrEqual(swap.expectedAmount);
        expect(swap.expectedAmount).toBe(RECEIVE_SATS);
        expect(swap.invoiceExpiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

        // The lockup is watched before a payer can be shown the invoice — the
        // ordering `requestLightningReceive` guarantees, checked against a real
        // contract manager rather than a mock.
        const contracts = await wallet.getContractManager();
        const [row] = await contracts.getContracts({ script: hex.encode(swap.swapPkScript) });
        expect(row?.address).toBe(swap.address);

        // Nothing is funded yet: the solver funds only once the HTLC is held.
        // `vtxos` is read defensively because the wire permits it absent for a
        // script with no history, and an assertion that cannot tell "empty"
        // from "not answered" would fail for the wrong reason.
        const atLockup = await indexer.getVtxos({ scripts: [hex.encode(swap.swapPkScript)] });
        expect(atLockup.vtxos ?? []).toHaveLength(0);

        const payer = payFromCounterparty(swap.invoice);
        try {
            // The payment is IN_FLIGHT and stays there: a hold invoice is not
            // settled by being paid. If this never arrives the solver never
            // funds, and the failure is the payer's route rather than ours.
            await waitFor(async () => (await paymentOf(paymentHash))?.status === "IN_FLIGHT", {
                timeout: 60_000,
                what: "the payer's HTLC to reach the solver",
            });

            // Optional on `RfqQuote`, so it is checked rather than asserted
            // away: `requestLightningReceive` already refused a quote without
            // it, and a silent `undefined` here would make the manager's whole
            // claim window meaningless.
            const refundLocktime = swap.quote.refund_locktime;
            expect(typeof refundLocktime).toBe("number");

            const record: LightningReceiveSwap = {
                kind: "lightning_receive",
                rfqId: swap.rfqId,
                state: "pending",
                lockupPkScript: swap.swapPkScript,
                lockup: { script: swap.script, address: swap.address },
                paymentHash,
                refundLocktime: refundLocktime as number,
                expectedAmount: swap.expectedAmount,
                createdAt: Math.floor(Date.now() / 1000),
                updatedAt: Math.floor(Date.now() / 1000),
            };

            const refused = (what: string) => async (): Promise<never> => {
                throw new Error(`${what} must never be called on a receive swap`);
            };
            const callbacks: RfqSwapManagerCallbacks = {
                // Neither of these belongs to this leg. Wired to throw rather
                // than omitted, so a regression that starts calling them fails
                // the test instead of passing quietly.
                claimOnchain: refused("claimOnchain"),
                refundArkade: refused("refundArkade"),
                async claimLockup(_swap, vtxos, options) {
                    return pushClaim(ark, {
                        script: swap.script,
                        receiver: await senderIdentityForRfqSecrets(wallet, swap.secrets),
                        preimage,
                        vtxos,
                        destinationPkScript: ArkAddress.decode(swap.payoutAddress).pkScript,
                        expectedAmount: swap.expectedAmount,
                        partiallyClaimed: options.partiallyClaimed,
                    });
                },
                async saveSwap() {},
            };

            const manager = new RfqSwapManager({ indexer, contracts }, { pollIntervalMs: 2_000 });
            manager.setCallbacks(callbacks);
            await manager.start([record]);
            try {
                // Resolves on `settled` — a hash-verified spend read off chain —
                // and NOT on our own submission, which is why this is proof the
                // claim landed rather than proof we sent one.
                const outcome = await manager.waitForSwapCompletion(swap.rfqId);
                expect(outcome.state).toBe("settled");
                // Our own claim is what settled it. Asserted as defined first,
                // because covclaimd claiming instead would also reach `settled`
                // with no txid of ours — a pass this test must not accept
                // silently, since it would mean the client path never ran.
                expect(record.claimArkTxid).toBeDefined();
                expect(outcome.txid).toBe(record.claimArkTxid);
            } finally {
                await manager.stop();
            }

            // The sats are ours, at our own payout address, and spendable.
            await waitFor(async () => (await wallet.getBalance()).total >= swap.expectedAmount, {
                what: "the claimed sats to land in the wallet",
            });

            // ── The round trip ───────────────────────────────────────────────
            //
            // The solver could only have settled by reading `P` out of the
            // Arkade transaction that claimed its lockup. The payer's node is
            // the one place that fact is observable from outside both
            // implementations, and this equality is what closes the corridor.
            await waitFor(async () => (await paymentOf(paymentHash))?.status === "SUCCEEDED", {
                what: "the solver to settle the held HTLC with the recovered preimage",
            });
            const payment = await paymentOf(paymentHash);
            expect(payment?.payment_preimage).toBe(hex.encode(preimage));

            // And the solver says so itself, which also exercises the RFQ status
            // arm for a receive swap — the one that used to answer `unknown` for
            // every one of them because neither receive store was consulted.
            const status = await httpTransport(SOLVER_URL as string).status(swap.rfqId);
            expect(status?.state).toBe("settled");
        } finally {
            payer.stop();
        }
    }, 600_000);
});
