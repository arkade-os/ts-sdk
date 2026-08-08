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
    arkInfo: { signerPubkey: "", unilateralExitDelay: 4096, network: "regtest" },
}));

vi.mock("@arkade-os/sdk", async (importOriginal) => {
    const mod = await importOriginal<typeof import("@arkade-os/sdk")>();
    return {
        ...mod,
        RestArkProvider: class {
            async getInfo() {
                return state.arkInfo;
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
    VHTLCV2ContractHandler,
    type ArkProvider,
    type ExtendedVirtualCoin,
    type IWallet,
    type IndexerProvider,
    type OnchainProvider,
} from "@arkade-os/sdk";
import {
    lightningSendVtxoScript,
    requestLightningSend,
    requestOnchainSend,
    type RfqQuote,
    type RfqTransport,
} from "../src/rfq";
import { onchainHtlcScript } from "../src/onchainHtlc";
import {
    SWAP_LOCKUP_CONTRACT_KIND,
    SWAP_LOCKUP_CONTRACT_LABEL,
    SWAP_LOCKUP_CONTRACT_TYPE,
    registerLockupContract,
} from "../src/lockupContract";

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

const SERVER = key(3);
const SOLVER = key(1);
const RECEIVER_PK_SCRIPT = p2tr(key(1));
const EMULATOR_PUBKEY = key(9);
const PAYOUT_PUBKEY = key(15);
const HTLC_PUBKEY = key(11);
const REFUND_ADDRESS = new ArkAddress(SERVER, key(21), "tark").encode();

state.arkInfo.signerPubkey = hex.encode(SERVER);

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
        const script = lightningSendVtxoScript({
            solverPubkey: SOLVER,
            refundLocktime: REFUND_LOCKTIME,
            serverPubkey: SERVER,
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
                lockup_address: script.address("tark", SERVER).encode(),
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
        const lockup = lightningSendVtxoScript({
            solverPubkey: SOLVER,
            refundLocktime: REFUND_LOCKTIME,
            serverPubkey: SERVER,
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
    requestLightningSend(wallet, "http://ark", EMULATOR_PUBKEY, lightningTransport(), {
        invoice: INVOICE,
    });

const onchainSend = (wallet: IWallet) =>
    requestOnchainSend(wallet, "http://ark", EMULATOR_PUBKEY, onchainTransport(), {
        amount: 100_000,
        amountSide: "to",
        payoutPubkey: PAYOUT_PUBKEY,
    });

describe.each([
    ["requestLightningSend", lightningSend],
    ["requestOnchainSend", onchainSend],
])("%s registers the lockup before returning an address", (_name, request) => {
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
        const secrets = result.secrets as {
            senderPrivateKey?: Uint8Array;
            preimage?: Uint8Array;
        };

        const serialized = JSON.stringify(created[0]);
        const forbidden = [
            result.rfqId,
            ...[secrets.senderPrivateKey, secrets.preimage]
                .filter((value): value is Uint8Array => value !== undefined)
                .map((value) => hex.encode(value)),
        ];
        expect(forbidden.length).toBeGreaterThan(1);
        for (const value of forbidden) expect(serialized).not.toContain(value);
    });

    it("fails the request rather than handing back an address it never registered", async () => {
        const { wallet } = recordingWallet(() => {
            throw new Error("repository unavailable");
        });
        await expect(request(wallet)).rejects.toThrow("repository unavailable");
    });
});

// ── What the registration buys, against a real contract manager ──────────────

const arkInfo = () => ({
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
        arkServerUrl: "http://localhost:7070",
        arkProvider: { getInfo: async () => arkInfo() } as Partial<ArkProvider> as ArkProvider,
        indexerProvider: offlineIndexer(),
        onchainProvider: {
            getCoins: async () => [],
            getTransactions: async () => [],
            getTxOutspends: async () => [],
        } as Partial<OnchainProvider> as OnchainProvider,
        storage: { walletRepository, contractRepository },
        identity: ReadonlySingleKey.fromPublicKey(
            hex.decode("02" + hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(42)))),
        ),
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

    it("survives the manager's backstop re-registering it", async () => {
        // `ensureRegistered` still runs for records that predate pre-funding
        // registration, and must be a no-op for those that do not.
        const { wallet, contractRepository } = await realWallet();
        const swap = await lightningSend(wallet as unknown as IWallet);
        const script = lightningSendVtxoScript({
            solverPubkey: SOLVER,
            refundLocktime: REFUND_LOCKTIME,
            serverPubkey: SERVER,
            paymentHash: PAYMENT_HASH,
            claimDelay: 4096,
            emulatorPubkey: EMULATOR_PUBKEY,
            senderPubkey: swap.senderPubkey,
            receiverPkScript: RECEIVER_PK_SCRIPT,
            refundPkScript: ArkAddress.decode(swap.refundAddress).pkScript,
        });
        expect(hex.encode(script.pkScript)).toBe(hex.encode(swap.swapPkScript));

        const before = await contractRepository.getContracts();
        await registerLockupContract(await wallet.getContractManager(), script, swap.address);
        expect(await contractRepository.getContracts()).toEqual(before);
    });
});
