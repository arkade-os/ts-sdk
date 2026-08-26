/**
 * The lockup is a registered contract before the caller can fund it.
 *
 * `register.test.ts` proves the same property for the offer corridor; this is
 * the RFQ half. Both entrypoints register where the address is minted and
 * throw on failure, so a persistence problem happens while nothing is at
 * stake — `RfqSwapManager.ensureRegistered` remains the backstop for records
 * written before that, not the primary site.
 *
 * The second half runs a REAL `ContractManager` over in-memory repositories,
 * because the point of registering is what the wallet then does with the row:
 * the lockup has to be visible as owned and invisible to generic selection.
 */
import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";

const state = vi.hoisted(() => ({
    operatorInfo: { signerPubkey: "", unilateralExitDelay: 4096, network: "regtest" },
}));

vi.mock("@arkade-os/sdk", async (importOriginal) => {
    const mod = await importOriginal<typeof import("@arkade-os/sdk")>();
    return {
        ...mod,
        RestArkProvider: class {
            async getInfo() {
                return state.operatorInfo;
            }
        },
    };
});

import {
    ArkAddress,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    ProviderUnavailableError,
    ReadonlySingleKey,
    ReadonlyWallet,
    SingleKey,
    VHTLCV2ContractHandler,
    type ArkProvider,
    type ExtendedVirtualCoin,
    type IWallet,
    type IndexerProvider,
    type OnchainProvider,
} from "@arkade-os/sdk";
import {
    lightningSendContract,
    requestLightningSend,
    requestOnchainSend,
    type RfqQuote,
    type RfqTransport,
} from "../src/rfq";
import { onchainHtlcScript } from "../src/onchainHtlc";
import {
    LockupContractMissing,
    LockupRegistrationFailed,
    SWAP_LOCKUP_CONTRACT_KIND,
    SWAP_LOCKUP_CONTRACT_LABEL,
    SWAP_LOCKUP_CONTRACT_TYPE,
    lockupContractParams,
    registerLockupContract,
} from "../src/lockupContract";
import { createRfqSwapRecord, rebuildRfqSwap } from "../src/rfqRecord";
import { rfqSecretsProfile } from "../src/rfqProfileParts";

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

const SERVER = key(3);
const SOLVER = key(1);
const RECEIVER_PK_SCRIPT = p2tr(key(1));
const EMULATOR_PUBKEY = key(9);
const EMULATOR_PUBKEY_HEX = "02" + hex.encode(EMULATOR_PUBKEY);
const PAYOUT_PUBKEY = key(15);
const HTLC_PUBKEY = key(11);
const REFUND_ADDRESS = new ArkAddress(SERVER, key(21), "tark").encode();

state.operatorInfo.signerPubkey = hex.encode(SERVER);

const NOW = Math.floor(Date.now() / 1000);
const VALID_UNTIL = NOW + 3600;
const REFUND_LOCKTIME = NOW + 60 * 24 * 3600;
const HTLC_LOCKTIME = NOW + 30 * 24 * 3600;

const PAYMENT_HASH = "ab".repeat(32);
const INVOICE = {
    raw: "lnbcrt10u1p",
    paymentHash: PAYMENT_HASH,
    amountSats: 1000,
    expiresAt: NOW + 7200,
};

/** Quotes back whatever the maker derived, so the flow reaches registration. */
const lightningTransport = (): RfqTransport => ({
    async requestQuote(payload) {
        const profile = (payload as { profile: Record<string, unknown> }).profile;
        const contract = lightningSendContract({
            solverPubkey: SOLVER,
            refundLocktime: REFUND_LOCKTIME,
            operatorPubkey: SERVER,
            paymentHash: PAYMENT_HASH,
            claimDelay: 4096,
            emulatorPubkey: EMULATOR_PUBKEY,
            senderPubkey: hex.decode(profile.client_refund_pubkey as string),
            receiverPkScript: RECEIVER_PK_SCRIPT,
            refundPkScript: ArkAddress.decode(profile.refund_address as string).pkScript,
        });
        return {
            v: 1,
            type: "rfq_quote",
            rfq_id: payload.rfq_id as string,
            pair: "arkade:BTC->lightning:BTC",
            from_amount: 1000,
            to_amount: 1000,
            solver_pubkey: hex.encode(SOLVER),
            valid_until: VALID_UNTIL,
            refund_locktime: REFUND_LOCKTIME,
            profile: {
                receiver_pk_script: hex.encode(RECEIVER_PK_SCRIPT),
                lockup_address: contract.address("tark", SERVER).encode(),
            },
        } satisfies RfqQuote;
    },
    async status() {
        return null;
    },
    async close() {},
});

