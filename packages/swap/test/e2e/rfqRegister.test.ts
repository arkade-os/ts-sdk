/**
 * The RFQ lockup against the real regtest stack: quote, derive, register,
 * fund — and check the wallet then treats the lockup as owned-but-escrowed.
 *
 * This is `swap.test.ts`'s escrow test for the other corridor, and the reason
 * it needs its own stack: `lightningSendVtxoScript` emits SECONDS-typed
 * timelocks on all three unilateral tiers, and `unilateralClaimDelay` refuses a
 * server exit delay below 512s — so on the offer suite's block-typed arkd
 * (`ARKD_UNILATERAL_EXIT_DELAY=20`) `requestLightningSend` throws before it
 * reaches a quote at all. See `packages/swap/.env.regtest.rfq`.
 *
 * The solver is a local stub, not the `solver` container: it quotes back the
 * maker's OWN derivation, which is all the trust model lets a maker use from a
 * quote anyway. Nothing here fills the swap — a fill needs a solver that pays
 * the invoice, which is a separate scope. What is real is everything the maker
 * side does: arkd's parameters, the covenant, the contract row, the funding
 * transaction, the indexer sync and the spendability gate.
 */
import { createServer } from "node:net";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { faucet } from "./harness";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    ArkAddress,
    contractSigner,
    provisionClaimSecret,
    isVtxoSpent,
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    REGTEST_EMULATOR_PUBKEY,
    RestArkProvider,
    RestIndexerProvider,
    SingleKey,
    Wallet,
} from "@arkade-os/sdk";
import {
    LIGHTNING_SEND_PAIR,
    InMemoryAssetSwapRepository,
    RfqSwapManager,
    arkadeRefunder,
    pushClaim,
    receiveVtxoScript,
    rfqSecretsProfile,
    type LightningReceiveSwap,
    SWAP_LOCKUP_CONTRACT_KIND,
    SWAP_LOCKUP_CONTRACT_LABEL,
    SWAP_LOCKUP_CONTRACT_TYPE,
    lightningSendVtxoScript,
    registerLockupContract,
    requestLightningSend,
    unilateralClaimDelay,
    type RfqQuote,
    type RfqTransport,
} from "../../src";

const OPERATOR_URL = process.env.ARK_URL ?? "http://localhost:7070";
const ESPLORA_API_URL = process.env.ESPLORA_URL ?? "http://localhost:3000/api";
const arkdExec = `docker exec -t ${process.env.ARKD_CONTAINER ?? "arkd"}`;

const FAUCET_SATS = 30_000;
const LOCKUP_SATS = 1_000;

/** Same rule as rfq.ts's own, kept local so this suite stays self-contained. */
const xOnly = (key: Uint8Array): Uint8Array => {
    if (key.length === 32) return key;
    if (key.length !== 33 || (key[0] !== 0x02 && key[0] !== 0x03)) {
        throw new Error("not a compressed or x-only public key");
    }
    return key.slice(1);
};

