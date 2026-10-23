/**
 * The arkade-faucet-daemon failure on regtest: while a collaborative exit waits for its batch
 * swap, a second exit, an Arkade send and a Lightning swap funding all fail coin selection or
 * queue behind it. With `concurrentSpending` they each take one free VTXO and go through.
 */
import { describe, expect, it } from "vitest";
import { execSync } from "child_process";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
    ArkAddress,
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    Ramps,
    REGTEST_EMULATOR_PUBKEY,
    RestArkProvider,
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
import { createSwapClient, InMemoryAssetSwapRepository } from "../../src";
import type { AttestingRfqTransport } from "../../src/client/transport";
import { encodeInvoice } from "../helpers/bolt11";

// Defaults are CI's stack; the overrides let it run against a namespaced one.
const OPERATOR_URL = process.env.ARK_SERVER_URL ?? "http://localhost:7070";
const ESPLORA_API_URL = process.env.ESPLORA_URL ?? "http://localhost:3000/api";
const arkdExec = `docker exec -t ${process.env.REGTEST_CONTAINER_PREFIX ?? ""}arkd`;
const BTC_ADDR = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
const COIN_SATS = 30_000;
const LOCKUP_SATS = 1_000;

const xOnly = (key: Uint8Array): Uint8Array => (key.length === 32 ? key : key.slice(1));
const NOW = () => Math.floor(Date.now() / 1000);

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

const waitFor = async (fn: () => Promise<boolean>, timeout = 60_000): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("timeout in waitFor");
};

const SOLVER = schnorr.getPublicKey(new Uint8Array(32).fill(7));
const RECEIVER_PK_SCRIPT = Uint8Array.from([0x51, 0x20, ...SOLVER]);
const PAYMENT_HASH = hex.encode(sha256(new Uint8Array(32).fill(11)));
const DISCOVERY_KEY = hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(4)));

const CARD = {
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

const invoice = (): string =>
    encodeInvoice({
        prefix: "lnbcrt",
        amount: "10u",
        timestamp: NOW() - 60,
        expiry: 7_200,
        paymentHash: PAYMENT_HASH,
    });

/** A solver that quotes back the maker's own derivation (see rfqDrive.test.ts). */
const stubTransport = async (wallet: Wallet): Promise<AttestingRfqTransport> => {
    const info = await wallet.getArkadeInfo();
    const operatorPubkey = xOnly(hex.decode(info.signerPubkey));
    const claimDelay = unilateralClaimDelay(Number(info.unilateralExitDelay));
    const hrp = ArkAddress.decode(await wallet.getAddress()).hrp;
    const emulatorPubkey = xOnly(hex.decode(REGTEST_EMULATOR_PUBKEY));
    return {
        attestedResponder: DISCOVERY_KEY,
        async requestQuote(payload) {
            const profile = (payload as { profile: Record<string, unknown> }).profile;
            const refundLocktime = NOW() + 200 * 3600;
            const refundWithoutReceiverDelay = Math.ceil((refundLocktime - NOW()) / 512) * 512;
            const contract = lightningSendContract({
                solverPubkey: SOLVER,
                refundLocktime,
                refundWithoutReceiverDelay,
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
                    refund_without_receiver_delay: refundWithoutReceiverDelay,
                },
            } satisfies RfqQuote;
        },
        async status() {
            return null;
        },
        async close() {},
    };
};

/** Four 30,000-sat VTXOs from four separate Arkade transactions. */
const fourCoinWallet = async (concurrentSpending: boolean) => {
    const wallet = await Wallet.create({
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
        concurrentSpending,
    });
    const note = execCommand(`${arkdExec} arkd note --amount ${4 * COIN_SATS + 10_000}`);
    execCommand(`${arkdExec} ark redeem-notes -n ${note} --password secret`);
    const address = await wallet.getAddress();
    for (let i = 0; i < 4; i++) {
        execCommand(`${arkdExec} ark send --to ${address} --amount ${COIN_SATS} --password secret`);
    }
    await waitFor(async () => (await wallet.getVtxos()).length === 4);
    const transport = await stubTransport(wallet);
    const client = createSwapClient({
        wallet,
        repository: new InMemoryAssetSwapRepository(),
        discovery: { snapshot: [CARD] },
        transportFor: () => transport,
    });
    const { fees } = await wallet.getArkadeInfo();
    const exit = (amount: bigint) =>
        new Ramps(wallet).offboardExact({ destinationAddress: BTC_ADDR, feeInfo: fees, amount });
    return { wallet, client, exit, address };
};

describe("an exit waiting for its batch swap (regtest)", () => {
    it("with concurrentSpending, a second exit, a send and a Lightning swap funding all succeed", async () => {
        const { wallet, client, exit, address } = await fourCoinWallet(true);

        let firstExitDone = false;
        const firstExit = exit(20_000n).finally(() => (firstExitDone = true));
        await waitFor(async () => (await wallet.getVtxos()).length === 3);

        const quote = await client.quote({ to: invoice() });
        const secondExit = exit(10_000n);
        const [sent, swap] = await Promise.all([
            wallet.send({ address, amount: 1_000 }),
            client.accept(quote),
        ]);

        expect(firstExitDone).toBe(false);
        expect(sent).toEqual(expect.any(String));
        expect(swap.fundingTxid).toEqual(expect.any(String));
        await expect(Promise.all([firstExit, secondExit])).resolves.toEqual([
            expect.any(String),
            expect.any(String),
        ]);
        await client[Symbol.asyncDispose]();
        await wallet.dispose();
    }, 240_000);

    it("without it, the same sequence fails the way the faucet saw", async () => {
        const { wallet, client, exit, address } = await fourCoinWallet(false);

        let firstExitDone = false;
        const firstExit = exit(20_000n).finally(() => (firstExitDone = true));
        await waitFor(async () => (await wallet.getVtxos()).length === 0);

        const quote = await client.quote({ to: invoice() });
        await expect(exit(10_000n)).rejects.toThrow("No vtxos available after deducting fees");
        await expect(client.accept(quote)).rejects.toMatchObject({ name: "InsufficientFunds" });
        // Whether it then finds the exit's change depends on indexer timing; only the wait is pinned.
        const settledAfterExit = wallet.send({ address, amount: 1_000 }).then(
            () => firstExitDone,
            () => firstExitDone,
        );
        await expect(settledAfterExit).resolves.toBe(true);
        await firstExit;
        await client[Symbol.asyncDispose]();
        await wallet.dispose();
    }, 240_000);
});