const onchainTransport = (): RfqTransport => ({
    async requestQuote(payload) {
        const profile = (payload as { profile: Record<string, unknown> }).profile;
        const paymentHash = profile.payment_hash as string;
        const lockup = lightningSendContract({
            solverPubkey: SOLVER,
            refundLocktime: REFUND_LOCKTIME,
            operatorPubkey: SERVER,
            paymentHash,
            claimDelay: 4096,
            emulatorPubkey: EMULATOR_PUBKEY,
            senderPubkey: hex.decode(profile.client_refund_pubkey as string),
            receiverPkScript: RECEIVER_PK_SCRIPT,
            refundPkScript: ArkAddress.decode(profile.refund_address as string).pkScript,
        });
        const htlc = onchainHtlcScript(
            {
                paymentHash,
                claimKey: PAYOUT_PUBKEY,
                refundKey: HTLC_PUBKEY,
                refundLocktime: HTLC_LOCKTIME,
            },
            "regtest",
        );
        return {
            v: 1,
            type: "rfq_quote",
            rfq_id: payload.rfq_id as string,
            pair: "arkade:BTC->onchain:BTC",
            from_amount: 100_000,
            to_amount: 99_000,
            solver_pubkey: hex.encode(SOLVER),
            valid_until: VALID_UNTIL,
            refund_locktime: REFUND_LOCKTIME,
            profile: {
                lockup_address: lockup.address("tark", SERVER).encode(),
                htlc_pubkey: hex.encode(HTLC_PUBKEY),
                htlc_locktime: HTLC_LOCKTIME,
                htlc_address: htlc.address,
                min_confirmations: 2,
                receiver_pk_script: hex.encode(RECEIVER_PK_SCRIPT),
            },
        } satisfies RfqQuote;
    },
    async status() {
        return null;
    },
    async close() {},
});

/** A wallet with nothing but what these entrypoints use, plus a recording
 * contract manager — so an entrypoint that skipped registration fails here. */
const recordingWallet = (
    createContract?: (params: Record<string, unknown>) => unknown,
): { wallet: IWallet; created: Record<string, unknown>[] } => {
    const created: Record<string, unknown>[] = [];
    const wallet = {
        // The sender key comes from the wallet now — a fixture without an
        // identity is not a wallet these entrypoints can serve.
        identity: SingleKey.fromRandomBytes(),
        getAddress: async () => REFUND_ADDRESS,
        getContractManager: async () => ({
            createContract: async (params: Record<string, unknown>) => {
                if (createContract) return createContract(params);
                created.push(params);
                return { ...params, state: "active", createdAt: 0 };
            },
        }),
    } as unknown as IWallet;
    return { wallet, created };
};

const lightningSend = (wallet: IWallet) =>
    requestLightningSend(wallet, "http://ark", lightningTransport(), {
        emulatorPubkey: EMULATOR_PUBKEY_HEX,
        invoice: INVOICE,
    });

const onchainSend = (wallet: IWallet) =>
    requestOnchainSend(wallet, "http://ark", onchainTransport(), {
        emulatorPubkey: EMULATOR_PUBKEY_HEX,
        amount: 100_000,
        amountSide: "to",
        payoutPubkey: PAYOUT_PUBKEY,
    });