// expect.poll would do, but it refuses to run outside a test (the beforeAll
// faucet wait needs this too); vi.waitFor polls anywhere. vi.waitFor retries
// ANY throw until the deadline, so a real error from `fn` (stack down, HTTP
// 500) would burn the whole timeout: capture it, stop polling, rethrow at
// once — only a `false` (not ready yet) may spin.
const waitFor = (fn: () => Promise<boolean>, timeout = 30_000): Promise<void> => {
    let fatal: { err: unknown } | undefined;
    return vi
        .waitFor(
            async () => {
                if (fatal) return;
                let ready: boolean;
                try {
                    ready = await fn();
                } catch (err) {
                    fatal = { err };
                    return;
                }
                if (!ready) throw new Error("timeout in waitFor");
            },
            { timeout, interval: 500 },
        )
        .then(() => {
            if (fatal) throw fatal.err;
        });
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
const PAYMENT_HASH = "ab".repeat(32);

/**
 * A solver that quotes back the maker's own derivation. Everything binding in
 * the quote is echoed from the request or fixed here, so `verifyLockupAddress`
 * compares the maker's address against one built from the same inputs — the
 * check still runs for real, it just cannot fail for solver reasons.
 */
const stubTransport = (): RfqTransport => ({
    async requestQuote(payload) {
        const profile = (payload as { profile: Record<string, unknown> }).profile;
        const refundLocktime = NOW() + 24 * 3600;
        const refundWithoutReceiverDelay = Math.ceil((24 * 3600) / 512) * 512;
        const script = lightningSendVtxoScript({
            solverPubkey: SOLVER,
            refundLocktime,
            serverPubkey: operatorPubkey,
            paymentHash: PAYMENT_HASH,
            claimDelay,
            refundWithoutReceiverDelay,
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
                lockup_address: script.address(hrp, operatorPubkey).encode(),
                refund_without_receiver_delay: refundWithoutReceiverDelay,
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

    const address = await wallet.getAddress();
    faucet(arkdExec, [address], FAUCET_SATS);
    await waitFor(async () => (await wallet.getVtxos()).length > 0);

    // The stub solver has to derive the same script the maker will, so it needs
    // the same server-derived inputs `requestLightningSend` reads for itself.
    const info = await new RestArkProvider(OPERATOR_URL).getInfo();
    operatorPubkey = xOnly(hex.decode(info.signerPubkey));
    claimDelay = unilateralClaimDelay(Number(info.unilateralExitDelay));
    hrp = ArkAddress.decode(address).hrp;

    // the pinned regtest key: the stub solver derives with the same default
    // `requestLightningSend` resolves internally
    emulatorPubkey = xOnly(hex.decode(REGTEST_EMULATOR_PUBKEY));
}, 120_000);

describe("RFQ lockup registration (regtest)", () => {
    let swap: Awaited<ReturnType<typeof requestLightningSend>>;
    let lockupScript: string;

    it("registers the lockup before the maker can fund it", async () => {
        swap = await requestLightningSend(wallet, OPERATOR_URL, stubTransport(), {
            invoice: {
                raw: "lnbcrt10u1p",
                paymentHash: PAYMENT_HASH,
                amountSats: LOCKUP_SATS,
                expiresAt: NOW() + 2 * 3600,
            },
        });
        lockupScript = hex.encode(swap.swapPkScript);

        // Nothing has been funded at this point in the test, which is the whole
        // property: the row exists first, so a persistence failure would have
        // thrown while the maker still held its coins.
        const manager = await wallet.getContractManager();
        const [row] = await manager.getContracts({ script: lockupScript });
        expect(row).toBeDefined();
        expect(row?.type).toBe(SWAP_LOCKUP_CONTRACT_TYPE);
        expect(row?.address).toBe(swap.address);
        expect(row?.label).toBe(SWAP_LOCKUP_CONTRACT_LABEL);
        expect(row?.metadata).toEqual({
            genericallySpendable: false,
            kind: SWAP_LOCKUP_CONTRACT_KIND,
        });
    }, 120_000);

    it("escrows the funded lockup: owned and watched, never generically spendable", async () => {
        const fundingTxid = await wallet.send({
            address: swap.address,
            amount: swap.fundAmount,
        });

        await waitFor(async () => {
            const { vtxos } = await indexer.getVtxos({ scripts: [lockupScript] });
            return vtxos.some((v) => v.txid === fundingTxid);
        });

        // The funding tx also pays the maker's own change, so match the covenant
        // script too — by txid alone this picks up ordinary wallet money.
        const isLockup = (v: { txid: string; script: string }) =>
            v.txid === fundingTxid && v.script === lockupScript;
        // It syncs in through the contract row, which is what registration
        // bought: an unregistered script is not a script this wallet watches.
        await waitFor(async () => (await wallet.getVtxos()).some(isLockup));
        expect((await wallet.getSpendableVtxos()).some(isLockup)).toBe(false);

        const balance = await wallet.getBalance();
        expect(balance.settled + balance.preconfirmed).toBeGreaterThanOrEqual(LOCKUP_SATS);
        expect(balance.available).toBeLessThanOrEqual(FAUCET_SATS - LOCKUP_SATS);
    }, 120_000);

    it("takes the manager's backstop re-registration as a no-op", async () => {
        // `RfqSwapManager.ensureRegistered` still runs for records that predate
        // pre-funding registration; on a row that already exists it must not
        // throw, and must not rewrite what the funded row says.
        const manager = await wallet.getContractManager();
        const [before] = await manager.getContracts({ script: lockupScript });

        // `swap.script` is exactly what a caller hands the manager as the
        // record's `lockup.script`, so this is the backstop's real input.
        await registerLockupContract(manager, swap.script, swap.address);
        const [after] = await manager.getContracts({ script: lockupScript });
        expect(after).toEqual(before);
    }, 120_000);
});

describe("receive claim wiring recovery (regtest)", () => {
    it.each([
        ["all callbacks were missing", false],
        ["the claim callback was missing", true],
    ] as const)(
        "claims the funded lockup during an indexer outage after %s",
        async (_reason, otherCallbacks) => {
            const secrets = await provisionClaimSecret(wallet);
            const paymentHash = hex.encode(secrets.paymentHash);
            const payout = await wallet.getAddress();
            const payoutPkScript = ArkAddress.decode(payout).pkScript;
            const refundLocktime = NOW() + 3600;
            const script = receiveVtxoScript({
                solverPubkey: SOLVER,
                refundLocktime,
                serverPubkey: operatorPubkey,
                paymentHash,
                claimDelay,
                emulatorPubkey,
                solverRefundPkScript: RECEIVER_PK_SCRIPT,
                payoutPubkey: secrets.pubkey,
                payoutPkScript,
            });
            const address = script.address(hrp, operatorPubkey).encode();
            const contracts = await wallet.getContractManager();
            await registerLockupContract(contracts, script, address);
            const before = (await wallet.getBalance()).available;
            const fundingTxid = await wallet.send({ address, amount: LOCKUP_SATS });
            await waitFor(async () => {
                const [row] = await contracts.getContractsWithVtxos({
                    script: hex.encode(script.pkScript),
                });
                return (
                    row?.vtxos.some(
                        (coin) => coin.txid === fundingTxid && coin.value === LOCKUP_SATS,
                    ) ?? false
                );
            });

            const endpoint = createServer();
            await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
            const bound = endpoint.address();
            if (!bound || typeof bound === "string")
                throw new Error("outage endpoint did not bind");
            await new Promise<void>((resolve, reject) =>
                endpoint.close((error) => (error ? reject(error) : resolve())),
            );
            const unavailable = new RestIndexerProvider(`http://127.0.0.1:${bound.port}`);
            await expect(
                unavailable.getVtxos({ scripts: [hex.encode(script.pkScript)] }),
            ).rejects.toThrow();
            const repository = new InMemoryAssetSwapRepository();
            const manager = new RfqSwapManager({ indexer: unavailable, contracts, repository });
            const refundArkade = arkadeRefunder({
                ark: wallet.arkProvider,
                contracts,
                wallet,
                repository,
            });
            const swap: LightningReceiveSwap = {
                kind: "lightning_receive",
                rfqId: paymentHash,
                state: "pending",
                lockupPkScript: script.pkScript,
                lockup: { script, address },
                paymentHash,
                refundLocktime,
                expectedAmount: LOCKUP_SATS,
                createdAt: NOW(),
                updatedAt: NOW(),
            };
            await manager.addSwap(swap, {
                kind: "lightning_receive",
                lockupAddress: address,
                profile: {
                    ...rfqSecretsProfile(secrets, paymentHash),
                    expectedAmount: LOCKUP_SATS,
                    payoutAddress: payout,
                },
            });
            if (otherCallbacks) manager.setCallbacks({ refundArkade });
            try {
                await manager.poll();
                expect(swap.state).toBe("needs_counterparty");
                expect(swap.blockedReason).toBe(
                    otherCallbacks
                        ? "no claimLockup callback is wired, so this wallet cannot claim the lockup"
                        : "no callbacks are wired, so this wallet cannot claim the lockup",
                );
                const receiver = await contractSigner(wallet, secrets.descriptor);
                manager.setCallbacks({
                    refundArkade,
                    claimLockup: (current, vtxos, options) =>
                        pushClaim(wallet.arkProvider, {
                            script,
                            receiver,
                            preimage: secrets.preimage,
                            vtxos,
                            destinationPkScript: payoutPkScript,
                            expectedAmount: current.expectedAmount,
                            partiallyClaimed: options.partiallyClaimed,
                        }),
                });
                await manager.poll();
                expect(swap.claimArkTxid).toMatch(/^[0-9a-f]{64}$/);
                await waitFor(async () => {
                    const { vtxos } = await indexer.getVtxos({
                        scripts: [hex.encode(script.pkScript)],
                    });
                    return vtxos.some((coin) => coin.txid === fundingTxid && isVtxoSpent(coin));
                });
                await waitFor(async () =>
                    (await wallet.getSpendableVtxos()).some(
                        (coin) => coin.txid === swap.claimArkTxid && coin.value === LOCKUP_SATS,
                    ),
                );
                expect((await wallet.getBalance()).available).toBe(before);
                expect((await repository.getRfqSwap(swap.rfqId))?.state).toBe("claimed");
            } finally {
                await manager.stop();
            }
        },
        120_000,
    );
});