describe.each([
    // `hasPreimage` pins which corridor owns P: a lightning send's belongs to
    // the payee, an onchain send mints its own. Asserted rather than inferred,
    // so a corridor that stopped carrying one cannot quietly narrow the
    // secret-leak check below to the rfqId.
    ["requestLightningSend", lightningSend, false],
    ["requestOnchainSend", onchainSend, true],
])("%s registers the lockup before returning an address", (_name, request, hasPreimage) => {
    it("writes the row the funded script is keyed by", async () => {
        const { wallet, created } = recordingWallet();
        const result = await request(wallet);

        expect(created).toHaveLength(1);
        const row = created[0];
        expect(row.type).toBe(SWAP_LOCKUP_CONTRACT_TYPE);
        expect(row.script).toBe(hex.encode(result.swapPkScript));
        expect(row.address).toBe(result.address);
        expect(row.label).toBe(SWAP_LOCKUP_CONTRACT_LABEL);
        expect(row.metadata).toEqual({
            genericallySpendable: false,
            kind: SWAP_LOCKUP_CONTRACT_KIND,
        });
        // The stored params must rebuild the very script the row is keyed by,
        // or the wallet cannot derive a spending path for what it is watching.
        const rebuilt = VHTLCV2ContractHandler.createScript(row.params as Record<string, string>);
        expect(hex.encode(rebuilt.pkScript)).toBe(row.script);
    });

    it("carries no per-swap identity and no secrets", async () => {
        // Rows are keyed by script and first-writer-wins, so anything per-swap
        // written here describes the first swap forever after. The covenant's
        // own binding fields — the sender PUBLIC key among them — are
        // script-level facts and belong in `params`; nothing else does.
        const { wallet, created } = recordingWallet();
        const result = await request(wallet);
        // The sender key is the wallet's — no minted key exists to leak.
        const secrets = result.secrets;
        expect(secrets).not.toHaveProperty("senderPrivateKey");

        expect(secrets.preimage !== undefined).toBe(hasPreimage);

        const serialized = JSON.stringify(created[0]);
        const forbidden = [
            result.rfqId,
            ...(secrets.preimage ? [hex.encode(secrets.preimage)] : []),
        ];
        for (const value of forbidden) expect(serialized).not.toContain(value);
    });

    it("returns the covenant the row was written from", async () => {
        // Without it a polling caller cannot populate `RfqSwapManager`'s
        // `lockup`, and the manager can neither subscribe nor retire the row
        // this call just wrote.
        const { wallet } = recordingWallet();
        const result = await request(wallet);
        expect(hex.encode(result.script.pkScript)).toBe(hex.encode(result.swapPkScript));
    });

    it("fails the request rather than handing back an address it never registered", async () => {
        const { wallet } = recordingWallet(() => {
            throw new Error("repository unavailable");
        });
        // Typed apart from SwapRefusal / AddressMismatch: the quote is fine and
        // the same call can be retried once the store is, which is the opposite
        // of what those two mean.
        const error = await request(wallet).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(LockupRegistrationFailed);
        expect((error as LockupRegistrationFailed).cause).toMatchObject({
            message: "repository unavailable",
        });
    });
});

// ── What the registration buys, against a real contract manager ──────────────

const operatorInfo = () => ({
    boardingExitDelay: 144n,
    checkpointTapscript:
        "5ab27520e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
    deprecatedSigners: [],
    digest: "d",
    dust: 1000n,
    fees: { intentFee: {}, txFeeRate: "0" },
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    forfeitPubkey: "02" + hex.encode(SERVER),
    network: "regtest",
    serviceStatus: {},
    sessionDuration: 3600n,
    signerPubkey: "02" + hex.encode(SERVER),
    unilateralExitDelay: 4096n,
    utxoMaxAmount: -1n,
    utxoMinAmount: 0n,
    version: "1",
    vtxoMaxAmount: -1n,
    vtxoMinAmount: 0n,
});

/** Offline: every indexer read fails retryably, so the wallet serves the
 * repository instead of syncing it away — and `createContract` still persists. */
const offlineIndexer = () =>
    ({
        getVtxos: async () => {
            throw new ProviderUnavailableError("operator down");
        },
        subscribeForScripts: async () => "sub-1",
        unsubscribeForScripts: async () => undefined,
        getSubscription: async function* () {},
    }) as Partial<IndexerProvider> as IndexerProvider;

const vtxo = (script: string, value: number): ExtendedVirtualCoin =>
    ({
        txid: "cd".repeat(32),
        vout: 0,
        value,
        status: { confirmed: true },
        virtualStatus: { state: "settled" },
        createdAt: new Date(),
        isUnrolled: false,
        isSpent: false,
        script,
        forfeitTapLeafScript: [new Uint8Array(32), new Uint8Array(33)],
        intentTapLeafScript: [new Uint8Array(32), new Uint8Array(34)],
        tapTree: new Uint8Array(64),
    }) as unknown as ExtendedVirtualCoin;

const realWallet = async () => {
    const walletRepository = new InMemoryWalletRepository();
    const contractRepository = new InMemoryContractRepository();
    const wallet = await ReadonlyWallet.create({
        operatorUrl: "http://localhost:7070",
        arkProvider: { getInfo: async () => operatorInfo() } as Partial<ArkProvider> as ArkProvider,
        indexerProvider: offlineIndexer(),
        onchainProvider: {
            getCoins: async () => [],
            getTransactions: async () => [],
            getTxOutspends: async () => [],
        } as Partial<OnchainProvider> as OnchainProvider,
        storage: { walletRepository, contractRepository },
        // A signing identity even though the wallet is readonly: these tests
        // are about the contract row, and provisioning now refuses a wallet
        // that cannot sign, since it could never refund the leg it funds.
        identity: SingleKey.fromPrivateKey(new Uint8Array(32).fill(42)),
    });
    return { wallet, walletRepository, contractRepository };
};

describe("a registered lockup, against a real contract manager", () => {
    it("is owned but never generically spendable", async () => {
        const { wallet, walletRepository, contractRepository } = await realWallet();
        const swap = await lightningSend(wallet as unknown as IWallet);

        const rows = await contractRepository.getContracts();
        const row = rows.find((c) => c.script === hex.encode(swap.swapPkScript));
        expect(row?.type).toBe(SWAP_LOCKUP_CONTRACT_TYPE);

        // Fund it, in the only sense a repository-backed test can.
        await walletRepository.saveVtxos(swap.address, [
            vtxo(hex.encode(swap.swapPkScript), 25_000),
        ]);

        const scripts = (await wallet.getVtxos()).map((v) => v.script);
        expect(scripts).toContain(hex.encode(swap.swapPkScript));
        const spendable = (await wallet.getSpendableVtxos()).map((v) => v.script);
        expect(spendable).not.toContain(hex.encode(swap.swapPkScript));

        // The escrowed sats are the maker's — they are just not available to
        // send, settle or renew, which is what keeps a live swap from being
        // spent out from under itself.
        const balance = await wallet.getBalance();
        expect(balance.total).toBe(25_000);
        expect(balance.available).toBe(0);
    });

    it("hands its params back to a rebuild, which is why a record stores no tree", async () => {
        // The loop the persistence layer rests on, end to end and through a
        // real repository: the entrypoint writes the row, the row round-trips
        // storage, and a record carrying no covenant of its own rebuilds the
        // very script that was funded.
        const { wallet } = await realWallet();
        const swap = await lightningSend(wallet as unknown as IWallet);

        const params = await lockupContractParams(await wallet.getContractManager(), swap.address);
        const record = createRfqSwapRecord(
            {
                kind: "lightning_send",
                lockupAddress: swap.address,
                profile: rfqSecretsProfile(swap.secrets, swap.contractParams.paymentHash),
            },
            {
                kind: "lightning_send",
                rfqId: swap.rfqId,
                state: "pending",
                lockupPkScript: swap.swapPkScript,
                paymentHash: swap.contractParams.paymentHash,
                refundLocktime: swap.contractParams.refundLocktime,
                createdAt: 1,
                updatedAt: 1,
            },
        );

        const rebuilt = rebuildRfqSwap(record, params);
        expect(hex.encode(rebuilt.lockupPkScript)).toBe(hex.encode(swap.swapPkScript));
        expect(rebuilt.refundLocktime).toBe(swap.contractParams.refundLocktime);
    });

    it("names a lockup with no row instead of rebuilding from nothing", async () => {
        // A cleared contract store, or a record from another wallet: the money
        // may well be at the address, but this wallet has no covenant for it.
        const { wallet } = await realWallet();
        await expect(
            lockupContractParams(await wallet.getContractManager(), REFUND_ADDRESS),
        ).rejects.toBeInstanceOf(LockupContractMissing);
    });

    it("survives the manager's backstop re-registering it", async () => {
        // `ensureRegistered` still runs for records that predate pre-funding
        // registration, and must be a no-op for those that do not.
        const { wallet, contractRepository } = await realWallet();
        const swap = await lightningSend(wallet as unknown as IWallet);

        const before = await contractRepository.getContracts();
        // `swap.script` is what a caller hands the manager as `lockup.script`.
        await registerLockupContract(await wallet.getContractManager(), swap.script, swap.address);
        expect(await contractRepository.getContracts()).toEqual(before);
    });
});
